const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readTopLevel, removeTopLevel, replaceTable, stableId, upsertTopLevel
} = require('../src/services/util');

test('TOML edits preserve unrelated plugin and MCP sections', () => {
  let config = 'model_provider = "old"\nservice_tier = "fast"\n\n[mcp_servers.demo]\ncommand = "demo"\n';
  config = upsertTopLevel(config, 'model_provider', '"custom"');
  config = removeTopLevel(config, 'base_url');
  config = replaceTable(config, 'model_providers.custom', [
    '[model_providers.custom]', 'name = "route"', 'wire_api = "responses"'
  ]);
  assert.equal(readTopLevel(config, 'model_provider'), 'custom');
  assert.match(config, /\[mcp_servers\.demo\][\s\S]*command = "demo"/);
  assert.match(config, /\[model_providers\.custom\][\s\S]*wire_api = "responses"/);
});

test('stable profile IDs are deterministic and source scoped', () => {
  assert.equal(stableId('account', 'GPT-PLUS-1'), stableId('account', 'gpt-plus-1'));
  assert.notEqual(stableId('account', 'GPT-PLUS-1'), stableId('cc-switch', 'GPT-PLUS-1'));
});
