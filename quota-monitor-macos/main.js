const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  screen,
  shell
} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");

const APP_NAME = "Codex 周额度监控";
const APP_VERSION = "3.0.0";
const IS_MAC = process.platform === "darwin";
const REFRESH_MS = 2000;
const COLLAPSED = { width: 64, height: 64 };
const EXPANDED = { width: 290, height: 266 };
const WINDOW_MARGIN = 24;

let mainWindow = null;
let isExpanded = false;
let isPinned = false;
let expansionPlacement = null;
let dragState = null;
let usageWorker = null;
let resetVoucherAvailableCount = null;
let resetVoucherTimer = null;
let fetchingResetVouchers = false;
let isQuitting = false;
let snapshot = loadingSnapshot();

function loadingSnapshot() {
  return {
    ready: false,
    quota_available: false,
    quota_used_percent: null,
    quota_remaining_percent: null,
    reset_time: "--",
    reset_countdown: "--",
    reset_rule: "--",
    reset_count: null,
    reset_vouchers: null,
    today_tokens: 0,
    today_tokens_text: "--",
    total_tokens: 0,
    total_tokens_text: "--",
    chart: []
  };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function dateKey(timestampMs) {
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function compactTokens(value) {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2).replace(/\.?0+$/, "")}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return String(value);
}

function resetRule(windowMinutes) {
  if (windowMinutes % 1440 === 0) {
    return `每 ${windowMinutes / 1440} 天 · 1 次`;
  }
  if (windowMinutes % 60 === 0) {
    return `每 ${windowMinutes / 60} 小时 · 1 次`;
  }
  return `每 ${windowMinutes} 分钟 · 1 次`;
}

function resetTexts(resetAtSeconds) {
  if (!resetAtSeconds) {
    return { exact: "--", countdown: "--" };
  }
  const resetDate = new Date(resetAtSeconds * 1000);
  const exact = `${pad2(resetDate.getMonth() + 1)}月${pad2(resetDate.getDate())}日 ${pad2(resetDate.getHours())}:${pad2(resetDate.getMinutes())}`;
  const remainingMinutes = Math.floor((resetDate.getTime() - Date.now()) / 60000);
  if (remainingMinutes <= 0) {
    return { exact, countdown: "等待刷新" };
  }
  const days = Math.floor(remainingMinutes / 1440);
  const hours = Math.floor((remainingMinutes % 1440) / 60);
  const minutes = remainingMinutes % 60;
  if (days > 0) {
    return { exact, countdown: `${days}天 ${hours}时` };
  }
  if (hours > 0) {
    return { exact, countdown: `${hours}时 ${minutes}分` };
  }
  return { exact, countdown: `${Math.max(1, minutes)}分` };
}

function selectLongestLimit(rateLimits) {
  const candidates = ["primary", "secondary", "individual_limit"]
    .map((key) => {
      const value = rateLimits?.[key];
      return value && typeof value === "object" && Number.isFinite(value.window_minutes)
        ? { ...value, source: key }
        : null;
    })
    .filter(Boolean);
  if (!candidates.length) {
    return null;
  }
  return candidates.reduce((best, item) =>
    Number(item.window_minutes) > Number(best.window_minutes) ? item : best
  );
}

function parseResetVoucherAvailableCount(payload) {
  const value =
    payload?.available_count ??
    payload?.rateLimitResetCredits?.availableCount;
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : null;
}

function codexHomePath() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

async function fetchResetVoucherAvailableCount() {
  const authPath = path.join(codexHomePath(), "auth.json");
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch {
    return null;
  }
  const accessToken = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id;
  if (!accessToken || !accountId) {
    return null;
  }
  try {
    const response = await net.fetch(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "ChatGPT-Account-ID": accountId,
          "OpenAI-Beta": "codex-1",
          Accept: "application/json",
          "User-Agent": "CodexWeeklyMonitor/2.3"
        }
      }
    );
    if (!response.ok) {
      return null;
    }
    return parseResetVoucherAvailableCount(await response.json());
  } catch {
    return null;
  }
}

async function refreshResetVoucherAvailableCount() {
  if (fetchingResetVouchers) return;
  fetchingResetVouchers = true;
  try {
    const availableCount = await fetchResetVoucherAvailableCount();
    if (availableCount === null) return;
    resetVoucherAvailableCount = availableCount;
    snapshot = { ...snapshot, reset_vouchers: availableCount };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("monitor:snapshot", snapshot);
    }
  } finally {
    fetchingResetVouchers = false;
  }
}

function startResetVoucherPolling() {
  refreshResetVoucherAvailableCount();
  resetVoucherTimer = setInterval(refreshResetVoucherAvailableCount, 60000);
}

class SessionFile {
  constructor(filePath) {
    this.filePath = filePath;
    this.offset = 0;
    this.observedSize = -1;
    this.observedMtime = -1;
    this.previousTotal = 0;
    this.totalTokens = 0;
    this.dailyTokens = new Map();
    this.latestRate = null;
    this.latestEventMs = 0;
  }

  reset() {
    this.offset = 0;
    this.observedSize = -1;
    this.observedMtime = -1;
    this.previousTotal = 0;
    this.totalTokens = 0;
    this.dailyTokens = new Map();
    this.latestRate = null;
    this.latestEventMs = 0;
  }

  consume(object) {
    if (object?.type !== "event_msg" || object?.payload?.type !== "token_count") {
      return;
    }
    const payload = object.payload;
    const eventMs = Date.parse(object.timestamp) || Date.now();
    this.latestEventMs = Math.max(this.latestEventMs, eventMs);

    const total = payload?.info?.total_token_usage?.total_tokens;
    if (Number.isFinite(total)) {
      const current = Math.max(0, Math.trunc(total));
      const delta = current >= this.previousTotal ? current - this.previousTotal : current;
      this.previousTotal = current;
      if (delta > 0) {
        this.totalTokens += delta;
        const key = dateKey(eventMs);
        this.dailyTokens.set(key, (this.dailyTokens.get(key) || 0) + delta);
      }
    }

    const rateLimits = payload.rate_limits;
    const selected = selectLongestLimit(rateLimits);
    if (!selected || !Number.isFinite(selected.used_percent)) {
      return;
    }
    this.latestRate = {
      eventMs,
      usedPercent: Math.max(0, Math.min(100, Number(selected.used_percent))),
      windowMinutes: Math.max(1, Math.trunc(selected.window_minutes)),
      resetsAt: Number.isFinite(selected.resets_at) ? Math.trunc(selected.resets_at) : null
    };
  }

  update(stat) {
    if (stat.size < this.offset) {
      this.reset();
    }
    if (stat.size === this.observedSize && stat.mtimeMs === this.observedMtime) {
      return;
    }

    const length = stat.size - this.offset;
    if (length <= 0) {
      this.observedSize = stat.size;
      this.observedMtime = stat.mtimeMs;
      return;
    }

    const file = fs.openSync(this.filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(file, buffer, 0, length, this.offset);
      const chunk = buffer.subarray(0, bytesRead);
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        const complete = chunk.subarray(0, lastNewline + 1).toString("utf8");
        this.offset += lastNewline + 1;
        for (const line of complete.split("\n")) {
          if (!line.includes('"token_count"')) {
            continue;
          }
          try {
            this.consume(JSON.parse(line));
          } catch {
            // Ignore an individual malformed line; later data remains usable.
          }
        }
      }
    } finally {
      fs.closeSync(file);
    }
    this.observedSize = stat.size;
    this.observedMtime = stat.mtimeMs;
  }
}

class UsageIndex {
  constructor() {
    const codexHome = codexHomePath();
    this.roots = [
      path.join(codexHome, "sessions"),
      path.join(codexHome, "archived_sessions")
    ];
    this.files = new Map();
  }

  discover(directory, result) {
    if (!fs.existsSync(directory)) {
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        this.discover(fullPath, result);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        result.push(fullPath);
      }
    }
  }

  refresh() {
    const paths = [];
    for (const root of this.roots) {
      this.discover(root, paths);
    }
    const current = new Set(paths);
    for (const existing of this.files.keys()) {
      if (!current.has(existing)) {
        this.files.delete(existing);
      }
    }

    for (const filePath of paths) {
      try {
        const stat = fs.statSync(filePath);
        let state = this.files.get(filePath);
        if (!state) {
          state = new SessionFile(filePath);
          this.files.set(filePath, state);
        }
        state.update(stat);
      } catch {
        // A session can be moved to archives while scanning.
      }
    }
    return this.buildSnapshot();
  }

  buildSnapshot() {
    const daily = new Map();
    let totalTokens = 0;
    let latestRate = null;

    for (const state of this.files.values()) {
      totalTokens += state.totalTokens;
      for (const [key, value] of state.dailyTokens.entries()) {
        daily.set(key, (daily.get(key) || 0) + value);
      }
      if (
        state.latestRate &&
        (!latestRate || state.latestRate.eventMs > latestRate.eventMs)
      ) {
        latestRate = state.latestRate;
      }
    }

    const today = new Date();
    const chart = [];
    for (let daysAgo = 6; daysAgo >= 0; daysAgo -= 1) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, 12);
      const key = dateKey(day.getTime());
      const tokens = daily.get(key) || 0;
      chart.push({
        date: key,
        tokens,
        text: compactTokens(tokens),
        today: daysAgo === 0
      });
    }

    const todayTokens = daily.get(dateKey(Date.now())) || 0;
    const result = {
      ready: true,
      quota_available: Boolean(latestRate),
      quota_used_percent: null,
      quota_remaining_percent: null,
      reset_time: "--",
      reset_countdown: "--",
      reset_rule: "--",
      reset_count: null,
      reset_vouchers: null,
      today_tokens: todayTokens,
      today_tokens_text: compactTokens(todayTokens),
      total_tokens: totalTokens,
      total_tokens_text: compactTokens(totalTokens),
      chart
    };

    if (latestRate) {
      const reset = resetTexts(latestRate.resetsAt);
      result.quota_used_percent = Math.round(latestRate.usedPercent * 10) / 10;
      result.quota_remaining_percent =
        Math.round((100 - latestRate.usedPercent) * 10) / 10;
      result.reset_time = reset.exact;
      result.reset_countdown = reset.countdown;
      result.reset_rule = resetRule(latestRate.windowMinutes);
      result.reset_count = 1;
    }
    return result;
  }
}

function startUsageWorker() {
  const workerSource = `
    const { parentPort } = require("worker_threads");
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const REFRESH_MS = ${REFRESH_MS};
    ${loadingSnapshot.toString()}
    ${pad2.toString()}
    ${dateKey.toString()}
    ${compactTokens.toString()}
    ${resetRule.toString()}
    ${resetTexts.toString()}
    ${selectLongestLimit.toString()}
    ${codexHomePath.toString()}
    ${SessionFile.toString()}
    ${UsageIndex.toString()}
    const usageIndex = new UsageIndex();
    function tick() {
      try {
        parentPort.postMessage(usageIndex.refresh());
      } catch {
        // Retry on the next interval while keeping the last UI snapshot.
      }
    }
    tick();
    const timer = setInterval(tick, REFRESH_MS);
    parentPort.on("message", (message) => {
      if (message === "stop") {
        clearInterval(timer);
        process.exit(0);
      }
    });
  `;

  usageWorker = new Worker(workerSource, { eval: true });
  usageWorker.on("message", (nextSnapshot) => {
    snapshot = {
      ...nextSnapshot,
      reset_vouchers: resetVoucherAvailableCount
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("monitor:snapshot", snapshot);
    }
  });
  usageWorker.on("error", () => {
    // Keep the last valid snapshot. The window remains fully interactive.
  });
}

function defaultBounds(size) {
  const area = screen.getPrimaryDisplay().workArea;
  const qaPositionLeft = process.argv.includes("--qa-position-left");
  return {
    x: qaPositionLeft
      ? area.x + 180
      : area.x + area.width - size.width - WINDOW_MARGIN,
    y: qaPositionLeft
      ? area.y + 300
      : area.y + Math.min(110, Math.max(0, area.height - size.height - WINDOW_MARGIN)),
    width: size.width,
    height: size.height
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, maximum));
}

function chooseExpansionPlacement(collapsed, area) {
  const areaRight = area.x + area.width;
  const areaBottom = area.y + area.height;
  const collapsedRight = collapsed.x + COLLAPSED.width;
  const collapsedBottom = collapsed.y + COLLAPSED.height;
  const canOpenRight = collapsed.x + EXPANDED.width <= areaRight;
  const canOpenLeft = collapsedRight - EXPANDED.width >= area.x;
  const canOpenDown = collapsed.y + EXPANDED.height <= areaBottom;
  const canOpenUp = collapsedBottom - EXPANDED.height >= area.y;

  let horizontal;
  if (canOpenRight && !canOpenLeft) horizontal = "right";
  else if (canOpenLeft && !canOpenRight) horizontal = "left";
  else if (canOpenRight && canOpenLeft) {
    horizontal =
      collapsed.x + COLLAPSED.width / 2 <= area.x + area.width / 2 ? "right" : "left";
  } else {
    const roomRight = areaRight - collapsed.x;
    const roomLeft = collapsedRight - area.x;
    horizontal = roomRight >= roomLeft ? "right" : "left";
  }

  let vertical;
  if (canOpenDown && !canOpenUp) vertical = "down";
  else if (canOpenUp && !canOpenDown) vertical = "up";
  else if (canOpenDown && canOpenUp) {
    vertical =
      collapsed.y + COLLAPSED.height / 2 <= area.y + area.height / 2 ? "down" : "up";
  } else {
    const roomDown = areaBottom - collapsed.y;
    const roomUp = collapsedBottom - area.y;
    vertical = roomDown >= roomUp ? "down" : "up";
  }

  const desiredX =
    horizontal === "right" ? collapsed.x : collapsedRight - EXPANDED.width;
  const desiredY =
    vertical === "down" ? collapsed.y : collapsedBottom - EXPANDED.height;

  return {
    horizontal,
    vertical,
    collapsedBounds: { ...collapsed, width: COLLAPSED.width, height: COLLAPSED.height },
    expandedBounds: {
      x: clamp(desiredX, area.x, Math.max(area.x, areaRight - EXPANDED.width)),
      y: clamp(desiredY, area.y, Math.max(area.y, areaBottom - EXPANDED.height)),
      width: EXPANDED.width,
      height: EXPANDED.height
    }
  };
}

function updateCollapsedAnchorFromExpanded(expandedBounds, area) {
  if (!expansionPlacement) return;
  const areaRight = area.x + area.width;
  const areaBottom = area.y + area.height;
  const x =
    expansionPlacement.horizontal === "right"
      ? expandedBounds.x
      : expandedBounds.x + EXPANDED.width - COLLAPSED.width;
  const y =
    expansionPlacement.vertical === "down"
      ? expandedBounds.y
      : expandedBounds.y + EXPANDED.height - COLLAPSED.height;
  expansionPlacement.collapsedBounds = {
    x: clamp(x, area.x, Math.max(area.x, areaRight - COLLAPSED.width)),
    y: clamp(y, area.y, Math.max(area.y, areaBottom - COLLAPSED.height)),
    width: COLLAPSED.width,
    height: COLLAPSED.height
  };
}

function setExpanded(next) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, expanded: isExpanded };
  }
  next = Boolean(next);
  if (next === isExpanded) {
    return {
      ok: true,
      expanded: isExpanded,
      horizontal: expansionPlacement?.horizontal || null,
      vertical: expansionPlacement?.vertical || null
    };
  }

  if (next) {
    const collapsed = mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({
      x: collapsed.x + Math.floor(COLLAPSED.width / 2),
      y: collapsed.y + Math.floor(COLLAPSED.height / 2)
    });
    expansionPlacement = chooseExpansionPlacement(collapsed, display.workArea);
    mainWindow.setBounds(expansionPlacement.expandedBounds, false);
    isExpanded = true;
  } else {
    const target = expansionPlacement?.collapsedBounds || mainWindow.getBounds();
    mainWindow.setBounds(
      {
        x: target.x,
        y: target.y,
        width: COLLAPSED.width,
        height: COLLAPSED.height
      },
      false
    );
    isExpanded = false;
  }

  const result = {
    ok: true,
    expanded: isExpanded,
    horizontal: expansionPlacement?.horizontal || null,
    vertical: expansionPlacement?.vertical || null
  };
  if (!next) expansionPlacement = null;
  return result;
}

function updatePinMenuItem() {
  const pinItem = Menu.getApplicationMenu()?.getMenuItemById("monitor-pin");
  if (pinItem) pinItem.checked = isPinned;
}

function sendAppCommand(command, payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("app:command", command, payload);
}

function showMonitor({ expand = false, activate = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (expand) setExpanded(true);
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (activate) {
    mainWindow.show();
    app.focus({ steal: true });
  } else {
    mainWindow.showInactive();
  }
  mainWindow.moveTop();
}

function openSettingsFromMenu() {
  showMonitor({ expand: true });
  sendAppCommand("open-settings");
}

function setPinnedState(pinned, { notifyRenderer = true } = {}) {
  isPinned = Boolean(pinned);
  updatePinMenuItem();
  if (isPinned) {
    showMonitor({ expand: true, activate: false });
  }
  if (notifyRenderer) {
    sendAppCommand("set-pinned", { pinned: isPinned });
  }
  return isPinned;
}

function revealCodexData() {
  const codexHome = codexHomePath();
  const authPath = path.join(codexHome, "auth.json");
  if (fs.existsSync(authPath)) {
    shell.showItemInFolder(authPath);
    return;
  }
  if (fs.existsSync(codexHome)) {
    shell.openPath(codexHome);
    return;
  }
  dialog.showMessageBox({
    type: "info",
    title: "未找到 Codex 数据目录",
    message: "尚未找到本机 Codex 数据",
    detail: `应用会读取：${codexHome}\n请先在 Codex 中完成登录并产生一次会话。`,
    buttons: ["好"]
  });
}

function showDataAndPrivacyInfo() {
  dialog.showMessageBox({
    type: "info",
    title: "数据与隐私",
    message: "Codex 周额度监控只读取本机 Codex 数据",
    detail:
      "应用读取 ~/.codex/sessions、archived_sessions 与 auth.json。登录令牌仅用于向 chatgpt.com 查询重置券数量，不会发送给界面、写入日志或另行保存。",
    buttons: ["好"]
  });
}

function buildApplicationMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: "about", label: `关于${APP_NAME}` },
        { type: "separator" },
        {
          label: "设置…",
          accelerator: "CommandOrControl+,",
          click: openSettingsFromMenu
        },
        { type: "separator" },
        { role: "services", label: "服务", submenu: [] },
        { type: "separator" },
        { role: "hide", label: `隐藏${APP_NAME}` },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "全部显示" },
        { type: "separator" },
        { role: "quit", label: `退出${APP_NAME}` }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "拷贝" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" }
      ]
    },
    {
      label: "显示",
      submenu: [
        {
          label: "显示监控窗口",
          accelerator: "CommandOrControl+Shift+M",
          click: () => showMonitor({ expand: true })
        },
        {
          id: "monitor-pin",
          label: "固定展开面板",
          type: "checkbox",
          checked: isPinned,
          click: (item) => setPinnedState(item.checked)
        },
        { type: "separator" },
        {
          label: "在 Finder 中显示 Codex 数据",
          click: revealCodexData
        }
      ]
    },
    {
      label: "窗口",
      submenu: [
        {
          label: "将监控窗口移到前面",
          click: () => showMonitor({ activate: true })
        }
      ]
    },
    {
      role: "help",
      label: "帮助",
      submenu: [
        {
          label: "数据与隐私",
          click: showDataAndPrivacyInfo
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle("monitor:get-snapshot", () => snapshot);
  ipcMain.handle("window:set-expanded", (_event, expanded) => {
    if (isPinned && !expanded) {
      return { ok: true, expanded: true };
    }
    return setExpanded(expanded);
  });
  ipcMain.handle("window:set-pinned", (_event, pinned) => {
    setPinnedState(pinned, { notifyRenderer: false });
    return { ok: true, pinned: isPinned };
  });
  ipcMain.handle("window:set-opacity", (_event, opacity) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { ok: false, opacity: 1 };
    }
    const normalized = clamp(Number(opacity) || 1, 0.35, 1);
    mainWindow.setOpacity(normalized);
    return { ok: true, opacity: normalized };
  });
  ipcMain.handle("window:drag-start", (_event, point) => {
    if (!mainWindow || !Number.isFinite(point?.screenX) || !Number.isFinite(point?.screenY)) {
      return { ok: false };
    }
    const bounds = mainWindow.getBounds();
    dragState = {
      offsetX: point.screenX - bounds.x,
      offsetY: point.screenY - bounds.y
    };
    return { ok: true };
  });
  ipcMain.on("window:drag-move", (_event, point) => {
    if (
      !mainWindow ||
      !dragState ||
      !Number.isFinite(point?.screenX) ||
      !Number.isFinite(point?.screenY)
    ) {
      return;
    }
    const display = screen.getDisplayNearestPoint({ x: point.screenX, y: point.screenY });
    const area = display.workArea;
    const size = isExpanded ? EXPANDED : COLLAPSED;
    const x = clamp(
      Math.round(point.screenX - dragState.offsetX),
      area.x,
      Math.max(area.x, area.x + area.width - size.width)
    );
    const y = clamp(
      Math.round(point.screenY - dragState.offsetY),
      area.y,
      Math.max(area.y, area.y + area.height - size.height)
    );
    mainWindow.setPosition(x, y, false);
    if (isExpanded) {
      updateCollapsedAnchorFromExpanded(
        { x, y, width: EXPANDED.width, height: EXPANDED.height },
        area
      );
    } else {
      expansionPlacement = null;
    }
  });
  ipcMain.on("window:drag-end", () => {
    dragState = null;
  });
  ipcMain.on("window:quit", () => app.quit());
}

function createWindow() {
  const startExpanded =
    process.argv.includes("--expanded") ||
    process.argv.includes("--qa-capture-expanded") ||
    process.argv.includes("--qa-capture-settings");
  isExpanded = startExpanded;
  const size = startExpanded ? EXPANDED : COLLAPSED;
  const bounds = defaultBounds(size);
  mainWindow = new BrowserWindow({
    ...bounds,
    title: APP_NAME,
    icon: path.join(__dirname, "build", IS_MAC ? "icon.png" : "icon.ico"),
    type: IS_MAC ? "panel" : undefined,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    thickFrame: false,
    roundedCorners: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: !IS_MAC,
    acceptFirstMouse: IS_MAC,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  const windowLevel = IS_MAC ? "floating" : "screen-saver";
  mainWindow.setAlwaysOnTop(true, windowLevel);
  if (IS_MAC) {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setHiddenInMissionControl(true);
  }
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"), {
    hash: startExpanded ? "expanded" : ""
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow.showInactive();
    mainWindow.setAlwaysOnTop(true, windowLevel);
    mainWindow.moveTop();
    const captureCollapsed = process.argv.includes("--qa-capture");
    const captureExpanded = process.argv.includes("--qa-capture-expanded");
    const captureSettings = process.argv.includes("--qa-capture-settings");
    if (captureCollapsed || captureExpanded || captureSettings) {
      setTimeout(async () => {
        if (captureSettings) {
          await mainWindow.webContents.executeJavaScript(`openSettings();`);
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(
          path.join(
            os.tmpdir(),
            captureSettings
              ? "Codex周额度监控_Electron_设置页面.png"
              : captureExpanded
                ? "Codex周额度监控_Electron_展开页面.png"
                : "Codex周额度监控_Electron_页面.png"
          ),
          image.toPNG()
        );
        app.quit();
      }, 2500);
    }
    if (process.argv.includes("--qa-self-test")) {
      setTimeout(runInteractionSelfTest, 2500);
    }
  });
  mainWindow.on("close", (event) => {
    if (IS_MAC && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function runInteractionSelfTest() {
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const reportPath = path.join(os.tmpdir(), "Codex周额度监控_Electron_交互验收.json");
  const report = { startedAt: new Date().toISOString() };
  const samePosition = (first, second) => first.x === second.x && first.y === second.y;
  try {
    await mainWindow.webContents.executeJavaScript(`qaMode = true;`);
    for (let attempt = 0; attempt < 20 && snapshot.reset_vouchers === null; attempt += 1) {
      await wait(250);
    }
    report.liveResetVoucherCount = snapshot.reset_vouchers;
    report.liveResetVoucherRequired = process.argv.includes("--qa-require-live-network");
    report.liveResetVoucherFetched =
      snapshot.reset_vouchers !== null &&
      snapshot.reset_vouchers !== undefined &&
      Number.isFinite(Number(snapshot.reset_vouchers)) &&
      Number(snapshot.reset_vouchers) >= 0;
    const initial = mainWindow.getBounds();
    report.rightInitial = initial;

    await mainWindow.webContents.executeJavaScript(
      `document.getElementById("collapsed-orb").dispatchEvent(new MouseEvent("mouseenter", {bubbles:false}));`
    );
    await wait(800);
    report.rightExpanded = mainWindow.getBounds();
    report.rightHoverExpanded =
      report.rightExpanded.width === EXPANDED.width &&
      report.rightExpanded.height === EXPANDED.height;
    report.rightEdgeAnchored =
      report.rightExpanded.x + EXPANDED.width === initial.x + COLLAPSED.width;

    await mainWindow.webContents.executeJavaScript(
      `document.getElementById("expanded-panel").dispatchEvent(new MouseEvent("mouseleave", {bubbles:false}));`
    );
    await wait(700);
    report.rightCollapsed = mainWindow.getBounds();
    report.rightReturnedExactly =
      samePosition(report.rightCollapsed, initial) &&
      report.rightCollapsed.width === COLLAPSED.width &&
      report.rightCollapsed.height === COLLAPSED.height;

    const area = screen.getDisplayNearestPoint({
      x: initial.x + Math.floor(COLLAPSED.width / 2),
      y: initial.y + Math.floor(COLLAPSED.height / 2)
    }).workArea;
    const leftInitial = {
      x: area.x + 16,
      y: clamp(initial.y, area.y, area.y + area.height - COLLAPSED.height),
      width: COLLAPSED.width,
      height: COLLAPSED.height
    };
    mainWindow.setBounds(leftInitial, false);
    report.leftInitial = mainWindow.getBounds();
    report.stateBeforeLeftHover = await mainWindow.webContents.executeJavaScript(
      `({ expanded, dragging, pinned, bodyExpanded: document.body.classList.contains("expanded") })`
    );

    await mainWindow.webContents.executeJavaScript(
      `document.getElementById("collapsed-orb").dispatchEvent(new MouseEvent("mouseenter", {bubbles:false}));`
    );
    report.stateAfterLeftEnter = await mainWindow.webContents.executeJavaScript(
      `({ expanded, dragging, pinned, bodyExpanded: document.body.classList.contains("expanded") })`
    );
    await wait(800);
    report.leftExpanded = mainWindow.getBounds();
    report.stateAfterLeftWait = await mainWindow.webContents.executeJavaScript(
      `({ expanded, dragging, pinned, bodyExpanded: document.body.classList.contains("expanded") })`
    );
    report.leftHoverExpanded =
      report.leftExpanded.width === EXPANDED.width &&
      report.leftExpanded.height === EXPANDED.height;
    report.leftEdgeAnchored = report.leftExpanded.x === report.leftInitial.x;

    await mainWindow.webContents.executeJavaScript(
      `document.getElementById("expanded-panel").dispatchEvent(new MouseEvent("mouseleave", {bubbles:false}));`
    );
    await wait(700);
    report.leftCollapsed = mainWindow.getBounds();
    report.leftReturnedExactly =
      samePosition(report.leftCollapsed, report.leftInitial) &&
      report.leftCollapsed.width === COLLAPSED.width &&
      report.leftCollapsed.height === COLLAPSED.height;

    const dragStart = report.leftCollapsed;
    const startX = dragStart.x + Math.floor(COLLAPSED.width / 2);
    const startY = dragStart.y + Math.floor(COLLAPSED.height / 2);
    await mainWindow.webContents.executeJavaScript(
      `document.getElementById("collapsed-orb").dispatchEvent(new MouseEvent("mousedown", {bubbles:true,button:0,screenX:${startX},screenY:${startY}}));`
    );
    await wait(120);
    await mainWindow.webContents.executeJavaScript(
      `document.dispatchEvent(new MouseEvent("mousemove", {bubbles:true,button:0,screenX:${startX + 120},screenY:${startY + 70}}));`
    );
    await wait(120);
    await mainWindow.webContents.executeJavaScript(
      `document.dispatchEvent(new MouseEvent("mouseup", {bubbles:true,button:0,screenX:${startX + 120},screenY:${startY + 70}}));`
    );
    await wait(250);
    report.afterDrag = mainWindow.getBounds();
    report.dragMoved =
      Math.abs(report.afterDrag.x - dragStart.x) >= 100 &&
      Math.abs(report.afterDrag.y - dragStart.y) >= 50;

    const originalOpacity = mainWindow.getOpacity();
    const originalStoredOpacity = await mainWindow.webContents.executeJavaScript(
      `localStorage.getItem("monitor-opacity")`
    );
    await mainWindow.webContents.executeJavaScript(
      `document.getElementById("collapsed-orb").dispatchEvent(new MouseEvent("contextmenu", {bubbles:true,button:2}));`
    );
    await wait(700);
    const settingsBounds = mainWindow.getBounds();
    const settingsState = await mainWindow.webContents.executeJavaScript(
      `({
        settingsOpen,
        settingsVisible: !document.getElementById("settings-view").hidden,
        dashboardHidden: document.getElementById("dashboard-view").hidden,
        opacityLabel: document.getElementById("opacity-value").textContent
      })`
    );
    report.rightClickOpenedSettings =
      settingsBounds.width === EXPANDED.width &&
      settingsBounds.height === EXPANDED.height &&
      settingsState.settingsOpen &&
      settingsState.settingsVisible &&
      settingsState.dashboardHidden;

    const opacityState = await mainWindow.webContents.executeJavaScript(
      `(function(){
        const slider = document.getElementById("opacity-slider");
        slider.value = "55";
        slider.dispatchEvent(new Event("input", {bubbles:true}));
        slider.dispatchEvent(new Event("change", {bubbles:true}));
        return {
          value: slider.value,
          label: document.getElementById("opacity-value").textContent,
          stored: localStorage.getItem("monitor-opacity")
        };
      })()`
    );
    await wait(150);
    report.opacitySettingApplied =
      opacityState.value === "55" &&
      opacityState.label === "55%" &&
      opacityState.stored === "55" &&
      Math.abs(mainWindow.getOpacity() - 0.55) < 0.02;

    const resetCopy = await mainWindow.webContents.executeJavaScript(
      `(function(){
        render({
          quota_available: true,
          quota_remaining_percent: 80,
          reset_time: "08月05日 08:00",
          reset_countdown: "6天 17时",
          reset_rule: "每 7 天 · 1 次",
          reset_count: 1,
          reset_vouchers: 3,
          today_tokens_text: "--",
          total_tokens_text: "--",
          chart: []
        });
        const cards = Array.from(document.querySelectorAll(".reset-grid .info-card"));
        const labelNodes = Array.from(document.querySelectorAll(".reset-grid .info-label"));
        const valueNodes = Array.from(document.querySelectorAll(".reset-grid .info-value"));
        const labels = Array.from(document.querySelectorAll(".reset-grid .info-label")).map(node => node.textContent);
        return {
          labels,
          countdown: document.querySelector("#reset-countdown span").textContent,
          count: document.getElementById("reset-count-value").textContent,
          vouchers: document.getElementById("reset-voucher-value").textContent,
          cardHeights: cards.map(node => node.getBoundingClientRect().height),
          labelTops: labelNodes.map(node => node.getBoundingClientRect().top),
          labelBottoms: labelNodes.map(node => node.getBoundingClientRect().bottom),
          valueTops: valueNodes.map(node => node.getBoundingClientRect().top),
          labelFontSizes: labelNodes.map(node => getComputedStyle(node).fontSize),
          labelLineHeights: labelNodes.map(node => getComputedStyle(node).lineHeight),
          labelFontWeights: labelNodes.map(node => getComputedStyle(node).fontWeight),
          labelFontFamilies: labelNodes.map(node => getComputedStyle(node).fontFamily),
          valueFontSizes: valueNodes.map(node => getComputedStyle(node).fontSize),
          valueLineHeights: valueNodes.map(node => getComputedStyle(node).lineHeight),
          valueFontWeights: valueNodes.map(node => getComputedStyle(node).fontWeight),
          valueFontFamilies: valueNodes.map(node => getComputedStyle(node).fontFamily)
        };
      })()`
    );
    report.resetValuesClear =
      resetCopy.labels[0] === "距离下次重置" &&
      resetCopy.labels[1] === "重置次数 / 重置券" &&
      resetCopy.countdown === "6天 17时" &&
      resetCopy.count === "1 次" &&
      resetCopy.vouchers === "3 张";
    report.resetVoucherParser =
      parseResetVoucherAvailableCount({ available_count: 2 }) === 2 &&
      parseResetVoucherAvailableCount({
        rateLimitResetCredits: { availableCount: 3 }
      }) === 3 &&
      parseResetVoucherAvailableCount({}) === null;
    report.resetTypographyAligned =
      resetCopy.cardHeights[0] === resetCopy.cardHeights[1] &&
      resetCopy.labelTops[0] === resetCopy.labelTops[1] &&
      resetCopy.valueTops[0] === resetCopy.valueTops[1] &&
      resetCopy.valueTops.every((value, index) => value - resetCopy.labelBottoms[index] <= 1) &&
      resetCopy.labelFontSizes.every(value => value === "11px") &&
      resetCopy.labelLineHeights.every(value => value === "15px") &&
      resetCopy.valueFontSizes.every(value => value === "11px") &&
      resetCopy.valueLineHeights.every(value => value === "15px") &&
      resetCopy.labelFontWeights.every(value => value === "600") &&
      resetCopy.valueFontWeights.every(value => value === "600") &&
      resetCopy.labelFontFamilies.every((value, index) => value === resetCopy.valueFontFamilies[index]);

    await mainWindow.webContents.executeJavaScript(
      `(function(){
        const slider = document.getElementById("opacity-slider");
        slider.value = "${Math.round(originalOpacity * 100)}";
        slider.dispatchEvent(new Event("input", {bubbles:true}));
        if (${JSON.stringify(originalStoredOpacity)} === null) {
          localStorage.removeItem("monitor-opacity");
        } else {
          localStorage.setItem("monitor-opacity", ${JSON.stringify(originalStoredOpacity)});
        }
        document.getElementById("settings-close-btn").click();
      })()`
    );
    await wait(700);
    const settingsClosedState = await mainWindow.webContents.executeJavaScript(
      `({
        settingsOpen,
        settingsHidden: document.getElementById("settings-view").hidden,
        dashboardVisible: !document.getElementById("dashboard-view").hidden
      })`
    );
    report.settingsClosed =
      !settingsClosedState.settingsOpen &&
      settingsClosedState.settingsHidden &&
      settingsClosedState.dashboardVisible &&
      mainWindow.getBounds().width === COLLAPSED.width &&
      mainWindow.getBounds().height === COLLAPSED.height;

    const colorCases = [
      { name: "loading", remaining: null, hex: "#10b981", rgb: "rgb(16,185,129)" },
      { name: "normal", remaining: 80, hex: "#10b981", rgb: "rgb(16,185,129)" },
      { name: "warning", remaining: 20, hex: "#f59e0b", rgb: "rgb(245,158,11)" },
      { name: "danger", remaining: 4, hex: "#f43f5e", rgb: "rgb(244,63,94)" }
    ];
    report.colors = {};
    const colorChecks = [];
    for (const testCase of colorCases) {
      const payload = {
        quota_available: testCase.remaining !== null,
        quota_remaining_percent: testCase.remaining,
        reset_countdown: "--",
        reset_rule: "--",
        reset_count: null,
        reset_vouchers: null,
        today_tokens_text: "--",
        total_tokens_text: "--",
        chart: []
      };
      const state = await mainWindow.webContents.executeJavaScript(
        `(function(){
          render(${JSON.stringify(payload)});
          return {
            root: getComputedStyle(document.documentElement).getPropertyValue("--quota-color").trim(),
            ring: document.getElementById("orb-progress").getAttribute("stroke"),
            text: getComputedStyle(document.getElementById("orb-percent-text")).color.replace(/\\s/g, ""),
            bar: getComputedStyle(document.getElementById("weekly-progress-bar")).backgroundColor.replace(/\\s/g, "")
          };
        })()`
      );
      report.colors[testCase.name] = state;
      colorChecks.push(
        String(state.root).toLowerCase() === testCase.hex &&
        String(state.ring).toLowerCase() === testCase.hex &&
        String(state.text).toLowerCase() === testCase.rgb &&
        String(state.bar).toLowerCase() === testCase.rgb
      );
    }
    report.colorsSynchronized = colorChecks.every(Boolean);

    report.passed =
      report.rightHoverExpanded &&
      report.rightEdgeAnchored &&
      report.rightReturnedExactly &&
      report.leftHoverExpanded &&
      report.leftEdgeAnchored &&
      report.leftReturnedExactly &&
      report.dragMoved &&
      report.rightClickOpenedSettings &&
      report.opacitySettingApplied &&
      report.resetValuesClear &&
      report.resetVoucherParser &&
      (!report.liveResetVoucherRequired || report.liveResetVoucherFetched) &&
      report.resetTypographyAligned &&
      report.settingsClosed &&
      report.colorsSynchronized;
  } catch (error) {
    report.passed = false;
    report.error = error?.stack || String(error);
  } finally {
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.webContents.executeJavaScript(`qaMode = false;`).catch(() => {});
    }
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  app.quit();
}

app.setName(APP_NAME);
if (!IS_MAC) {
  app.setAppUserModelId("com.codexweeklymonitor.macos");
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMonitor({ expand: true }));
  app.whenReady().then(() => {
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: APP_VERSION,
      version: APP_VERSION,
      copyright: "Copyright © 2026 Codex 周额度监控"
    });
    registerIpc();
    buildApplicationMenu();
    createWindow();
    startUsageWorker();
    startResetVoucherPolling();
  });
}

app.on("activate", () => showMonitor({ activate: true }));
app.on("window-all-closed", () => {
  if (!IS_MAC) app.quit();
});
app.on("before-quit", () => {
  isQuitting = true;
  if (resetVoucherTimer) {
    clearInterval(resetVoucherTimer);
    resetVoucherTimer = null;
  }
  if (usageWorker) {
    usageWorker.postMessage("stop");
    usageWorker.terminate();
    usageWorker = null;
  }
});
