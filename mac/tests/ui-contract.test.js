const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('macOS UI keeps the complete v1.0.22 action contract', () => {
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
});

test('main process implements the complete native action surface', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  for (const action of ['stop-inject', 'import-ccswitch-profiles', 'reset-api-profiles', 'open-codex-config']) {
    assert.match(source, new RegExp(`case '${action}'`));
  }
});
