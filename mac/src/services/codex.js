const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const WebSocket = require('ws');

const execFileAsync = promisify(execFile);

class CodexService {
  constructor({ account, conversations, resourceRoot, log = () => {}, status = () => {} }) {
    this.account = account;
    this.conversations = conversations;
    this.resourceRoot = resourceRoot;
    this.log = log;
    this.status = status;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
    this.maintainTimer = null;
    this.debugPort = 9230;
  }

  findInstall() {
    const candidates = [
      '/Applications/Codex.app',
      path.join(os.homedir(), 'Applications', 'Codex.app'),
      '/Applications/ChatGPT.app',
      path.join(os.homedir(), 'Applications', 'ChatGPT.app')
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) || '';
  }

  async stop() {
    await this.stopInjection();
    const appPath = this.findInstall();
    const appName = appPath ? path.basename(appPath, '.app') : 'Codex';
    try {
      await execFileAsync('/usr/bin/osascript', ['-e', `tell application "${appName.replace(/"/g, '\\"')}" to quit`], { timeout: 8000 });
    } catch (_) {}
    await delay(800);
  }

  async start({ debugPort = 9230, restart = false } = {}) {
    const appPath = this.findInstall();
    if (!appPath) throw new Error('未找到 Codex，请先点击“安装 Codex”。');
    this.debugPort = normalizePort(debugPort);
    if (restart) await this.stop();
    this.status('正在启动 Codex…');
    spawn('/usr/bin/open', [
      '-na', appPath, '--args',
      `--remote-debugging-port=${this.debugPort}`,
      '--remote-debugging-address=127.0.0.1'
    ], { detached: true, stdio: 'ignore' }).unref();
    this.log('已启动 macOS Codex，正在连接页面增强功能。', 'info');
    await this.startInjection();
  }

  async startInjection() {
    await this.stopInjection();
    let lastError = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const wsUrl = await findPageSocket(this.debugPort);
        await this.connect(wsUrl);
        this.status('Codex 已连接');
        this.log('余额、上下文与对话工具已注入 Codex。', 'ok');
        this.maintainTimer = setInterval(() => {
          if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            clearInterval(this.maintainTimer);
            this.maintainTimer = null;
            this.startInjection().catch(() => {});
          }
        }, 3000);
        return;
      } catch (error) {
        lastError = error;
        await delay(500);
      }
    }
    this.status('Codex 已打开（增强功能未连接）');
    throw new Error(`Codex 已打开，但页面增强功能连接失败：${lastError?.message || '超时'}`);
  }

  async connect(wsUrl) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 5000);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    this.socket = socket;
    socket.on('message', (raw) => this.onMessage(raw.toString()));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
    });
    const bundle = this.buildInjectBundle();
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Runtime.addBinding', { name: '__codexLauncherBridge' });
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: bundle });
    await this.send('Runtime.evaluate', { expression: bundle, awaitPromise: false });
  }

  buildInjectBundle() {
    const order = ['bridge.js', 'usage-core.js', 'balance-overlay.js', 'usage-badge.js', 'thread-delete.js', 'context-bar.js'];
    return order.map((name) => fs.readFileSync(path.join(this.resourceRoot, 'inject', name), 'utf8')).join('\n;\n');
  }

  async stopInjection() {
    if (this.maintainTimer) clearInterval(this.maintainTimer);
    this.maintainTimer = null;
    if (this.socket) {
      try { this.socket.close(); } catch (_) {}
      this.socket = null;
    }
    for (const item of this.pending.values()) item.reject(new Error('连接已关闭'));
    this.pending.clear();
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP 未连接'));
    const id = ++this.sequence;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, 10000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
  }

  onMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch (_) { return; }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP 请求失败'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.bindingCalled' && message.params?.name === '__codexLauncherBridge') {
      this.handleBinding(message.params).catch(() => {});
    }
  }

  async handleBinding(params) {
    let request = {};
    try { request = JSON.parse(params.payload || '{}'); } catch (_) {}
    let result;
    try {
      switch (request.path) {
        case '/balance/get':
          result = { ok: true, ...this.account.balancePayload() };
          break;
        case '/usage/resolve':
          result = await this.account.resolveUsage(request.payload || {});
          break;
        case '/context/get':
          result = this.conversations.readContext(request.payload?.threadId);
          break;
        case '/thread/delete':
          result = this.conversations.deleteThread(request.payload?.threadId);
          break;
        default:
          result = { ok: false, error: 'unsupported_path' };
      }
    } catch (error) {
      result = { ok: false, error: String(error.message || error) };
    }
    const envelope = JSON.stringify({ id: String(request.id || ''), result });
    const expression = `window.__codexLauncherResolve(${JSON.stringify(envelope)})`;
    await this.send('Runtime.evaluate', {
      expression, contextId: params.executionContextId, returnByValue: true
    }).catch(() => {});
  }
}

async function findPageSocket(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`调试端口 HTTP ${response.status}`);
  const targets = await response.json();
  const candidates = targets.filter((target) =>
    target.type === 'page' && target.webSocketDebuggerUrl && !String(target.url || '').startsWith('devtools://')
  );
  const preferred = candidates.find((target) => /codex|chatgpt|index\.html/i.test(`${target.title} ${target.url}`)) || candidates[0];
  if (!preferred) throw new Error('未找到 Codex 页面');
  return preferred.webSocketDebuggerUrl;
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 9230;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = { CodexService, findPageSocket, normalizePort };
