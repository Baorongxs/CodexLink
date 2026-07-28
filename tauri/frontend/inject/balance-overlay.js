(() => {
  // Balance pill only — sit in the top title bar, vertically centered.
  const NODE_ID = 'codex-launcher-balance-overlay';
  const STYLE_ID = 'codex-launcher-balance-style';
  // Windows title bar ~36-40px; keep pill inside and clear of min/max/close (~138px).
  const RIGHT_OFFSET = 148;
  const TOP_OFFSET = 8;
  const PILL_HEIGHT = 22;
  // Approx native title-bar content center (menu text).

  function ensureStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.documentElement || document.head || document.body).appendChild(style);
    }
    style.textContent =
      '#' + NODE_ID + '{' +
      'position:fixed!important;' +
      'top:' + TOP_OFFSET + 'px!important;' +
      'right:' + RIGHT_OFFSET + 'px!important;' +
      'left:auto!important;bottom:auto!important;' +
      'transform:none!important;' +
      'z-index:2147483646!important;' +
      'max-width:min(220px,34vw);' +
      'height:' + PILL_HEIGHT + 'px!important;' +
      'min-height:' + PILL_HEIGHT + 'px!important;' +
      'max-height:' + PILL_HEIGHT + 'px!important;' +
      'padding:0 10px!important;' +
      'border-radius:999px;' +
      'border:1px solid rgba(15,23,42,.12);' +
      'background:rgba(255,255,255,.96);' +
      'box-shadow:0 2px 10px rgba(0,0,0,.14);' +
      'color:#0f172a;' +
      'font:600 12px/' + PILL_HEIGHT + 'px ui-sans-serif,system-ui,Segoe UI,sans-serif!important;' +
      'display:inline-flex!important;align-items:center!important;justify-content:center;gap:6px;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
      'pointer-events:none;user-select:none;' +
      'visibility:visible!important;opacity:1!important;' +
      'box-sizing:border-box!important;' +
      'margin:0!important;' +
      '}' +
      '#' + NODE_ID + ' .cl-label{color:#64748b;font-weight:700;font-size:11px;line-height:1}' +
      '#' + NODE_ID + ' .cl-value{color:#0f172a;font-weight:800;font-size:12px;line-height:1}' +
      '#' + NODE_ID + '[data-logged-in="false"] .cl-value{color:#64748b;font-weight:700}';
  }

  function place(node) {
    node.style.setProperty('top', TOP_OFFSET + 'px', 'important');
    node.style.setProperty('right', RIGHT_OFFSET + 'px', 'important');
    node.style.setProperty('left', 'auto', 'important');
    node.style.setProperty('bottom', 'auto', 'important');
    node.style.setProperty('transform', 'none', 'important');
    node.style.setProperty('height', PILL_HEIGHT + 'px', 'important');
    node.style.setProperty('line-height', PILL_HEIGHT + 'px', 'important');
    node.style.setProperty('display', 'inline-flex', 'important');
    node.style.setProperty('align-items', 'center', 'important');
    node.style.setProperty('visibility', 'visible', 'important');
    node.style.setProperty('opacity', '1', 'important');
    node.style.setProperty('z-index', '2147483646', 'important');
    node.style.setProperty('margin', '0', 'important');
  }

  function ensureNode() {
    ensureStyle();
    let node = document.getElementById(NODE_ID);
    if (!node) {
      node = document.createElement('div');
      node.id = NODE_ID;
      node.innerHTML = '<span class="cl-label">余额</span><span class="cl-value">--</span>';
      (document.body || document.documentElement).appendChild(node);
    }
    place(node);
    return node;
  }

  window.__codexLauncherRenderBalance = function renderBalance(state) {
    const node = ensureNode();
    const loggedIn = !!(state && state.loggedIn);
    node.setAttribute('data-logged-in', loggedIn ? 'true' : 'false');
    const label = node.querySelector('.cl-label');
    const value = node.querySelector('.cl-value');
    if (label) label.textContent = '余额';
    if (value) {
      if (loggedIn) value.textContent = (state && state.balanceText) || window.__codexLauncherLastBalance || '$--';
      else value.textContent = '未登录';
    }
    if (loggedIn && state && state.balanceText) {
      window.__codexLauncherLastBalance = state.balanceText;
    }
    place(node);
  };

  function removeLegacyUi() {
    ['codex-launcher-usage-float', 'codex-launcher-usage-badge-style', 'codex-launcher-usage-core-style'].forEach(function (id) {
      const n = document.getElementById(id);
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });
    try {
      document.querySelectorAll('.codex-launcher-usage-badge').forEach(function (n) {
        if (n && n.parentNode) n.parentNode.removeChild(n);
      });
    } catch (_) {}
  }

  try {
    removeLegacyUi();
    ensureNode();
    if (window.__codexLauncherLastBalance) {
      window.__codexLauncherRenderBalance({ loggedIn: true, balanceText: window.__codexLauncherLastBalance });
    }
  } catch (_) {}

  if (!window.__codexLauncherBalanceKeepAlive) {
    window.__codexLauncherBalanceKeepAlive = true;
    setInterval(function () {
      try {
        removeLegacyUi();
        const node = document.getElementById(NODE_ID);
        if (!node) {
          window.__codexLauncherRenderBalance({
            loggedIn: !!window.__codexLauncherLastBalance,
            balanceText: window.__codexLauncherLastBalance || '$--'
          });
        } else {
          place(node);
        }
      } catch (_) {}
    }, 2000);
    try {
      window.addEventListener('resize', function () {
        const n = document.getElementById(NODE_ID);
        if (n) place(n);
      });
    } catch (_) {}
  }

  try {
    if (typeof window.__codexLauncherRequest === 'function') {
      window.__codexLauncherRequest('/balance/get', {}, 5000).then(function (res) {
        if (res && res.ok) window.__codexLauncherRenderBalance(res.data || res);
      }).catch(function () {});
    }
  } catch (_) {}

  window.__codexLauncherBalanceOverlayInstalled = true;
})();
