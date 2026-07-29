(() => {
  const NODE_ID = 'codex-launcher-context-bar';
  const STYLE_ID = 'codex-launcher-context-bar-style';
  const OWNER = 'mac-composer-realtime-v3';
  const POLL_MS = 1600;

  window.__codexLauncherContextState = window.__codexLauncherContextState || {
    available: false,
    used: 0,
    limit: 0,
    threadId: '',
    requestPending: false,
    lastRealtimeAt: 0
  };
  const state = window.__codexLauncherContextState;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function ensureStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent =
      '#' + NODE_ID + '{position:fixed!important;z-index:2147483645!important;' +
      'top:auto!important;bottom:12px!important;left:50%!important;right:auto!important;' +
      'transform:translate3d(-50%,0,0)!important;width:176px!important;min-width:0!important;' +
      'max-width:176px!important;height:26px!important;padding:3px 7px!important;box-sizing:border-box!important;' +
      'border:1px solid rgba(60,60,67,.18)!important;border-radius:7px!important;' +
      'background:rgba(250,250,252,.94)!important;box-shadow:0 2px 9px rgba(0,0,0,.13)!important;' +
      'display:grid!important;grid-template-columns:1fr auto!important;grid-template-rows:11px 4px!important;' +
      'column-gap:6px!important;row-gap:2px!important;align-content:center!important;' +
      'contain:layout paint style!important;color:#3a3a3c!important;' +
      'font:600 10px/11px -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif!important;' +
      'letter-spacing:0!important;white-space:normal!important;user-select:none!important;pointer-events:none!important;' +
      'visibility:visible!important;opacity:1!important}' +
      '#' + NODE_ID + ' .cl-ctx-label{display:block!important;overflow:hidden!important;text-overflow:ellipsis!important;' +
      'white-space:nowrap!important;color:#6e6e73!important}' +
      '#' + NODE_ID + ' .cl-ctx-value{display:block!important;min-width:0!important;white-space:nowrap!important;' +
      'text-align:right!important;color:#248a3d!important;font-size:10px!important;font-weight:700!important}' +
      '#' + NODE_ID + ' .cl-ctx-track{display:block!important;grid-column:1/3!important;position:relative!important;' +
      'height:4px!important;min-width:0!important;border-radius:999px!important;' +
      'background:rgba(120,120,128,.22)!important;overflow:hidden!important}' +
      '#' + NODE_ID + ' .cl-ctx-fill{display:block!important;position:absolute!important;inset:0 auto 0 0!important;' +
      'width:0;border-radius:inherit!important;background:#30d158!important;transition:background-color .18s ease!important}' +
      '#' + NODE_ID + '[data-level="warn"] .cl-ctx-value{color:#a05a00!important}' +
      '#' + NODE_ID + '[data-level="warn"] .cl-ctx-fill{background:#ffd60a!important}' +
      '#' + NODE_ID + '[data-level="critical"] .cl-ctx-value{color:#d70015!important}' +
      '#' + NODE_ID + '[data-level="critical"] .cl-ctx-fill{background:#ff453a!important}' +
      '#' + NODE_ID + '[data-available="false"] .cl-ctx-value{color:#6e6e73!important}' +
      '#' + NODE_ID + '[data-available="false"] .cl-ctx-fill{width:0!important;background:#8e8e93!important}' +
      '@media(prefers-color-scheme:dark){#' + NODE_ID + '{background:rgba(44,44,46,.94)!important;' +
      'border-color:rgba(255,255,255,.16)!important;box-shadow:0 2px 9px rgba(0,0,0,.30)!important;' +
      'color:#f2f2f7!important}#' + NODE_ID + ' .cl-ctx-label,#' + NODE_ID +
      '[data-available="false"] .cl-ctx-value{color:#aeaeb2!important}' +
      '#' + NODE_ID + ' .cl-ctx-track{background:rgba(174,174,178,.24)!important}}';
  }

  function rebuildNode(node) {
    node.setAttribute('data-owner', OWNER);
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    node.innerHTML =
      '<span class="cl-ctx-label">上下文</span>' +
      '<span class="cl-ctx-value">剩余 --%</span>' +
      '<span class="cl-ctx-track"><span class="cl-ctx-fill"></span></span>';
  }

  function ensureNode() {
    ensureStyle();
    let node = document.getElementById(NODE_ID);
    if (!node) {
      node = document.createElement('div');
      node.id = NODE_ID;
      rebuildNode(node);
      (document.body || document.documentElement).appendChild(node);
    } else if (node.getAttribute('data-owner') !== OWNER) {
      rebuildNode(node);
    }
    return node;
  }

  function remainingPercent() {
    if (!state.available || state.limit <= 0) return null;
    return clamp(Math.round(((state.limit - state.used) / state.limit) * 100), 0, 100);
  }

  function setText(node, selector, text) {
    const target = node.querySelector(selector);
    if (target && target.textContent !== text) target.textContent = text;
  }

  function render() {
    const node = ensureNode();
    const remaining = remainingPercent();
    const available = remaining != null;
    node.setAttribute('data-available', available ? 'true' : 'false');
    node.setAttribute(
      'data-level',
      !available ? 'unknown' : (remaining <= 10 ? 'critical' : (remaining <= 25 ? 'warn' : 'ok'))
    );

    if (!available) {
      setText(node, '.cl-ctx-value', '剩余 --%');
      const fill = node.querySelector('.cl-ctx-fill');
      if (fill && fill.style.width !== '0%') fill.style.width = '0%';
      node.title = '当前任务暂无上下文用量';
      return;
    }

    setText(node, '.cl-ctx-value', '剩余 ' + remaining + '%');
    const fill = node.querySelector('.cl-ctx-fill');
    if (fill) {
      const width = remaining + '%';
      if (fill.style.width !== width) fill.style.width = width;
    }
    node.title = '上下文已用 ' + (100 - remaining) + '%，剩余 ' + remaining + '%';
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 240 || rect.height < 18 || rect.top < window.innerHeight * 0.35) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  }

  function findComposerAnchor() {
    const editors = document.querySelectorAll('textarea,[contenteditable="true"]');
    let anchor = null;
    let bestScore = -Infinity;
    for (let i = 0; i < editors.length; i++) {
      const editor = editors[i];
      if (!isVisible(editor)) continue;
      const rect = editor.getBoundingClientRect();
      const score = rect.bottom * 3 + Math.min(rect.width, 1200);
      if (score > bestScore) {
        bestScore = score;
        anchor = {
          center: rect.left + rect.width / 2,
          bottom: rect.bottom
        };
      }
    }
    return anchor;
  }

  function alignBelowComposer() {
    const node = ensureNode();
    const detected = findComposerAnchor();
    const center = clamp(
      detected == null ? window.innerWidth / 2 : detected.center,
      96,
      Math.max(96, window.innerWidth - 96)
    );
    const previous = Number(node.getAttribute('data-center-x'));
    if (!isFinite(previous) || Math.abs(previous - center) >= 4) {
      const rounded = Math.round(center);
      node.style.setProperty('left', rounded + 'px', 'important');
      node.setAttribute('data-center-x', String(rounded));
    }

    const desiredTop = detected == null ? null : Math.round(detected.bottom + 6);
    if (desiredTop != null && desiredTop + 26 <= window.innerHeight - 8) {
      const previousTop = Number(node.getAttribute('data-top-y'));
      if (!isFinite(previousTop) || Math.abs(previousTop - desiredTop) >= 4) {
        node.style.setProperty('top', desiredTop + 'px', 'important');
        node.style.setProperty('bottom', 'auto', 'important');
        node.setAttribute('data-top-y', String(desiredTop));
      }
    } else {
      node.style.setProperty('top', 'auto', 'important');
      node.style.setProperty('bottom', '12px', 'important');
      node.removeAttribute('data-top-y');
    }
    node.setAttribute('data-anchor', detected == null ? 'window-bottom' : 'composer-bottom');
  }

  function normalizeThreadId(value) {
    const text = String(value || '').trim();
    const match = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0].toLowerCase() : '';
  }

  function detectThreadId() {
    const selectors = [
      '[data-app-action-sidebar-thread-id][aria-current="page"]',
      '[data-app-action-sidebar-thread-id][aria-selected="true"]',
      '[data-app-action-sidebar-thread-id][data-state="active"]',
      '[data-thread-id][aria-current="page"]',
      '[data-conversation-id][aria-current="page"]'
    ];
    for (let i = 0; i < selectors.length; i++) {
      const element = document.querySelector(selectors[i]);
      if (!element) continue;
      const id = normalizeThreadId(
        element.getAttribute('data-app-action-sidebar-thread-id') ||
        element.getAttribute('data-thread-id') ||
        element.getAttribute('data-conversation-id')
      );
      if (id) return id;
    }
    return normalizeThreadId(String(location.href || ''));
  }

  function applySnapshot(snapshot, source) {
    const data = snapshot && snapshot.data ? snapshot.data : snapshot;
    const realtime = source === 'realtime' || !!(data && data.realtime);
    if (!realtime && Date.now() - state.lastRealtimeAt < 4000) return;
    if (!data || data.available !== true) {
      state.available = false;
      state.used = 0;
      state.limit = 0;
      render();
      return;
    }
    const used = Number(data.usedTokens);
    const limit = Number(data.contextWindow);
    if (!isFinite(used) || !isFinite(limit) || used < 0 || limit <= 0) return;
    state.available = true;
    state.used = used;
    state.limit = limit;
    if (realtime) state.lastRealtimeAt = Date.now();
    render();
  }

  async function poll() {
    const detected = detectThreadId();
    if (detected !== state.threadId) {
      state.threadId = detected;
      state.available = false;
      state.used = 0;
      state.limit = 0;
      state.lastRealtimeAt = 0;
      render();
    }
    if (state.requestPending || typeof window.__codexLauncherRequest !== 'function') return;
    state.requestPending = true;
    try {
      const response = await window.__codexLauncherRequest('/context/get', { threadId: detected }, 4500);
      applySnapshot(response, 'native');
    } catch (_) {
      // Keep the last valid value during a transient bridge timeout to avoid flicker.
    } finally {
      state.requestPending = false;
    }
  }

  window.__codexLauncherRenderContext = function (snapshot) {
    applySnapshot(snapshot, 'native');
  };
  window.__codexLauncherApplyRealtimeContext = function (snapshot) {
    applySnapshot(snapshot, 'realtime');
  };
  window.__codexLauncherContextBarInstalled = OWNER;

  ensureNode();
  alignBelowComposer();
  render();
  poll();

  if (!window.__codexLauncherContextLoop) {
    window.__codexLauncherContextLoop = true;
    setInterval(function () {
      try {
        ensureNode();
        alignBelowComposer();
        poll();
      } catch (_) {}
    }, POLL_MS);
  }

  window.addEventListener('resize', function () {
    try { alignBelowComposer(); } catch (_) {}
  }, { passive: true });
})();
