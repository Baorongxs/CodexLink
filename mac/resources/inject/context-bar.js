(() => {
  const NODE_ID = 'codex-launcher-context-bar';
  const STYLE_ID = 'codex-launcher-context-bar-style';
  const POLL_MS = 1200;

  window.__codexLauncherContextState = window.__codexLauncherContextState || {
    available: false,
    used: 0,
    limit: 0,
    threadId: '',
    requestPending: false
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
      '#' + NODE_ID + '{position:fixed!important;z-index:2147483645!important;width:184px;height:28px;' +
      'padding:3px 8px;box-sizing:border-box;border:1px solid rgba(15,23,42,.13);border-radius:6px;' +
      'background:rgba(255,255,255,.96);box-shadow:0 2px 8px rgba(15,23,42,.12);' +
      'display:grid!important;grid-template-columns:1fr auto;grid-template-rows:12px 5px;' +
      'column-gap:7px;row-gap:2px;align-content:center;color:#334155;' +
      'font:600 10px/12px ui-sans-serif,system-ui,Segoe UI,sans-serif;letter-spacing:0;' +
      'user-select:none;pointer-events:none;visibility:visible!important;opacity:1!important}' +
      '#' + NODE_ID + ' .cl-ctx-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#64748b}' +
      '#' + NODE_ID + ' .cl-ctx-value{white-space:nowrap;text-align:right;color:#166534;font-weight:700}' +
      '#' + NODE_ID + ' .cl-ctx-track{grid-column:1/3;position:relative;height:5px;border-radius:3px;' +
      'background:rgba(148,163,184,.25);overflow:hidden}' +
      '#' + NODE_ID + ' .cl-ctx-fill{position:absolute;inset:0 auto 0 0;width:0;border-radius:inherit;' +
      'background:#22c55e;transition:width .22s ease,background-color .22s ease}' +
      '#' + NODE_ID + '[data-level="warn"] .cl-ctx-value{color:#a16207}' +
      '#' + NODE_ID + '[data-level="warn"] .cl-ctx-fill{background:#eab308}' +
      '#' + NODE_ID + '[data-level="critical"] .cl-ctx-value{color:#b91c1c}' +
      '#' + NODE_ID + '[data-level="critical"] .cl-ctx-fill{background:#ef4444}' +
      '#' + NODE_ID + '[data-available="false"] .cl-ctx-value{color:#64748b}' +
      '#' + NODE_ID + '[data-available="false"] .cl-ctx-fill{width:0!important;background:#94a3b8}' +
      '#' + NODE_ID + '[data-compact="true"]{grid-template-columns:1fr;padding-left:6px;padding-right:6px}' +
      '#' + NODE_ID + '[data-compact="true"] .cl-ctx-label{display:none}' +
      '#' + NODE_ID + '[data-compact="true"] .cl-ctx-value{grid-column:1;text-align:center}' +
      '#' + NODE_ID + '[data-compact="true"] .cl-ctx-track{grid-column:1}' +
      '@media(prefers-color-scheme:dark){#' + NODE_ID + '{background:rgba(24,24,27,.96);' +
      'border-color:rgba(255,255,255,.14);box-shadow:0 2px 8px rgba(0,0,0,.28);color:#e2e8f0}' +
      '#' + NODE_ID + ' .cl-ctx-label{color:#a1a1aa}#' + NODE_ID + '[data-available="false"] .cl-ctx-value{color:#a1a1aa}' +
      '#' + NODE_ID + ' .cl-ctx-track{background:rgba(148,163,184,.22)}}';
  }

  function ensureNode() {
    ensureStyle();
    let node = document.getElementById(NODE_ID);
    if (!node) {
      node = document.createElement('div');
      node.id = NODE_ID;
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
      node.innerHTML =
        '<span class="cl-ctx-label">上下文</span>' +
        '<span class="cl-ctx-value">剩余 --%</span>' +
        '<span class="cl-ctx-track"><span class="cl-ctx-fill"></span></span>';
      (document.body || document.documentElement).appendChild(node);
    }
    return node;
  }

  function remainingPercent() {
    if (!state.available || state.limit <= 0) return null;
    return clamp(Math.round(((state.limit - state.used) / state.limit) * 100), 0, 100);
  }

  function render() {
    const node = ensureNode();
    const remaining = remainingPercent();
    const value = node.querySelector('.cl-ctx-value');
    const fill = node.querySelector('.cl-ctx-fill');
    node.setAttribute('data-available', remaining == null ? 'false' : 'true');
    if (remaining == null) {
      node.setAttribute('data-level', 'unknown');
      if (value) value.textContent = '剩余 --%';
      if (fill) fill.style.width = '0%';
      node.title = '当前任务暂无上下文用量';
      return;
    }
    node.setAttribute('data-level', remaining <= 10 ? 'critical' : (remaining <= 25 ? 'warn' : 'ok'));
    if (value) value.textContent = '剩余 ' + remaining + '%';
    if (fill) fill.style.width = remaining + '%';
    node.title = '上下文已用 ' + (100 - remaining) + '%，剩余 ' + remaining + '%';
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  }

  function controlText(element) {
    return String((element && (element.textContent || element.getAttribute('aria-label'))) || '')
      .trim().replace(/\s+/g, ' ');
  }

  function findComposer() {
    const editors = document.querySelectorAll('textarea,[contenteditable="true"]');
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < editors.length; i++) {
      const editor = editors[i];
      if (!isVisible(editor)) continue;
      const rect = editor.getBoundingClientRect();
      if (rect.top < window.innerHeight * .42 || rect.width < 120) continue;
      const score = rect.top * 2 + Math.min(rect.width, 1000);
      if (score > bestScore) {
        bestScore = score;
        best = { element: editor, rect: rect };
      }
    }
    return best;
  }

  function findComposerShell(composer) {
    if (!composer || !composer.element) return null;
    let current = composer.element.parentElement;
    let best = null;
    for (let depth = 0; current && depth < 9; depth++, current = current.parentElement) {
      if (!isVisible(current)) continue;
      const rect = current.getBoundingClientRect();
      if (rect.width >= composer.rect.width * .82 && rect.height >= composer.rect.height + 20 && rect.height <= 280) {
        best = { element: current, rect: rect };
      }
      if (rect.height > 320 || rect.width > window.innerWidth * .98) break;
    }
    return best;
  }

  function compactControlFromText(element) {
    if (!element) return null;
    const interactive = element.closest('button,[role="button"],[aria-haspopup],[data-testid]');
    if (interactive && isVisible(interactive)) return interactive;
    const baseRect = element.getBoundingClientRect();
    let current = element.parentElement;
    for (let depth = 0; current && depth < 4; depth++, current = current.parentElement) {
      if (!isVisible(current)) continue;
      const rect = current.getBoundingClientRect();
      if (rect.height > 52 || rect.width > 320) break;
      if (rect.height >= 16 && rect.width >= 24 &&
          (rect.width >= baseRect.width + 4 || rect.height >= baseRect.height + 4)) return current;
    }
    return element;
  }

  function textControls(pattern, shell) {
    const found = [];
    if (!document.body || typeof document.createTreeWalker !== 'function') return found;
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let textNode;
      while ((textNode = walker.nextNode()) && found.length < 16) {
        const text = String(textNode.nodeValue || '').trim().replace(/\s+/g, ' ');
        if (!text || text.length > 64 || !pattern.test(text)) continue;
        const control = compactControlFromText(textNode.parentElement);
        if (!control || !isVisible(control)) continue;
        const rect = control.getBoundingClientRect();
        if (shell && (rect.left < shell.rect.left - 4 || rect.right > shell.rect.right + 4 || rect.top < shell.rect.top)) continue;
        if (!found.some(function (item) { return item.element === control; })) found.push({ element: control, rect: rect });
      }
    } catch (_) {}
    return found;
  }

  function findComposerAnchors() {
    const composer = findComposer();
    const shell = findComposerShell(composer);
    if (!composer || !shell) return null;
    const controls = shell.element.querySelectorAll('button,[role="button"],[aria-haspopup],[data-testid]');
    const access = [];
    const models = [];
    for (let i = 0; i < controls.length; i++) {
      const control = controls[i];
      if (!isVisible(control)) continue;
      const rect = control.getBoundingClientRect();
      if (rect.top < composer.rect.top + composer.rect.height * .45 || rect.width > 300) continue;
      const text = controlText(control);
      if (/完全访问|完整访问|full access|approval|权限/i.test(text)) access.push({ element: control, rect: rect });
      if (/(gpt|codex|o[134](?:\b|-)|model|模型)/i.test(text) && text.length <= 56) models.push({ element: control, rect: rect });
    }

    textControls(/完全访问|完整访问|full access|approval|权限/i, shell).forEach(function (item) {
      if (!access.some(function (existing) { return existing.element === item.element; })) access.push(item);
    });
    textControls(/gpt|codex|o[134](?:\b|-)|model|模型/i, shell).forEach(function (item) {
      if (!models.some(function (existing) { return existing.element === item.element; })) models.push(item);
    });

    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < access.length; i++) {
      for (let j = 0; j < models.length; j++) {
        const left = access[i].rect;
        const right = models[j].rect;
        const gap = right.left - left.right;
        const leftCenter = left.top + left.height / 2;
        const rightCenter = right.top + right.height / 2;
        const verticalDelta = Math.abs(leftCenter - rightCenter);
        if (gap < 64 || verticalDelta > 20) continue;
        const score = Math.min(left.top, right.top) * 2 + gap - verticalDelta * 20;
        if (score > bestScore) {
          bestScore = score;
          best = { access: left, model: right, gap: gap, centerY: (leftCenter + rightCenter) / 2 };
        }
      }
    }
    if (best) {
      best.composer = composer.rect;
      best.shell = shell.rect;
      best.fallback = false;
      return best;
    }

    const centerY = shell.rect.bottom - 19;
    const fallbackWidth = Math.min(184, Math.max(96, shell.rect.width * .34));
    return {
      fallback: true,
      composer: composer.rect,
      shell: shell.rect,
      width: fallbackWidth,
      left: shell.rect.left + (shell.rect.width - fallbackWidth) / 2,
      centerY: centerY
    };
  }

  function place() {
    const node = ensureNode();
    const anchors = findComposerAnchors();
    if (!anchors) {
      node.style.setProperty('display', 'none', 'important');
      node.setAttribute('data-positioned', 'false');
      return;
    }
    const height = 28;
    const safeWidth = anchors.fallback ? anchors.width : anchors.gap - 16;
    const width = Math.min(184, Math.max(64, safeWidth));
    const left = anchors.fallback ? anchors.left : anchors.access.right + (anchors.gap - width) / 2;
    const top = anchors.centerY - height / 2;
    node.style.setProperty('display', 'grid', 'important');
    node.style.setProperty('width', Math.round(width) + 'px', 'important');
    node.style.setProperty('left', left + 'px', 'important');
    node.style.setProperty('top', top + 'px', 'important');
    node.style.setProperty('right', 'auto', 'important');
    node.style.setProperty('bottom', 'auto', 'important');
    node.setAttribute('data-compact', width < 142 ? 'true' : 'false');
    node.setAttribute('data-positioned', 'true');
    node.setAttribute('data-anchor', anchors.fallback ? 'composer' : 'controls');
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
        element.getAttribute('data-conversation-id'));
      if (id) return id;
    }
    return normalizeThreadId(String(location.href || ''));
  }

  function applySnapshot(snapshot) {
    const data = snapshot && snapshot.data ? snapshot.data : snapshot;
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
    render();
  }

  async function poll() {
    const detected = detectThreadId();
    if (detected !== state.threadId) {
      state.threadId = detected;
      state.available = false;
      render();
    }
    if (state.requestPending || typeof window.__codexLauncherRequest !== 'function') return;
    state.requestPending = true;
    try {
      const response = await window.__codexLauncherRequest('/context/get', { threadId: detected }, 4500);
      applySnapshot(response);
    } catch (_) {
      state.available = false;
      render();
    } finally {
      state.requestPending = false;
    }
  }

  window.__codexLauncherRenderContext = function (snapshot) {
    applySnapshot(snapshot);
    place();
  };

  ensureNode();
  render();
  place();
  poll();

  if (!window.__codexLauncherContextLoop) {
    window.__codexLauncherContextLoop = true;
    setInterval(function () {
      try {
        if (!document.getElementById(NODE_ID)) ensureNode();
        place();
        poll();
      } catch (_) {}
    }, POLL_MS);
  }

  window.__codexLauncherContextBarInstalled = true;
})();
