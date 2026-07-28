const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function atomicWrite(file, data) {
  ensureDir(path.dirname(file));
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.codexlink-${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, data);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    if (process.platform === 'win32' && fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      fs.renameSync(temp, file);
    } else {
      throw error;
    }
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableId(source, value) {
  return `profile-${sha256(`${source}|${String(value || '').trim()}`.toLowerCase()).slice(0, 24)}`;
}

function normalizeBase(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('服务地址必须是 HTTP 或 HTTPS。');
  return url.toString().replace(/\/+$/, '');
}

function publicMessage(value) {
  return String(value || '操作失败。')
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, '[已隐藏令牌]')
    .replace(/(?:\/Users\/|[A-Za-z]:\\Users\\)[^\s"'<>]+/g, '[已隐藏路径]')
    .replace(/https?:\/\/[^\s"'<>]+/g, '[已隐藏地址]')
    .slice(0, 280);
}

function escapeToml(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function lines(value) {
  return String(value || '').replace(/\r\n?/g, '\n').split('\n');
}

function isTable(line) {
  return /^\s*\[[^\]]+\]/.test(line || '');
}

function upsertTopLevel(config, key, rawValue) {
  const result = [];
  let inserted = false;
  let inTable = false;
  for (const line of lines(config)) {
    if (isTable(line)) {
      if (!inserted) {
        result.push(`${key} = ${rawValue}`);
        inserted = true;
      }
      inTable = true;
    }
    if (!inTable && new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`).test(line)) {
      if (!inserted) {
        result.push(`${key} = ${rawValue}`);
        inserted = true;
      }
      continue;
    }
    result.push(line);
  }
  if (!inserted) result.unshift(`${key} = ${rawValue}`);
  return `${result.join('\n').replace(/\n+$/, '')}\n`;
}

function removeTopLevel(config, key) {
  const matcher = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  const result = [];
  let inTable = false;
  for (const line of lines(config)) {
    if (isTable(line)) inTable = true;
    if (!inTable && matcher.test(line)) continue;
    result.push(line);
  }
  return `${result.join('\n').replace(/\n+$/, '')}\n`;
}

function readTopLevel(config, key) {
  const matcher = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*["']([^"']*)["']`);
  for (const line of lines(config)) {
    if (isTable(line)) break;
    const match = line.match(matcher);
    if (match) return match[1].trim();
  }
  return '';
}

function replaceTable(config, table, replacement = []) {
  const result = [];
  let skipping = false;
  for (const line of lines(config)) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (match) {
      if (match[1].trim() === table) {
        skipping = true;
        continue;
      }
      if (skipping) skipping = false;
    }
    if (!skipping) result.push(line);
  }
  while (result.length && !result[result.length - 1].trim()) result.pop();
  if (replacement.length) {
    if (result.length) result.push('');
    result.push(...replacement);
  }
  return `${result.join('\n')}\n`;
}

module.exports = {
  atomicWrite, ensureDir, escapeToml, normalizeBase, publicMessage, readJson,
  readTopLevel, removeTopLevel, replaceTable, sha256, stableId, upsertTopLevel
};
