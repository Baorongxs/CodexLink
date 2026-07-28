const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { atomicWrite, ensureDir, sha256 } = require('./util');

const ALLOWED_FILES = ['state_5.sqlite', '.codex-global-state.json', 'session_index.jsonl'];
const ALLOWED_DIRS = ['sessions', 'archived_sessions'];

class ConversationService {
  constructor({ codexHome }) {
    this.codexHome = codexHome;
    this.backupRoot = path.join(codexHome, 'backups', 'codexlink-conversations');
  }

  listSourceFiles() {
    const files = [];
    for (const name of ALLOWED_FILES) {
      const file = path.join(this.codexHome, name);
      if (isRegularFile(file)) files.push({ file, relative: name });
    }
    for (const dir of ALLOWED_DIRS) {
      const root = path.join(this.codexHome, dir);
      if (!fs.existsSync(root)) continue;
      walkRegularFiles(root, root, (file, relative) => files.push({ file, relative: `${dir}/${relative.replace(/\\/g, '/')}` }));
    }
    return files;
  }

  createBackup({ prefix = 'codexlink-conversations', progress = () => {} } = {}) {
    ensureDir(this.backupRoot);
    const sources = this.listSourceFiles();
    if (!sources.length) throw new Error('没有找到可备份的 Codex 对话数据。');
    progress(15, '正在扫描本地对话…');
    const zip = new AdmZip();
    const manifest = {
      formatVersion: 1, excludesAuth: true, platform: 'darwin',
      createdAtUtc: new Date().toISOString(), files: []
    };
    sources.forEach((item, index) => {
      const bytes = fs.readFileSync(item.file);
      zip.addFile(item.relative, bytes);
      manifest.files.push({ path: item.relative, length: bytes.length, sha256: sha256(bytes) });
      progress(15 + Math.round(((index + 1) / sources.length) * 65), item.relative);
    });
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const output = path.join(this.backupRoot, `${prefix}-${stamp}-${crypto.randomUUID().slice(0, 8)}.zip`);
    zip.writeZip(output);
    progress(100, path.basename(output));
    return { path: output, fileCount: sources.length, size: fs.statSync(output).size };
  }

  getBackups() {
    ensureDir(this.backupRoot);
    return fs.readdirSync(this.backupRoot)
      .filter((name) => /^codexlink-conversations-\d{8}T\d{6}Z-[a-f0-9-]+\.zip$/i.test(name))
      .map((name) => path.join(this.backupRoot, name))
      .filter(isRegularFile)
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  }

  async restoreLatest({ progress = () => {} } = {}) {
    const backup = this.getBackups()[0];
    if (!backup) throw new Error('没有找到可恢复的对话备份。');
    progress(5, '正在验证备份…');
    const parsed = validateBackup(backup);
    const safety = this.listSourceFiles().length
      ? this.createBackup({ prefix: 'codexlink-safety-before-restore', progress: () => {} }).path
      : '';
    let restored = 0;
    let skipped = 0;
    for (let index = 0; index < parsed.manifest.files.length; index += 1) {
      const item = parsed.manifest.files[index];
      const entry = parsed.zip.getEntry(item.path);
      const target = safeTarget(this.codexHome, item.path);
      ensureDir(path.dirname(target));
      if (item.path === 'state_5.sqlite' && fs.existsSync(target)) {
        restored += await mergeStateDatabase(target, entry.getData());
      } else if (!fs.existsSync(target)) {
        atomicWrite(target, entry.getData());
        restored += 1;
      } else if (['.codex-global-state.json', 'session_index.jsonl'].includes(item.path)) {
        restored += mergeTextMetadata(target, entry.getData(), item.path);
      } else {
        skipped += 1;
      }
      progress(10 + Math.round(((index + 1) / parsed.manifest.files.length) * 85), item.path);
    }
    progress(100, '恢复完成');
    return { backup, safetyBackup: safety, restored, skipped };
  }

  async repairSidebar() {
    const database = path.join(this.codexHome, 'state_5.sqlite');
    if (!fs.existsSync(database)) throw new Error('未找到 Codex 对话数据库。');
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) });
    const db = new SQL.Database(fs.readFileSync(database));
    let changed = 0;
    try {
      const table = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'");
      if (!table.length) throw new Error('当前 Codex 数据库缺少 threads 表。');
      const columns = db.exec('PRAGMA table_info(threads)')[0]?.values.map((row) => row[1]) || [];
      const archived = columns.find((item) => ['archived', 'is_archived'].includes(String(item).toLowerCase()));
      if (archived) {
        db.run(`UPDATE threads SET "${archived.replace(/"/g, '""')}"=0 WHERE "${archived.replace(/"/g, '""')}" IS NOT 0`);
        changed = db.getRowsModified();
        atomicWrite(database, Buffer.from(db.export()));
      }
    } finally { db.close(); }
    return { changed };
  }

  readContext(threadId) {
    const normalized = String(threadId || '').toLowerCase().replace(/[^a-f0-9-]/g, '');
    if (!normalized) return { ok: false, error: 'thread_missing' };
    for (const rootName of ALLOWED_DIRS) {
      const root = path.join(this.codexHome, rootName);
      if (!fs.existsSync(root)) continue;
      let found = null;
      walkRegularFiles(root, root, (file) => {
        if (!found && path.basename(file).toLowerCase().includes(normalized)) found = file;
      });
      if (!found) continue;
      const rows = fs.readFileSync(found, 'utf8').split(/\r?\n/).reverse();
      for (const line of rows) {
        try {
          const data = JSON.parse(line);
          const usage = data?.payload?.token_usage || data?.token_usage || data?.usage;
          if (!usage) continue;
          const used = Number(usage.total_tokens ?? usage.total ?? 0);
          const max = Number(usage.model_context_window ?? usage.context_window ?? 0);
          return { ok: true, threadId, used, max, remaining: Math.max(0, max - used), percent: max > 0 ? used * 100 / max : 0 };
        } catch (_) {}
      }
    }
    return { ok: false, error: 'context_not_found' };
  }

  deleteThread(threadId) {
    const normalized = String(threadId || '').toLowerCase().replace(/[^a-f0-9-]/g, '');
    if (!normalized) return { ok: false, error: 'thread_missing' };
    let removed = 0;
    for (const rootName of ALLOWED_DIRS) {
      const root = path.join(this.codexHome, rootName);
      if (!fs.existsSync(root)) continue;
      walkRegularFiles(root, root, (file) => {
        if (path.basename(file).toLowerCase().includes(normalized)) {
          fs.rmSync(file, { force: true });
          removed += 1;
        }
      });
    }
    const index = path.join(this.codexHome, 'session_index.jsonl');
    if (fs.existsSync(index)) {
      const before = fs.readFileSync(index, 'utf8').split(/\r?\n/);
      const after = before.filter((line) => !line.toLowerCase().includes(normalized));
      if (after.length !== before.length) {
        atomicWrite(index, `${after.filter(Boolean).join('\n')}\n`);
        removed += before.length - after.length;
      }
    }
    return { ok: removed > 0, removed };
  }
}

function validateBackup(file) {
  const zip = new AdmZip(file);
  const entry = zip.getEntry('manifest.json');
  if (!entry) throw new Error('备份缺少 manifest.json。');
  const manifest = JSON.parse(entry.getData().toString('utf8'));
  if (manifest.formatVersion !== 1 || manifest.excludesAuth !== true || !Array.isArray(manifest.files)) {
    throw new Error('备份格式无效。');
  }
  for (const item of manifest.files) {
    if (!isAllowedRelative(item.path)) throw new Error('备份包含不允许的路径。');
    const payload = zip.getEntry(item.path);
    if (!payload) throw new Error(`备份缺少文件：${item.path}`);
    const bytes = payload.getData();
    if (bytes.length !== item.length || sha256(bytes) !== item.sha256) throw new Error(`备份校验失败：${item.path}`);
  }
  return { zip, manifest };
}

async function mergeStateDatabase(livePath, backupBytes) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) });
  const live = new SQL.Database(fs.readFileSync(livePath));
  const backup = new SQL.Database(backupBytes);
  let changed = 0;
  try {
    const liveTables = new Set((live.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values || []).map((row) => row[0]));
    const backupTables = (backup.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values || []).map((row) => row[0]);
    for (const table of backupTables.filter((name) => liveTables.has(name) && !String(name).startsWith('sqlite_'))) {
      const quoted = `"${String(table).replace(/"/g, '""')}"`;
      const liveColumns = (live.exec(`PRAGMA table_info(${quoted})`)[0]?.values || []).map((row) => row[1]);
      const backupColumns = new Set((backup.exec(`PRAGMA table_info(${quoted})`)[0]?.values || []).map((row) => row[1]));
      const columns = liveColumns.filter((column) => backupColumns.has(column));
      if (!columns.length) continue;
      const select = backup.exec(`SELECT ${columns.map((column) => `"${String(column).replace(/"/g, '""')}"`).join(',')} FROM ${quoted}`)[0];
      if (!select) continue;
      const placeholders = columns.map(() => '?').join(',');
      const insert = live.prepare(`INSERT OR IGNORE INTO ${quoted} (${columns.map((column) => `"${String(column).replace(/"/g, '""')}"`).join(',')}) VALUES (${placeholders})`);
      try {
        for (const row of select.values) {
          insert.run(row);
          changed += live.getRowsModified();
        }
      } finally { insert.free(); }
    }
    if (changed) atomicWrite(livePath, Buffer.from(live.export()));
  } finally {
    live.close();
    backup.close();
  }
  return changed;
}

function mergeTextMetadata(target, backupBytes, name) {
  const backup = backupBytes.toString('utf8');
  const live = fs.readFileSync(target, 'utf8');
  if (name === 'session_index.jsonl') {
    const existing = new Set(live.split(/\r?\n/).filter(Boolean));
    const additions = backup.split(/\r?\n/).filter((line) => line && !existing.has(line));
    if (additions.length) atomicWrite(target, `${live.replace(/\s*$/, '\n')}${additions.join('\n')}\n`);
    return additions.length;
  }
  try {
    const liveJson = JSON.parse(live);
    const backupJson = JSON.parse(backup);
    let changed = 0;
    for (const [key, value] of Object.entries(backupJson)) {
      if (!(key in liveJson)) {
        liveJson[key] = value;
        changed += 1;
      } else if (isPlainObject(value) && isPlainObject(liveJson[key])) {
        for (const [nested, nestedValue] of Object.entries(value)) {
          if (!(nested in liveJson[key])) {
            liveJson[key][nested] = nestedValue;
            changed += 1;
          }
        }
      }
    }
    if (changed) atomicWrite(target, `${JSON.stringify(liveJson)}\n`);
    return changed;
  } catch (_) { return 0; }
}

function walkRegularFiles(root, current, callback) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walkRegularFiles(root, file, callback);
    else if (stat.isFile()) callback(file, path.relative(root, file));
  }
}

function isRegularFile(file) {
  try { return fs.lstatSync(file).isFile(); } catch (_) { return false; }
}

function isAllowedRelative(relative) {
  const normalized = String(relative || '').replace(/\\/g, '/');
  return ALLOWED_FILES.includes(normalized) || ALLOWED_DIRS.some((dir) => normalized.startsWith(`${dir}/`));
}

function safeTarget(root, relative) {
  if (!isAllowedRelative(relative)) throw new Error('恢复路径不在允许范围内。');
  const target = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(prefix)) throw new Error('恢复路径越界。');
  return target;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

module.exports = { ConversationService, validateBackup };
