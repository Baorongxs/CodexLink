const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('macOS UI keeps the complete v1.0.25 action contract', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'resources', 'launcher-ui.html'), 'utf8');
  for (const action of [
    'login', 'register', 'open-topup', 'create-topup-payment', 'import-api',
    'select-route', 'set-official-mode', 'backup-conversations',
    'restore-conversations', 'repair-conversation-sidebar', 'install-online',
    'install-offline', 'start-codex', 'restart-codex'
  ]) {
    assert.match(html, new RegExp(action));
  }
  assert.match(html, /CodexLink · macOS/);
  for (const tutorialToken of [
    '使用教程', 'usage-guide-backdrop', 'CodexLink 使用教程',
    'CodexLink 是一款简易高效的 Codex 启动工具',
    '详细使用步骤', '功能补充说明', '即可直接使用 Codex。'
  ]) {
    assert.match(html, new RegExp(tutorialToken));
  }
  assert.match(html, /if \(action === 'open-usage-guide'\) \{ openModal\('usage-guide'\); return; \}/);
});

test('main process implements the complete native action surface', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  for (const action of ['stop-inject', 'import-ccswitch-profiles', 'reset-api-profiles', 'open-codex-config']) {
    assert.match(source, new RegExp(`case '${action}'`));
  }
  assert.doesNotMatch(source, /case 'open-usage-guide'|usage-guide\.txt|CodexLink macOS 使用说明/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'resources', 'usage-guide.txt')), false);
  assert.match(source, /OFFICIAL_DOWNLOAD_URL = 'https:\/\/studio\.baorongxs\.top'/);
  assert.match(source, /getOfficialDownloadUrl\(\)/);
  assert.doesNotMatch(source, /browser_download_url|downloadUrl:\s*release\.html_url/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'resources', 'launcher-ui.html'), 'utf8'), /前往官网下载/);
});
