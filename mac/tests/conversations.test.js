const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConversationService, validateBackup } = require('../src/services/conversations');

test('conversation backup excludes credentials and validates hashes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexlink-mac-test-'));
  try {
    fs.mkdirSync(path.join(root, 'sessions', '2026'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sessions', '2026', 'thread-abc.jsonl'), '{"type":"message"}\n');
    fs.writeFileSync(path.join(root, 'session_index.jsonl'), '{"id":"abc"}\n');
    fs.writeFileSync(path.join(root, 'auth.json'), '{"OPENAI_API_KEY":"secret"}');
    fs.writeFileSync(path.join(root, 'config.toml'), 'experimental_bearer_token="secret"');
    const service = new ConversationService({ codexHome: root });
    const result = service.createBackup();
    const parsed = validateBackup(result.path);
    const names = parsed.zip.getEntries().map((entry) => entry.entryName);
    assert.ok(names.includes('sessions/2026/thread-abc.jsonl'));
    assert.ok(names.includes('session_index.jsonl'));
    assert.ok(!names.includes('auth.json'));
    assert.ok(!names.includes('config.toml'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
