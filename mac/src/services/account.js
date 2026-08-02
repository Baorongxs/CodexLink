const fs = require('node:fs');
const { atomicWrite, normalizeBase } = require('./util');

class AccountService {
  constructor({ sessionPath, safeStorage }) {
    this.sessionPath = sessionPath;
    this.safeStorage = safeStorage;
    this.quotaPerUnit = 500000;
    this.state = {
      loggedIn: false, baseUrl: '', username: '', displayName: '', userId: '',
      cookieHeader: '', quota: 0, usedQuota: 0, balanceText: '$--',
      usedText: '$--', refreshedAt: ''
    };
    this.load();
  }

  protect(value) {
    const raw = String(value || '');
    if (this.safeStorage.isEncryptionAvailable()) {
      return `safe:${this.safeStorage.encryptString(raw).toString('base64')}`;
    }
    return `plain:${Buffer.from(raw, 'utf8').toString('base64')}`;
  }

  unprotect(value) {
    if (!value) return '';
    if (value.startsWith('safe:')) {
      return this.safeStorage.decryptString(Buffer.from(value.slice(5), 'base64'));
    }
    if (value.startsWith('plain:')) return Buffer.from(value.slice(6), 'base64').toString('utf8');
    return '';
  }

  load() {
    try {
      const decoded = this.unprotect(fs.readFileSync(this.sessionPath, 'utf8'));
      Object.assign(this.state, JSON.parse(decoded));
      this.applyMoneyTexts();
    } catch (_) {}
  }

  save() {
    atomicWrite(this.sessionPath, this.protect(JSON.stringify(this.state)));
  }

  clear() {
    this.state = {
      loggedIn: false, baseUrl: '', username: '', displayName: '', userId: '',
      cookieHeader: '', quota: 0, usedQuota: 0, balanceText: '$--',
      usedText: '$--', refreshedAt: ''
    };
    try { fs.rmSync(this.sessionPath, { force: true }); } catch (_) {}
  }

  applyMoneyTexts() {
    this.state.balanceText = this.formatMoney(this.state.quota / this.quotaPerUnit);
    this.state.usedText = this.formatMoney(this.state.usedQuota / this.quotaPerUnit);
  }

  formatMoney(value) {
    const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
    return `$${amount.toFixed(amount >= 100 ? 2 : 4).replace(/0+$/, '').replace(/\.$/, '')}`;
  }

  captureCookies(response) {
    const values = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    const pairs = values.map((item) => String(item).split(';', 1)[0]).filter(Boolean);
    if (!pairs.length) return;
    const cookies = new Map();
    for (const item of String(this.state.cookieHeader || '').split(/;\s*/).filter(Boolean)) {
      const split = item.indexOf('=');
      if (split > 0) cookies.set(item.slice(0, split), item.slice(split + 1));
    }
    for (const pair of pairs) {
      const split = pair.indexOf('=');
      if (split > 0) cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    this.state.cookieHeader = [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  async rawRequest(baseUrl, relativePath, { method = 'GET', body, authenticated = false } = {}) {
    const headers = { Accept: 'application/json', 'User-Agent': 'CodexLink/1.0.23 macOS' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticated) {
      this.ensureLoggedIn();
      if (this.state.cookieHeader) headers.Cookie = this.state.cookieHeader;
      if (this.state.userId) headers['New-Api-User'] = String(this.state.userId);
    }
    const response = await fetch(`${normalizeBase(baseUrl)}${relativePath}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'follow'
    });
    this.captureCookies(response);
    const text = await response.text();
    let envelope;
    try { envelope = text ? JSON.parse(text) : {}; } catch (_) { throw new Error(`服务返回了无效数据（HTTP ${response.status}）。`); }
    if (!response.ok) throw new Error(envelope.message || `请求失败（HTTP ${response.status}）。`);
    if (Object.prototype.hasOwnProperty.call(envelope, 'success') && !envelope.success) {
      throw new Error(envelope.message || '服务请求失败。');
    }
    return envelope;
  }

  async request(relativePath, { method = 'GET', body } = {}) {
    const envelope = await this.rawRequest(this.state.baseUrl, relativePath, { method, body, authenticated: true });
    return Object.prototype.hasOwnProperty.call(envelope, 'data') ? envelope.data : envelope;
  }

  async login(baseUrl, username, password) {
    baseUrl = normalizeBase(baseUrl);
    if (!String(username || '').trim() || !password) throw new Error('请输入用户名和密码。');
    const envelope = await this.rawRequest(baseUrl, '/api/user/login', {
      method: 'POST', body: { username: String(username).trim(), password }
    });
    const data = envelope.data || {};
    if (data.require_2fa) throw new Error('该账号需要 2FA，请先在网页完成二次验证。');
    const userId = data.id ?? data.user_id ?? data.userId;
    if (userId === undefined || userId === null || userId === '') throw new Error('登录成功但未返回用户 ID。');
    Object.assign(this.state, {
      loggedIn: true, baseUrl, username: String(username).trim(),
      displayName: data.display_name || data.displayName || username,
      userId: String(userId)
    });
    this.save();
    await this.refreshBalance();
  }

  async register(baseUrl, username, password, email, verificationCode, affCode) {
    if (!username || !password) throw new Error('请输入用户名和密码。');
    if (String(password).length < 8 || String(password).length > 20) throw new Error('密码长度需为 8-20 位。');
    if (!email || !verificationCode) throw new Error('请填写邮箱和邮箱验证码。');
    const body = { username, password, email, verification_code: verificationCode };
    if (affCode) body.aff_code = affCode;
    await this.rawRequest(baseUrl, '/api/user/register', { method: 'POST', body });
    await this.login(baseUrl, username, password);
  }

  async sendEmailCode(baseUrl, email) {
    if (!email) throw new Error('请填写邮箱。');
    await this.rawRequest(baseUrl, `/api/verification?email=${encodeURIComponent(email)}`);
  }

  async refreshBalance() {
    const self = await this.request('/api/user/self');
    Object.assign(this.state, {
      quota: Number(self.quota || 0),
      usedQuota: Number(self.used_quota ?? self.usedQuota ?? 0),
      username: self.username || this.state.username,
      displayName: self.display_name || self.displayName || self.username || this.state.displayName,
      userId: String(self.id ?? self.user_id ?? this.state.userId),
      refreshedAt: new Date().toLocaleString('zh-CN', { hour12: false })
    });
    this.applyMoneyTexts();
    this.save();
  }

  balancePayload() {
    return {
      type: 'balance', loggedIn: this.state.loggedIn, username: this.state.username,
      displayName: this.state.displayName, balanceText: this.state.balanceText,
      usedText: this.state.usedText, quota: this.state.quota, usedQuota: this.state.usedQuota,
      refreshedAt: this.state.refreshedAt
    };
  }

  ensureLoggedIn() {
    if (!this.state.loggedIn) throw new Error('请先登录。');
  }

  async getTopupInfo() {
    return this.request('/api/user/topup/info');
  }

  async calculateTopup(amount) {
    if (!(Number(amount) > 0)) throw new Error('请输入有效的充值金额。');
    const envelope = await this.rawRequest(this.state.baseUrl, '/api/user/amount', {
      method: 'POST', body: { amount: Number(amount) }, authenticated: true
    });
    if (envelope.data === undefined || envelope.data === null || envelope.data === '') throw new Error('未能计算待支付金额。');
    return String(envelope.data);
  }

  async createTopup(amount, paymentMethod) {
    if (!(Number(amount) > 0) || !paymentMethod) throw new Error('请输入充值金额并选择付款方式。');
    const envelope = await this.rawRequest(this.state.baseUrl, '/api/user/pay', {
      method: 'POST', body: { amount: Number(amount), payment_method: String(paymentMethod).trim() }, authenticated: true
    });
    if (!envelope.url || !envelope.data || typeof envelope.data !== 'object') throw new Error('付款页面创建失败，请稍后重试。');
    return { url: envelope.url, fields: envelope.data };
  }

  async listAllTokens() {
    const all = [];
    for (let page = 1; page < 100; page += 1) {
      const data = await this.request(`/api/token/?p=${page}&size=100`);
      const items = Array.isArray(data.items) ? data.items : [];
      all.push(...items);
      if (items.length < 100 || (data.total > 0 && page * 100 >= data.total)) break;
    }
    return all;
  }

  async resolveUsage(request = {}) {
    if (!this.state.loggedIn) {
      return { ok: true, costReady: false, costText: '需登录', balanceText: '未登录', loggedIn: false };
    }
    let matched = null;
    try {
      const observed = Math.floor(Number(request.observedAt || Date.now()) / 1000);
      const data = await this.request(`/api/log/self?type=2&p=1&page_size=50&start_timestamp=${Math.max(0, observed - 180)}&end_timestamp=${observed + 30}`);
      const items = Array.isArray(data.items) ? data.items : Array.isArray(data.data) ? data.data : [];
      matched = items[0] || null;
    } catch (_) {}
    await this.refreshBalance();
    const inputTokens = Number(matched?.prompt_tokens ?? matched?.promptTokens ?? request.inputTokens ?? 0);
    const outputTokens = Number(matched?.completion_tokens ?? matched?.completionTokens ?? request.outputTokens ?? 0);
    const quota = matched && matched.quota !== undefined ? Number(matched.quota) : -1;
    const estimated = (inputTokens / 1e6) * 2.5 + (outputTokens / 1e6) * 10;
    return {
      ok: true, costReady: quota >= 0,
      costText: quota >= 0 ? this.formatMoney(quota / this.quotaPerUnit) : estimated > 0 ? `约 ${this.formatMoney(estimated)}` : '结算中…',
      costQuota: quota, balanceText: this.state.balanceText, usedText: this.state.usedText,
      quota: this.state.quota, usedQuota: this.state.usedQuota, username: this.state.username,
      loggedIn: true, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
      model: matched?.model_name || matched?.model || request.model || '', logId: String(matched?.id || '')
    };
  }
}

module.exports = { AccountService };
