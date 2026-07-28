const fs = require('node:fs');
const path = require('node:path');
const {
  atomicWrite, ensureDir, escapeToml, normalizeBase, readTopLevel, removeTopLevel,
  replaceTable, stableId, upsertTopLevel
} = require('./util');

const DEFAULT_MODEL = 'gpt-5.6-sol';
const DEFAULT_EFFORT = 'high';
const TOKEN_TARGETS = [
  ['0丨福利-GPT（用不了就换）', '0丨福利-GPT（用不了就换）'],
  ['GPT-PLUS-1', 'A丨GPT-plus-1'], ['GPT-PLUS-2', 'A丨GPT-plus-2'],
  ['GPT-PLUS-3', 'A丨GPT-plus-3'], ['GPT-PLUS-4', 'A丨GPT-plus-4'],
  ['GPT-PRO-1', 'B丨GPT-Pro-1'], ['GPT-PRO-2', 'B丨GPT-Pro-2'],
  ['GPT-PRO-3', 'B丨GPT-Pro-3'], ['GPT-PRO-4', 'B丨GPT-Pro-4']
];

class TokenVaultService {
  constructor({ vaultPath, codexHome, ccSwitchDbPath, safeStorage }) {
    this.vaultPath = vaultPath;
    this.codexHome = codexHome;
    this.ccSwitchDbPath = ccSwitchDbPath;
    this.safeStorage = safeStorage;
    this.state = {
      schemaVersion: 2, profiles: [], currentProfileId: '', lastApiProfileId: '',
      officialMode: false, officialAuthBase64: '', migrationCompleted: false
    };
    this.load();
  }

  encrypt(value) {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('macOS 钥匙串暂不可用，无法安全保存令牌。');
    return this.safeStorage.encryptString(value).toString('base64');
  }

  decrypt(value) {
    return this.safeStorage.decryptString(Buffer.from(value, 'base64'));
  }

  load() {
    try {
      Object.assign(this.state, JSON.parse(this.decrypt(fs.readFileSync(this.vaultPath, 'utf8'))));
      if (!Array.isArray(this.state.profiles)) this.state.profiles = [];
    } catch (_) {}
  }

  save() {
    atomicWrite(this.vaultPath, this.encrypt(JSON.stringify(this.state)));
  }

  initialize() {
    let changed = this.captureOfficialAuth();
    if (!this.state.migrationCompleted) {
      const config = this.readConfig();
      const provider = readTopLevel(config, 'model_provider');
      this.state.officialMode = ['openai', 'openai-chatgpt'].includes(provider) || (!provider && Boolean(this.state.officialAuthBase64));
      this.state.migrationCompleted = true;
      changed = true;
    }
    if (changed) this.save();
    return { imported: 0, skipped: 0 };
  }

  getView() {
    this.captureOfficialAuth();
    const profiles = this.state.profiles
      .map(({ id, name, source }) => ({ id, name, source }))
      .sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name, 'zh-CN'));
    return {
      profiles, currentId: this.state.currentProfileId || '',
      officialMode: Boolean(this.state.officialMode),
      officialAvailable: Boolean(this.state.officialAuthBase64),
      ccSwitchImportAvailable: fs.existsSync(this.ccSwitchDbPath)
    };
  }

  upsertManagedProfiles(tokens, endpointUrl, replaceAll = false) {
    const endpoint = validateEndpoint(endpointUrl);
    const replacements = tokens
      .filter((token) => token?.name && token?.key)
      .map((token) => ({
        id: stableId('account', token.name), name: String(token.name).trim(), source: 'CodexLink',
        sourceId: String(token.name).trim(), endpointUrl: endpoint, model: DEFAULT_MODEL,
        reasoningEffort: DEFAULT_EFFORT, apiKey: String(token.key).trim()
      }));
    if (replacements.length !== TOKEN_TARGETS.length) throw new Error('没有拿到完整的 9 个 API 密钥，未保存令牌。');
    if (replaceAll) this.state.profiles = replacements;
    else {
      for (const item of replacements) {
        const index = this.state.profiles.findIndex((profile) => profile.id === item.id);
        if (index >= 0) this.state.profiles[index] = item;
        else this.state.profiles.push(item);
      }
    }
    const current = this.findProfile(this.state.currentProfileId) || replacements[0];
    if (!this.state.officialMode) this.state.currentProfileId = current.id;
    this.state.lastApiProfileId = current.id;
    this.save();
  }

  findProfile(id) {
    return this.state.profiles.find((profile) => profile.id === id);
  }

  selectProfile(id) {
    const profile = this.findProfile(id);
    if (!profile) throw new Error('目标令牌不存在，请重新导入。');
    this.applyApiProfile(profile);
    this.state.currentProfileId = id;
    this.state.lastApiProfileId = id;
    this.state.officialMode = false;
    this.save();
  }

  setOfficialMode(enabled) {
    if (enabled) {
      this.captureOfficialAuth();
      this.applyOfficialProfile(true);
      this.state.officialMode = true;
      this.state.currentProfileId = '';
    } else {
      const profile = this.findProfile(this.state.lastApiProfileId) || this.state.profiles[0];
      if (!profile) throw new Error('当前没有可用 API，请先导入并选择令牌。');
      this.applyApiProfile(profile);
      this.state.officialMode = false;
      this.state.currentProfileId = profile.id;
    }
    this.save();
  }

  ensureCurrentConfiguration() {
    if (this.state.officialMode) this.applyOfficialProfile(false);
    else {
      const profile = this.findProfile(this.state.currentProfileId);
      if (profile) this.applyApiProfile(profile);
    }
  }

  readConfig() {
    try { return fs.readFileSync(path.join(this.codexHome, 'config.toml'), 'utf8'); } catch (_) { return ''; }
  }

  normalizeConfig(config) {
    let value = removeTopLevel(removeTopLevel(config, 'base_url'), 'wire_api');
    if (readTopLevel(value, 'service_tier').toLowerCase() === 'default') value = removeTopLevel(value, 'service_tier');
    return value;
  }

  applyApiProfile(profile) {
    validateEndpoint(profile.endpointUrl);
    ensureDir(this.codexHome);
    const authPath = path.join(this.codexHome, 'auth.json');
    const configPath = path.join(this.codexHome, 'config.toml');
    let config = this.normalizeConfig(this.readConfig());
    config = upsertTopLevel(config, 'model_provider', '"custom"');
    config = upsertTopLevel(config, 'model', `"${escapeToml(profile.model || DEFAULT_MODEL)}"`);
    config = upsertTopLevel(config, 'model_reasoning_effort', `"${escapeToml(profile.reasoningEffort || DEFAULT_EFFORT)}"`);
    config = upsertTopLevel(config, 'disable_response_storage', 'true');
    config = replaceTable(config, 'model_providers.custom', [
      '[model_providers.custom]',
      `name = "${escapeToml(profile.name)}"`,
      `base_url = "${escapeToml(profile.endpointUrl.replace(/\/+$/, ''))}"`,
      'wire_api = "responses"',
      'requires_openai_auth = true',
      `experimental_bearer_token = "${escapeToml(profile.apiKey)}"`
    ]);
    this.applyPair(
      authPath, Buffer.from(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: profile.apiKey })),
      configPath, Buffer.from(config)
    );
  }

  applyOfficialProfile(forceLogin) {
    ensureDir(this.codexHome);
    const authPath = path.join(this.codexHome, 'auth.json');
    const configPath = path.join(this.codexHome, 'config.toml');
    let config = this.normalizeConfig(this.readConfig());
    config = upsertTopLevel(config, 'model_provider', '"openai"');
    config = removeTopLevel(config, 'experimental_bearer_token');
    config = replaceTable(config, 'model_providers.custom', []);
    let auth = null;
    if (!forceLogin) {
      try {
        const existing = fs.readFileSync(authPath);
        if (isOfficialAuth(existing)) auth = existing;
      } catch (_) {}
      if (!auth && this.state.officialAuthBase64) auth = Buffer.from(this.state.officialAuthBase64, 'base64');
    }
    this.applyPair(authPath, auth, configPath, Buffer.from(config));
  }

  applyPair(firstPath, firstBytes, secondPath, secondBytes) {
    const oldFirst = fs.existsSync(firstPath) ? fs.readFileSync(firstPath) : null;
    const oldSecond = fs.existsSync(secondPath) ? fs.readFileSync(secondPath) : null;
    try {
      if (firstBytes) atomicWrite(firstPath, firstBytes);
      else fs.rmSync(firstPath, { force: true });
      atomicWrite(secondPath, secondBytes);
    } catch (error) {
      if (oldFirst) atomicWrite(firstPath, oldFirst); else fs.rmSync(firstPath, { force: true });
      if (oldSecond) atomicWrite(secondPath, oldSecond); else fs.rmSync(secondPath, { force: true });
      throw error;
    }
  }

  captureOfficialAuth() {
    try {
      const bytes = fs.readFileSync(path.join(this.codexHome, 'auth.json'));
      if (!isOfficialAuth(bytes)) return false;
      const encoded = bytes.toString('base64');
      const changed = encoded !== this.state.officialAuthBase64;
      this.state.officialAuthBase64 = encoded;
      return changed;
    } catch (_) {
      return false;
    }
  }

  async importFromCcSwitch() {
    if (!fs.existsSync(this.ccSwitchDbPath)) return { imported: 0, skipped: 0 };
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) });
    const db = new SQL.Database(fs.readFileSync(this.ccSwitchDbPath));
    let imported = 0;
    let skipped = 0;
    try {
      const result = db.exec("SELECT id,name,settings_config,COALESCE(meta,'{}') AS meta FROM providers WHERE app_type='codex' ORDER BY sort_index,name");
      const rows = result[0] || { columns: [], values: [] };
      for (const values of rows.values) {
        const row = Object.fromEntries(rows.columns.map((column, index) => [column, values[index]]));
        try {
          const profile = parseCcSwitch(row);
          if (!profile || this.state.profiles.some((item) =>
            item.id === profile.id ||
            (sameEndpoint(item.endpointUrl, profile.endpointUrl) && (item.apiKey === profile.apiKey || item.name.toLowerCase() === profile.name.toLowerCase()))
          )) {
            skipped += 1;
            continue;
          }
          this.state.profiles.push(profile);
          imported += 1;
        } catch (_) { skipped += 1; }
      }
    } finally {
      db.close();
    }
    this.save();
    return { imported, skipped };
  }
}

async function importManagedTokens(account, vault, replaceAll = false, log = () => {}) {
  account.ensureLoggedIn();
  const endpoint = `${account.state.baseUrl.replace(/\/+$/, '')}/v1`;
  let existing = await account.listAllTokens();
  const operations = [];
  for (const [name, group] of TOKEN_TARGETS) {
    const found = existing.find((item) => item.name === name);
    const body = {
      name, expired_time: -1, remain_quota: 0, unlimited_quota: true,
      model_limits_enabled: false, model_limits: '', allow_ips: '', group,
      cross_group_retry: false
    };
    if (found) {
      body.id = Number(found.id);
      await account.request('/api/token/', { method: 'PUT', body });
      operations.push(`${name}:updated`);
    } else {
      await account.request('/api/token/', { method: 'POST', body });
      operations.push(`${name}:created`);
      existing = await account.listAllTokens();
    }
  }
  existing = await account.listAllTokens();
  const finalTokens = TOKEN_TARGETS.map(([name, group]) => {
    const item = existing.find((token) => token.name === name);
    if (!item) throw new Error(`创建后未找到令牌：${name}`);
    return { id: Number(item.id), name, group };
  });
  const keyData = await account.request('/api/token/batch/keys', {
    method: 'POST', body: { ids: finalTokens.map((item) => item.id) }
  });
  const keys = keyData.keys || keyData.value || keyData;
  for (const token of finalTokens) {
    token.key = pickKey(keys, token);
    if (!token.key || token.key === 'sk' || token.key === 'sk-') throw new Error('没有拿到完整的 9 个 API 密钥，未保存令牌。');
    if (!token.key.startsWith('sk-')) token.key = `sk-${token.key.replace(/^sk-?/i, '')}`;
  }
  vault.upsertManagedProfiles(finalTokens, endpoint, replaceAll);
  operations.forEach((item) => log(item, 'info'));
  return finalTokens;
}

function pickKey(keys, token) {
  if (Array.isArray(keys)) {
    const found = keys.find((item) => Number(item.id ?? item.token_id) === token.id || item.name === token.name);
    return String(found?.key || found?.token || '');
  }
  if (keys && typeof keys === 'object') {
    const direct = keys[token.id] ?? keys[String(token.id)] ?? keys[token.name];
    if (typeof direct === 'string') return direct;
    if (direct && typeof direct === 'object') return String(direct.key || direct.token || '');
  }
  return '';
}

function validateEndpoint(value) {
  const endpoint = normalizeBase(value);
  const url = new URL(endpoint);
  if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('API 请求地址无效或需要本地路由。');
  return endpoint;
}

function isOfficialAuth(bytes) {
  try {
    const auth = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return String(auth.auth_mode || '').toLowerCase() === 'chatgpt' ||
      (auth.tokens && typeof auth.tokens === 'object' && Object.keys(auth.tokens).length > 0);
  } catch (_) { return false; }
}

function sameEndpoint(a, b) {
  return String(a || '').replace(/\/+$/, '').toLowerCase() === String(b || '').replace(/\/+$/, '').toLowerCase();
}

function readToml(value, key) {
  const match = String(value || '').match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'im'));
  return match ? match[1].trim() : '';
}

function parseCcSwitch(row) {
  const settings = JSON.parse(row.settings_config || '{}');
  const meta = JSON.parse(row.meta || '{}');
  const format = String(settings.apiFormat || meta.apiFormat || '').toLowerCase();
  const config = settings.config || '';
  const responses = format === 'openai_responses' || /^\s*wire_api\s*=\s*["']responses["']/im.test(config);
  if (!responses || ['openai_chat', 'anthropic'].includes(format)) return null;
  const endpoint = settings.base_url || readToml(config, 'base_url') || meta.base_url;
  const key = settings.auth?.OPENAI_API_KEY || readToml(config, 'experimental_bearer_token');
  if (!endpoint || !key || !row.name) return null;
  return {
    id: stableId('cc-switch', row.id), name: String(row.name).trim(), source: 'CC Switch',
    sourceId: String(row.id || ''), endpointUrl: validateEndpoint(endpoint),
    model: readToml(config, 'model') || DEFAULT_MODEL,
    reasoningEffort: readToml(config, 'model_reasoning_effort') || DEFAULT_EFFORT,
    apiKey: String(key).trim()
  };
}

module.exports = { TokenVaultService, importManagedTokens, TOKEN_TARGETS };
