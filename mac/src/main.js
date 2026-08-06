const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray
} = require('electron');
const { AccountService } = require('./services/account');
const { CodexService } = require('./services/codex');
const { ConversationService } = require('./services/conversations');
const { TokenVaultService, importManagedTokens } = require('./services/token-vault');
const { atomicWrite, ensureDir, publicMessage } = require('./services/util');

const APP_NAME = 'CodexLink';
const APP_VERSION = '1.0.25';
const RELEASE_API = 'https://api.github.com/repos/Baorongxs/CodexLink/releases/latest';
const OFFICIAL_DOWNLOAD_URL = 'https://studio.baorongxs.top';
const DOWNLOAD_URL = 'https://chatgpt.com/download/';

app.setName(APP_NAME);

let mainWindow = null;
let tray = null;
let paymentWindow = null;
let account = null;
let tokenVault = null;
let conversations = null;
let codex = null;
let settings = null;
let settingsPath = '';
let availableUpdate = null;
let historyBusy = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on('second-instance', () => showMainWindow());
app.on('activate', () => showMainWindow());
app.on('window-all-closed', () => {});

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  const resourceRoot = path.join(__dirname, '..', 'resources');
  settingsPath = path.join(userData, 'settings.json');
  settings = loadSettings();
  account = new AccountService({ sessionPath: path.join(userData, 'session.dat'), safeStorage });
  conversations = new ConversationService({ codexHome: path.join(os.homedir(), '.codex') });
  tokenVault = new TokenVaultService({
    vaultPath: path.join(userData, 'token-vault.dat'),
    codexHome: path.join(os.homedir(), '.codex'),
    ccSwitchDbPath: path.join(os.homedir(), '.cc-switch', 'cc-switch.db'),
    safeStorage
  });
  codex = new CodexService({
    account, conversations, resourceRoot,
    log: postLog, status: postStatus
  });
  createWindow(resourceRoot);
  createTray(resourceRoot);
  registerIpc(resourceRoot);
}).catch((error) => {
  dialog.showErrorBox(APP_NAME, publicMessage(error.message));
  app.quit();
});

function createWindow(resourceRoot) {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 760,
    minWidth: 420,
    minHeight: 620,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#eef3f9',
    title: `${APP_NAME} macOS`,
    icon: path.join(resourceRoot, 'app-logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(resourceRoot, 'launcher-ui.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
}

function createTray(resourceRoot) {
  const image = nativeImage.createFromPath(path.join(resourceRoot, 'app-logo.png')).resize({ width: 18, height: 18 });
  tray = new Tray(image);
  tray.setToolTip(`${APP_NAME} macOS`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 CodexLink', click: showMainWindow },
    { label: '打开 Codex', click: () => handleAction({ action: 'start-codex' }) },
    { type: 'separator' },
    {
      label: '退出',
      click: async () => {
        app.isQuitting = true;
        await codex?.stopInjection().catch(() => {});
        app.quit();
      }
    }
  ]));
  tray.on('click', showMainWindow);
}

function showMainWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function registerIpc(resourceRoot) {
  ipcMain.on('codexlink:message', (_event, raw) => {
    let payload = raw;
    if (typeof raw === 'string') {
      try { payload = JSON.parse(raw); } catch (_) { payload = { action: raw }; }
    }
    handleAction(payload || {}, resourceRoot).catch((error) => {
      postToast(publicMessage(error.message), true);
      postLog(`操作失败：${publicMessage(error.message)}`, 'error');
    });
  });
}

async function handleAction(payload, resourceRoot = path.join(__dirname, '..', 'resources')) {
  const action = String(payload.action || '');
  if (historyBusy && !['window-minimize', 'window-maximize', 'window-close', 'clear-logs'].includes(action)) {
    postToast('对话备份/恢复正在进行，请等待完成。', true);
    return;
  }
  switch (action) {
    case 'ui-ready':
      onUiReady(resourceRoot);
      break;
    case 'drag-window':
      break;
    case 'window-minimize':
      mainWindow.minimize();
      break;
    case 'window-maximize':
      mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
      break;
    case 'window-close':
      mainWindow.hide();
      break;
    case 'login':
      await login(payload);
      break;
    case 'register':
      await register(payload);
      break;
    case 'send-code':
      await account.sendEmailCode(payload.baseUrl || settings.baseUrl, payload.email);
      postToast('验证码已发送，请查收邮箱');
      postLog('验证码已发送。', 'ok');
      break;
    case 'logout':
      account.clear();
      post(account.balancePayload());
      postLog('已退出登录。', 'info');
      break;
    case 'refresh-balance':
      await account.refreshBalance();
      post(account.balancePayload());
      postLog(`余额已刷新：${account.state.balanceText}`, 'ok');
      break;
    case 'open-topup':
      await loadTopup();
      break;
    case 'calculate-topup':
      await calculateTopup(payload);
      break;
    case 'create-topup-payment':
      await createTopupPayment(payload);
      break;
    case 'open-site':
      openExternal(payload.url || payload.href || settings.baseUrl);
      break;
    case 'check-update':
      await checkForUpdates(true);
      break;
    case 'download-update':
      if (availableUpdate) {
        openExternal(getOfficialDownloadUrl());
        postToast('已打开 CodexLink 官网下载页面');
      }
      break;
    case 'open-codex-root':
      ensureDir(path.join(os.homedir(), '.codex'));
      await shell.openPath(path.join(os.homedir(), '.codex'));
      break;
    case 'open-codex-config':
      ensureDir(path.join(os.homedir(), '.codex'));
      if (!fs.existsSync(path.join(os.homedir(), '.codex', 'config.toml'))) atomicWrite(path.join(os.homedir(), '.codex', 'config.toml'), '');
      await shell.openPath(path.join(os.homedir(), '.codex', 'config.toml'));
      break;
    case 'open-backup-folder':
      ensureDir(conversations.backupRoot);
      await shell.openPath(conversations.backupRoot);
      break;
    case 'backup-conversations':
      await backupConversations();
      break;
    case 'restore-conversations':
      await restoreConversations();
      break;
    case 'repair-conversation-sidebar':
      await repairSidebar();
      break;
    case 'import-api':
      await importApi(false);
      break;
    case 'reset-api-profiles':
      await importApi(true);
      break;
    case 'select-route':
      await selectRoute(payload);
      break;
    case 'set-official-mode':
      await setOfficialMode(Boolean(payload.enabled));
      break;
    case 'import-ccswitch-profiles':
      await importCcSwitch();
      break;
    case 'install-online':
      post({ type: 'step', id: 'install-codex', state: 'running' });
      postProgress('安装 Codex（macOS）', 60, '正在打开官方下载页…');
      openExternal(DOWNLOAD_URL);
      postProgress('Codex 安装流程已触发', 100, '下载 DMG 后拖入“应用程序”文件夹', false, true);
      post({ type: 'step', id: 'install-codex', state: 'success' });
      postToast('已打开 Codex 官方 macOS 下载页');
      break;
    case 'install-offline':
      await installOffline();
      break;
    case 'start-codex':
      await startCodex(payload, false);
      break;
    case 'restart-codex':
      await startCodex(payload, true);
      break;
    case 'stop-inject':
      await codex.stopInjection();
      postStatus('页面增强已停止');
      postLog('已停止 Codex 页面增强功能。', 'info');
      break;
    case 'clear-logs':
      break;
    default:
      if (action) postLog(`暂不支持的操作：${action}`, 'error');
  }
}

function onUiReady(resourceRoot) {
  tokenVault.initialize();
  post({
    type: 'assets',
    appLogo: fileDataUrl(path.join(resourceRoot, 'app-logo.png'), 'image/png'),
    supportQr: fileDataUrl(path.join(resourceRoot, 'support-qr.png'), 'image/png')
  });
  post({
    type: 'settings', baseUrl: settings.baseUrl, username: settings.username,
    password: settings.password ? decryptSetting(settings.password) : '',
    debugPort: settings.debugPort, appVersion: APP_VERSION, appName: `${APP_NAME} macOS`
  });
  post(account.balancePayload());
  postStatus('macOS 启动器就绪');
  refreshRoutes(true);
  postLog('CodexLink macOS 启动器就绪。', 'ok');
  if (account.state.loggedIn) account.refreshBalance().then(() => post(account.balancePayload())).catch(() => {});
  checkForUpdates(false).catch(() => {});
}

async function login(payload) {
  settings.baseUrl = payload.baseUrl || settings.baseUrl;
  settings.username = payload.username || '';
  settings.debugPort = Number(payload.debugPort || settings.debugPort || 9230);
  settings.password = encryptSetting(payload.password || '');
  saveSettings();
  postLog('正在登录。', 'info');
  await account.login(settings.baseUrl, settings.username, payload.password || '');
  post(account.balancePayload());
  postToast('登录成功');
  postLog('登录成功。', 'ok');
}

async function register(payload) {
  settings.baseUrl = payload.baseUrl || settings.baseUrl;
  settings.username = payload.username || '';
  settings.password = encryptSetting(payload.password || '');
  saveSettings();
  await account.register(
    settings.baseUrl, payload.username, payload.password, payload.email,
    payload.verificationCode, payload.affCode
  );
  post({ type: 'register-ok', username: payload.username, password: payload.password });
  post(account.balancePayload());
  postToast('注册成功，已自动登录');
  postLog('注册成功并已登录。', 'ok');
}

async function loadTopup() {
  try {
    post({ type: 'topup-info', info: await account.getTopupInfo() });
  } catch (error) {
    post({ type: 'topup-error', stage: 'load', message: publicMessage(error.message) });
    throw error;
  }
}

async function calculateTopup(payload) {
  try {
    const paymentAmount = await account.calculateTopup(payload.amount);
    post({ type: 'topup-amount', amount: Number(payload.amount), paymentMethod: payload.paymentMethod || '', paymentAmount });
  } catch (_) {
    post({ type: 'topup-error', stage: 'calculate', amount: Number(payload.amount), paymentMethod: payload.paymentMethod || '' });
  }
}

async function createTopupPayment(payload) {
  try {
    const checkout = await account.createTopup(payload.amount, payload.paymentMethod);
    await openPaymentWindow(checkout.url, checkout.fields);
    post({ type: 'topup-payment-opened' });
    postToast('付款页面已打开，请扫码完成支付');
    postLog('已创建充值订单。', 'ok');
  } catch (error) {
    post({ type: 'topup-error', stage: 'payment', message: publicMessage(error.message) });
    throw error;
  }
}

async function openPaymentWindow(checkoutUrl, fields) {
  const url = new URL(checkoutUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('付款页面地址无效。');
  }
  if (paymentWindow && !paymentWindow.isDestroyed()) paymentWindow.close();
  paymentWindow = new BrowserWindow({
    parent: mainWindow, modal: true, width: 820, height: 760,
    title: 'CodexLink 安全支付', autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  const form = Object.entries(fields || {}).map(([key, value]) =>
    `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(String(value ?? ''))}">`
  ).join('');
  const html = `<!doctype html><meta charset="utf-8"><title>正在打开支付页面</title>
    <body><p>正在安全打开付款页面…</p><form id="pay" method="post" action="${escapeHtml(url.toString())}">${form}</form>
    <script>document.getElementById('pay').submit()</script></body>`;
  paymentWindow.webContents.setWindowOpenHandler(({ url: next }) => {
    if (isHttpUrl(next)) paymentWindow.loadURL(next);
    return { action: 'deny' };
  });
  paymentWindow.on('closed', () => { paymentWindow = null; });
  await paymentWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function importApi(replaceAll) {
  post({ type: 'step', id: 'import-api', state: 'running' });
  postProgress(replaceAll ? '重建 API' : '导入 API', 10, '读取账号令牌…', true);
  postStatus(replaceAll ? '正在重建 API…' : '正在导入 API…');
  try {
    await importManagedTokens(account, tokenVault, replaceAll, postLog);
    refreshRoutes(true);
    postProgress(replaceAll ? 'API 重建完成' : '导入 API 完成', 100, '', false, true);
    post({ type: 'step', id: 'import-api', state: 'success' });
    postStatus(replaceAll ? '重建完成' : '导入完成');
    postToast(replaceAll ? '已重新导入 9 条 API' : 'API 已通过 macOS 钥匙串加密保存');
  } catch (error) {
    postProgress(replaceAll ? 'API 重建失败' : '导入 API 失败', 100, '请确认登录后重试', false, true, true);
    post({ type: 'step', id: 'import-api', state: 'error' });
    throw error;
  }
}

function refreshRoutes(quiet = true) {
  try {
    const view = tokenVault.getView();
    const current = view.profiles.find((profile) => profile.id === view.currentId)?.name || '';
    post({
      type: 'routes', routes: view.profiles.map((profile) => profile.name), current,
      profiles: view.profiles, currentId: view.currentId, officialMode: view.officialMode,
      officialAvailable: view.officialAvailable, ccSwitchImportAvailable: view.ccSwitchImportAvailable
    });
  } catch (error) {
    post({ type: 'routes', routes: [], current: '' });
    if (!quiet) throw error;
  }
}

async function selectRoute(payload) {
  if (!payload.profileId) throw new Error('未指定令牌。');
  postStatus('正在切换令牌…');
  await codex.stop();
  tokenVault.selectProfile(String(payload.profileId));
  refreshRoutes(true);
  postToast('令牌已切换，正在重新打开 Codex');
  await startCodex(payload, true);
}

async function setOfficialMode(enabled) {
  postStatus(enabled ? '正在切换官方渠道…' : '正在恢复 API…');
  await codex.stop();
  tokenVault.setOfficialMode(enabled);
  refreshRoutes(true);
  postToast(enabled ? '已打开官方账号登录' : '已恢复最近使用的 API');
  await startCodex({}, true);
}

async function importCcSwitch() {
  const result = await tokenVault.importFromCcSwitch();
  refreshRoutes(true);
  const message = `第三方 API 导入完成：导入 ${result.imported} 条，跳过 ${result.skipped} 条。`;
  postToast(message);
  postLog(message, 'ok');
}

async function startCodex(payload, restart) {
  tokenVault.ensureCurrentConfiguration();
  settings.debugPort = Number(payload.debugPort || settings.debugPort || 9230);
  saveSettings();
  await codex.start({ debugPort: settings.debugPort, restart });
  postStatus('Codex 已启动');
}

async function backupConversations() {
  setHistoryBusy(true);
  try {
    await codex.stop();
    const result = conversations.createBackup({
      progress: (percent, meta) => postProgress('备份本地对话', percent, meta, false)
    });
    postProgress('对话备份完成', 100, path.basename(result.path), false, true);
    postToast(`已备份 ${result.fileCount} 个对话文件`);
    postLog('本地对话已完成隐私范围备份（不包含账号和 API 令牌）。', 'ok');
  } finally { setHistoryBusy(false); }
}

async function restoreConversations() {
  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title: '恢复本地对话',
    message: '将从最新的 CodexLink 备份合并恢复缺失对话。继续前会自动创建安全备份。',
    buttons: ['取消', '继续恢复'], defaultId: 0, cancelId: 0
  });
  if (answer.response !== 1) return;
  setHistoryBusy(true);
  try {
    await codex.stop();
    const result = await conversations.restoreLatest({
      progress: (percent, meta) => postProgress('恢复本地对话', percent, meta, false)
    });
    postProgress('对话恢复完成', 100, `恢复 ${result.restored} 项`, false, true);
    postToast('本地对话恢复完成');
    postLog('本地对话已恢复，并保留了恢复前安全备份。', 'ok');
  } finally { setHistoryBusy(false); }
}

async function repairSidebar() {
  setHistoryBusy(true);
  try {
    await codex.stop();
    const result = await conversations.repairSidebar();
    postToast(`侧边栏修复完成，更新 ${result.changed} 条记录`);
    postLog('Codex 对话侧边栏已修复。', 'ok');
  } finally { setHistoryBusy(false); }
}

function setHistoryBusy(busy) {
  historyBusy = busy;
  post({ type: 'history-operation', busy });
}

async function installOffline() {
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Codex macOS 安装包',
    properties: ['openFile'],
    filters: [{ name: 'macOS 安装包', extensions: ['dmg', 'pkg'] }]
  });
  if (selected.canceled || !selected.filePaths[0]) return;
  post({ type: 'step', id: 'install-codex', state: 'running' });
  postProgress('打开离线安装包', 60, path.basename(selected.filePaths[0]), false);
  const error = await shell.openPath(selected.filePaths[0]);
  if (error) throw new Error(error);
  postProgress('安装包已打开', 100, '请按 macOS 提示完成安装', false, true);
  post({ type: 'step', id: 'install-codex', state: 'success' });
  postToast('Codex 安装包已打开');
}

async function checkForUpdates(manual) {
  try {
    const response = await fetch(RELEASE_API, { headers: { 'User-Agent': `CodexLink/${APP_VERSION}` } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const release = await response.json();
    const latestVersion = String(release.tag_name || '').replace(/^v/i, '');
    if (!latestVersion || compareVersions(latestVersion, APP_VERSION) <= 0) {
      if (manual) postToast('当前已是最新版本');
      return;
    }
    availableUpdate = { version: latestVersion };
    post({
      type: 'update-available', latestVersion, currentVersion: APP_VERSION,
      notes: release.body || '新版已经发布，建议下载更新。'
    });
  } catch (error) {
    if (manual) postToast(`检查更新失败：${publicMessage(error.message)}`, true);
  }
}

function getOfficialDownloadUrl() {
  const url = new URL(OFFICIAL_DOWNLOAD_URL);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'studio.baorongxs.top') {
    throw new Error('官网下载地址无效。');
  }
  return url.toString().replace(/\/$/, '');
}

function loadSettings() {
  const defaults = { baseUrl: 'https://api.baorongxs.top', username: '', password: '', debugPort: 9230 };
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) }; } catch (_) { return defaults; }
}

function saveSettings() {
  atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function encryptSetting(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) return '';
  return safeStorage.encryptString(String(value)).toString('base64');
}

function decryptSetting(value) {
  try { return safeStorage.decryptString(Buffer.from(value, 'base64')); } catch (_) { return ''; }
}

function post(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('codexlink:host-message', payload);
}

function postLog(message, level = 'info') {
  post({ type: 'log', message: publicMessage(message), level });
}

function postStatus(text) {
  post({ type: 'status', text });
}

function postToast(message, error = false) {
  post({ type: 'toast', message: publicMessage(message), error });
}

function postProgress(label, percent, meta = '', indeterminate = false, done = false, error = false) {
  post({ type: 'progress', label, percent, meta, indeterminate, done, error });
}

function openExternal(url) {
  if (!isHttpUrl(url)) throw new Error('只能打开 HTTP 或 HTTPS 地址。');
  shell.openExternal(String(url));
}

function isHttpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(String(value)).protocol); } catch (_) { return false; }
}

function fileDataUrl(file, mime) {
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

module.exports = { compareVersions, escapeHtml, isHttpUrl };
