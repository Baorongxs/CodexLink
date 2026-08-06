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
  const sanitized = String(value || '操作失败。')
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, '[已隐藏令牌]')
    .replace(/(?:\/Users\/|[A-Za-z]:\\Users\\)[^\s"'<>]+/g, '[已隐藏路径]')
    .replace(/https?:\/\/[^\s"'<>]+/g, '[已隐藏地址]')
    .slice(0, 280);
  const rules = [
    [/username.*password|password.*incorrect|invalid credentials|login failed/i, '用户名或密码错误。'],
    [/invalid params|invalid parameters|bad request/i, '请求参数无效，请检查填写内容。'],
    [/password login.*disabled|password authentication.*disabled/i, '当前服务已关闭密码登录。'],
    [/too many requests|rate limit|request.*frequent/i, '操作过于频繁，请稍后再试。'],
    [/unauthorized|not logged in|auth.*expired|token.*expired|session.*expired|session.*revoked/i, '登录会话已过期，请重新登录。'],
    [/user.*banned|user.*disabled|account.*disabled/i, '账号已被禁用，请联系管理员。'],
    [/timed out|timeout|operation was canceled|task was canceled/i, '请求超时，请检查网络后重试。'],
    [/sending the request|connection.*refused|name.*resolved|network.*unreachable|ssl|certificate|fetch failed/i, '无法连接服务器，请检查网络和服务地址。'],
    [/internal server error|database error|service unavailable|bad gateway|gateway timeout/i, '服务器暂时异常，请稍后重试。'],
    [/not found/i, '请求的接口不存在，请检查服务版本。']
  ];
  for (const [matcher, message] of rules) if (matcher.test(sanitized)) return message;
  return !/[\u3400-\u9fff]/.test(sanitized) && /[A-Za-z]{3,}/.test(sanitized)
    ? '操作失败，请稍后重试。'
    : sanitized;
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
