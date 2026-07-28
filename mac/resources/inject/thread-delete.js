(() => {
  // Sidebar thread delete (local files + UI row).
  // Use event delegation so handlers are never stacked (fixes cancel still reopening dialog).
  const STYLE_ID = 'codex-launcher-thread-delete-style';
  const BTN_CLASS = 'codex-launcher-thread-delete';
  const CONFIRM_ID = 'codex-launcher-delete-confirm';
  const BUSY = Object.create(null);

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.' + BTN_CLASS + '{' +
      'border:1px solid transparent!important;' +
      'background:transparent!important;' +
      'color:rgba(190,18,60,.88)!important;' +
      'width:20px!important;height:20px!important;padding:0!important;' +
      'display:inline-flex!important;align-items:center!important;justify-content:center!important;' +
      'border-radius:6px!important;cursor:pointer!important;flex:0 0 auto!important;' +
      'pointer-events:auto!important;z-index:5!important;' +
      '}' +
      '.' + BTN_CLASS + ':hover{background:rgba(190,18,60,.10)!important;color:#be123c!important}' +
      '.' + BTN_CLASS + ' svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.8;' +
      'stroke-linecap:round;stroke-linejoin:round;pointer-events:none}' +
      '.' + BTN_CLASS + '[data-busy="true"]{opacity:.5;pointer-events:none!important}' +
      '#' + CONFIRM_ID + '{position:fixed!important;inset:0!important;z-index:2147483647!important;' +
      'display:flex!important;align-items:center!important;justify-content:center!important;' +
      'padding:20px!important;background:rgba(15,23,42,.38)!important;box-sizing:border-box!important}' +
      '#' + CONFIRM_ID + ' .cl-delete-dialog{width:min(320px,calc(100vw - 40px));padding:20px;' +
      'border:1px solid rgba(127,127,127,.25);border-radius:8px;background:Canvas;color:CanvasText;' +
      'box-shadow:0 18px 50px rgba(0,0,0,.28);font:14px/1.5 ui-sans-serif,system-ui,Segoe UI,sans-serif}' +
      '#' + CONFIRM_ID + ' .cl-delete-title{font-size:16px;font-weight:700;margin:0 0 18px;text-align:center}' +
      '#' + CONFIRM_ID + ' .cl-delete-actions{display:flex;justify-content:flex-end;gap:10px}' +
      '#' + CONFIRM_ID + ' button{min-width:88px;height:34px;padding:0 14px;border-radius:6px;' +
      'border:1px solid rgba(127,127,127,.35);background:Canvas;color:CanvasText;cursor:pointer;font-weight:600}' +
      '#' + CONFIRM_ID + ' button[data-confirm="true"]{border-color:#dc2626;background:#dc2626;color:#fff}' +
      '[data-app-action-sidebar-thread-row] > div > div.absolute.right-0{' +
      'width:auto!important;min-width:72px!important;gap:2px!important;' +
      '}';
    (document.documentElement || document.head || document.body).appendChild(style);
  }

  function askDeleteConfirmation() {
    return new Promise(function (resolve) {
      const existing = document.getElementById(CONFIRM_ID);
      if (existing) {
        resolve(false);
        return;
      }

      const overlay = document.createElement('div');
      overlay.id = CONFIRM_ID;
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.innerHTML =
        '<div class="cl-delete-dialog">' +
        '<p class="cl-delete-title">确定删除这个对话吗？</p>' +
        '<div class="cl-delete-actions">' +
        '<button type="button" data-cancel="true">取消</button>' +
        '<button type="button" data-confirm="true">确定删除</button>' +
        '</div></div>';

      let finished = false;
      function finish(value) {
        if (finished) return;
        finished = true;
        try { document.removeEventListener('keydown', onKeyDown, true); } catch (_) {}
        try { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); } catch (_) {}
        resolve(!!value);
      }
      function onKeyDown(event) {
        if (event && event.key === 'Escape') finish(false);
      }
      overlay.addEventListener('click', function (event) {
        const target = event.target;
        if (target === overlay || (target && target.closest && target.closest('[data-cancel="true"]'))) finish(false);
        else if (target && target.closest && target.closest('[data-confirm="true"]')) finish(true);
      });
      document.addEventListener('keydown', onKeyDown, true);
      (document.body || document.documentElement).appendChild(overlay);
      const cancelButton = overlay.querySelector('[data-cancel="true"]');
      if (cancelButton) cancelButton.focus();
    });
  }

  function normalizeThreadId(raw) {
    let id = String(raw || '').trim();
    if (!id) return '';
    id = id.replace(/^(?:local:\/?thread:|local:|thread:|conversation:|session:)/i, '').trim();
    return id;
  }

  function findActionRail(row) {
    if (!row) return null;
    const abs = row.querySelector('div.absolute.right-0, div[class*="absolute"][class*="right-0"]');
    if (abs) return abs;
    const btn = row.querySelector('button[aria-label*="归档"],button[aria-label*="置顶"]');
    if (btn && btn.parentElement) return btn.parentElement;
    return null;
  }

  function ensureDeleteButton(row) {
    if (!row || !row.isConnected) return;
    ensureStyle();
    const threadIdRaw = row.getAttribute('data-app-action-sidebar-thread-id') ||
      row.getAttribute('data-thread-id') ||
      row.getAttribute('data-conversation-id') || '';
    const threadId = normalizeThreadId(threadIdRaw);
    if (!threadId) return;
    const title = row.getAttribute('data-app-action-sidebar-thread-title') ||
      (row.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) || threadId;

    const rail = findActionRail(row);
    if (!rail) return;

    let btn = row.querySelector('.' + BTN_CLASS);
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = BTN_CLASS;
      btn.setAttribute('aria-label', '删除任务');
      btn.title = '删除对话（含本地记录）';
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M8 7l1 13h6l1-13"/>' +
        '<path d="M10 11v6M14 11v6"/></svg>';
      rail.appendChild(btn);
    }
    // Always refresh metadata on the node (no stacked listeners).
    btn.setAttribute('data-thread-id', threadId);
    btn.setAttribute('data-thread-title', title);
  }

  async function performDelete(btn, threadId, title, row) {
    if (!threadId) return;
    if (BUSY[threadId] || (btn && btn.getAttribute('data-busy') === 'true')) return;

    // One-shot confirm; cancel must exit immediately and not re-enter.
    const stamp = Date.now();
    if (window.__codexLinkDeleteConfirmAt && stamp - window.__codexLinkDeleteConfirmAt < 400) {
      return;
    }
    window.__codexLinkDeleteConfirmAt = stamp;

    let ok = false;
    try { ok = await askDeleteConfirmation(); } catch (_) { ok = false; }
    if (!ok) return;

    BUSY[threadId] = true;
    if (btn) btn.setAttribute('data-busy', 'true');
    try {
      let hostRes = { ok: false };
      if (typeof window.__codexLauncherRequest === 'function') {
        hostRes = await window.__codexLauncherRequest('/thread/delete', {
          threadId: threadId,
          title: title
        }, 30000);
      }
      try {
        if (row && row.parentNode) row.parentNode.removeChild(row);
      } catch (_) {}
      try {
        if (window.electronBridge && typeof window.electronBridge.sendMessageFromView === 'function') {
          Promise.resolve(window.electronBridge.sendMessageFromView({
            type: 'archive-conversation',
            conversationId: threadId,
            hostId: 'local',
            source: 'codexlink-delete'
          })).catch(function () {});
          Promise.resolve(window.electronBridge.sendMessageFromView({
            type: 'discard-conversation-from-cache',
            conversationId: threadId
          })).catch(function () {});
          Promise.resolve(window.electronBridge.sendMessageFromView({
            type: 'delete-archived-conversation',
            conversationId: threadId
          })).catch(function () {});
        }
      } catch (_) {}
      try { console.log('[CodexLink] thread deleted', threadId, hostRes); } catch (_) {}
    } catch (e) {
      try { console.error('[CodexLink] delete failed', e); } catch (_) {}
      try { window.alert('删除失败，请稍后重试。'); } catch (_) {}
    } finally {
      delete BUSY[threadId];
      if (btn) btn.setAttribute('data-busy', 'false');
    }
  }

  function onClickCapture(ev) {
    const t = ev.target;
    if (!t || !t.closest) return;
    const btn = t.closest('.' + BTN_CLASS);
    if (!btn) return;
    // Stop ALL other handlers (row select / archive) for this click.
    try {
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
    } catch (_) {}

    const threadId = normalizeThreadId(btn.getAttribute('data-thread-id') || '');
    const title = btn.getAttribute('data-thread-title') || threadId;
    const row = btn.closest('[data-app-action-sidebar-thread-row], [data-app-action-sidebar-thread-id]');
    // async fire-and-forget; do not await in event handler
    performDelete(btn, threadId, title, row);
  }

  function scanRows() {
    try {
      ensureStyle();
      const rows = document.querySelectorAll(
        '[data-app-action-sidebar-thread-row], [data-app-action-sidebar-thread-id]'
      );
      for (let i = 0; i < rows.length; i++) ensureDeleteButton(rows[i]);
    } catch (_) {}
  }

  if (!window.__codexLauncherThreadDeleteDelegated) {
    window.__codexLauncherThreadDeleteDelegated = true;
    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('pointerdown', function (ev) {
      const t = ev.target;
      if (!t || !t.closest) return;
      if (!t.closest('.' + BTN_CLASS)) return;
      try {
        ev.stopPropagation();
        if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
      } catch (_) {}
    }, true);
  }

  if (!window.__codexLauncherThreadDeleteLoop) {
    window.__codexLauncherThreadDeleteLoop = true;
    try {
      const mo = new MutationObserver(function () { scanRows(); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
    setInterval(scanRows, 1500);
  }

  scanRows();
  window.__codexLauncherThreadDeleteInstalled = true;
  try { console.log('[CodexLink] thread delete ready (delegated)'); } catch (_) {}
})();
