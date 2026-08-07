const fs = require('node:fs');
const { atomicWrite, normalizeBase } = require('./util');

async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('请求超时，请检查网络后重试。');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

class AccountService {
  constructor({ sessionPath, safeStorage }) {
    this.sessionPath = sessionPath;
    this.safeStorage = safeStorage;
    this.quotaPerUnit = 500000;
    this.state = {
      loggedIn: false, baseUrl: '', username: '', displayName: '', userId: '',
      cookieHeader: '', accessToken: '', accessExpiresAt: 0, authSessionId: '',
      quota: 0, usedQuota: 0, balanceText: '$--',
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
      cookieHeader: '', accessToken: '', accessExpiresAt: 0, authSessionId: '',
      quota: 0, usedQuota: 0, balanceText: '$--',
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
    baseUrl = normalizeBase(baseUrl);
    if (authenticated) {
      this.ensureLoggedIn();
      await this.ensureFreshAccessToken(false);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (authenticated && attempt > 0) await this.ensureFreshAccessToken(true);
      const headers = {
        Accept: 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'User-Agent': 'CodexLink/1.0.25 macOS'
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (authenticated) {
        if (method === 'GET') {
          headers['Cache-Control'] = 'no-cache, no-store';
          headers.Pragma = 'no-cache';
        }
        if (this.state.cookieHeader) headers.Cookie = this.state.cookieHeader;
        if (this.state.userId) headers['New-Api-User'] = String(this.state.userId);
        if (this.state.accessToken) headers.Authorization = `Bearer ${this.state.accessToken}`;
        if (this.state.authSessionId) headers['X-Auth-Session'] = this.state.authSessionId;
      }
      const response = await fetchWithTimeout(`${baseUrl}${relativePath}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'follow'
      });
      this.captureCookies(response);
      const text = await response.text();
      let envelope;
      try { envelope = text ? JSON.parse(text) : {}; } catch (_) { throw new Error(`服务返回了无效数据（HTTP ${response.status}）。`); }
      if (response.status === 401 && authenticated && attempt === 0 && this.isModernAuthentication()) continue;
      if (!response.ok) throw new Error(this.apiFailureMessage(envelope, response.status));
      if (Object.prototype.hasOwnProperty.call(envelope, 'success') && !envelope.success) {
        throw new Error(this.apiFailureMessage(envelope, response.status));
      }
      if (authenticated) this.save();
      return envelope;
    }
    throw new Error('登录会话已过期，请重新登录。');
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
    const user = data.user && typeof data.user === 'object' ? data.user : {};
    const userId = data.id ?? data.user_id ?? data.userId ?? user.id ?? user.user_id ?? user.userId;
    if (userId === undefined || userId === null || userId === '') {
      throw new Error('登录响应缺少用户信息，请确认 New API 已完整更新后重试。');
    }
    const authSession = data.session && typeof data.session === 'object' ? data.session : {};
    Object.assign(this.state, {
      loggedIn: true, baseUrl, username: String(username).trim(),
      displayName: user.display_name || user.displayName || data.display_name || data.displayName || username,
      userId: String(userId),
      accessToken: data.access_token || data.accessToken || '',
      accessExpiresAt: Number(data.access_expires_at ?? data.accessExpiresAt ?? 0),
      authSessionId: String(authSession.sid ?? authSession.id ?? '')
    });
    this.save();
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
    const self = await this.request(`/api/user/self?codexlink_ts=${Date.now()}`);
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

  isModernAuthentication() {
    return Boolean(this.state.accessToken);
  }

  async ensureFreshAccessToken(force) {
    if (!this.isModernAuthentication()) return;
    const now = Math.floor(Date.now() / 1000);
    if (!force && (!(Number(this.state.accessExpiresAt) > 0) || Number(this.state.accessExpiresAt) > now + 60)) return;
    const headers = {
      Accept: 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Content-Type': 'application/json',
      'User-Agent': 'CodexLink/1.0.25 macOS',
      Origin: new URL(normalizeBase(this.state.baseUrl)).origin,
      Referer: `${normalizeBase(this.state.baseUrl)}/`,
      'Cache-Control': 'no-cache, no-store',
      Pragma: 'no-cache'
    };
    if (this.state.cookieHeader) headers.Cookie = this.state.cookieHeader;
    if (this.state.authSessionId) headers['X-Auth-Session'] = this.state.authSessionId;
    const response = await fetchWithTimeout(`${normalizeBase(this.state.baseUrl)}/api/user/auth/refresh`, {
      method: 'POST', headers, body: '{}', redirect: 'follow'
    });
    this.captureCookies(response);
    const text = await response.text();
    let envelope;
    try { envelope = text ? JSON.parse(text) : {}; } catch (_) { throw new Error('刷新登录会话失败，请重新登录。'); }
    if (!response.ok || !envelope.success) throw new Error(this.apiFailureMessage(envelope, response.status));
    const data = envelope.data || {};
    const user = data.user && typeof data.user === 'object' ? data.user : {};
    const authSession = data.session && typeof data.session === 'object' ? data.session : {};
    const token = data.access_token || data.accessToken || '';
    if (!token) throw new Error('刷新登录会话失败，请重新登录。');
    Object.assign(this.state, {
      accessToken: token,
      accessExpiresAt: Number(data.access_expires_at ?? data.accessExpiresAt ?? 0),
      authSessionId: String(authSession.sid ?? authSession.id ?? this.state.authSessionId ?? ''),
      userId: String(user.id ?? user.user_id ?? user.userId ?? this.state.userId ?? '')
    });
    this.save();
  }

  apiFailureMessage(envelope, status) {
    if (status === 401) return '登录会话已过期，请重新登录。';
    if (status === 429) return '操作过于频繁，请稍后再试。';
    if (status >= 500 && !envelope?.message) return '服务器暂时异常，请稍后重试。';
    return envelope?.message || envelope?.error || `请求失败（HTTP ${status}）。`;
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
