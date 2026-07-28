(() => {
  const STYLE_ID = 'codex-launcher-usage-badge-style';
  const BADGE_CLASS = 'codex-launcher-usage-badge';
  const FLOAT_ID = 'codex-launcher-usage-float';

  window.__codexLauncherUsageSeen = window.__codexLauncherUsageSeen || Object.create(null);
  const seen = window.__codexLauncherUsageSeen;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.' + BADGE_CLASS + '{' +
      'display:inline-flex;align-items:center;gap:6px;margin-top:6px;padding:4px 8px;' +
      'border-radius:999px;border:1px solid rgba(15,23,42,.10);' +
      'background:rgba(248,250,252,.96);color:rgba(51,65,85,.92);' +
      'font:600 11px/1.2 ui-sans-serif,system-ui,Segoe UI,sans-serif;' +
      'max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
      '}' +
      '.' + BADGE_CLASS + '[data-pending="true"]{opacity:.78}' +
      '.' + BADGE_CLASS + ' b{font-weight:700;color:rgba(15,23,42,.92)}' +
      '#' + FLOAT_ID + '{' +
      'position:fixed!important;left:50%!important;bottom:18px!important;transform:translateX(-50%)!important;' +
      'z-index:2147483646!important;max-width:min(780px,94vw);' +
      'display:none;align-items:center;gap:8px;padding:8px 14px;' +
      'border-radius:999px;border:1px solid rgba(15,23,42,.12);' +
      'background:rgba(255,255,255,.97);backdrop-filter:blur(10px);' +
      'box-shadow:0 10px 28px rgba(15,23,42,.18);' +
      'color:rgba(15,23,42,.9);font:600 12px/1.2 ui-sans-serif,system-ui,Segoe UI,sans-serif;' +
      'white-space:nowrap;pointer-events:none;visibility:visible;' +
      '}' +
      '#' + FLOAT_ID + '[data-show="true"]{display:inline-flex!important}' +
      '#' + FLOAT_ID + ' b{font-weight:800}';
    (document.documentElement || document.head || document.body).appendChild(style);
  }

  function ensureFloat() {
    ensureStyle();
    let node = document.getElementById(FLOAT_ID);
    if (!node) {
      node = document.createElement('div');
      node.id = FLOAT_ID;
      (document.body || document.documentElement).appendChild(node);
    }
    return node;
  }

  function renderFloat(html, show) {
    const node = ensureFloat();
    node.innerHTML = html;
    node.setAttribute('data-show', show ? 'true' : 'false');
    node.style.display = show ? 'inline-flex' : 'none';
    node.style.visibility = 'visible';
    node.style.zIndex = '2147483646';
  }

  function formatTokens(n) {
    const v = Number(n || 0);
    if (!isFinite(v) || v <= 0) return '0';
    if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(Math.round(v));
  }

  function normalizeUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const input = Number(
      raw.input_tokens != null ? raw.input_tokens :
      (raw.inputTokens != null ? raw.inputTokens :
      (raw.prompt_tokens != null ? raw.prompt_tokens :
      (raw.promptTokens != null ? raw.promptTokens : (raw.input != null ? raw.input : 0))))
    );
    const output = Number(
      raw.output_tokens != null ? raw.output_tokens :
      (raw.outputTokens != null ? raw.outputTokens :
      (raw.completion_tokens != null ? raw.completion_tokens :
      (raw.completionTokens != null ? raw.completionTokens : (raw.output != null ? raw.output : 0))))
    );
    let total = Number(
      raw.total_tokens != null ? raw.total_tokens :
      (raw.totalTokens != null ? raw.totalTokens : (raw.total != null ? raw.total : 0))
    );
    if (!total) total = input + output;
    const cached = Number(
      raw.cached_tokens != null ? raw.cached_tokens :
      (raw.cachedTokens != null ? raw.cachedTokens :
      (raw.cache_read_input_tokens != null ? raw.cache_read_input_tokens : 0))
    );
    if (!input && !output && !total) return null;
    return { input: input, output: output, total: total || (input + output), cached: cached };
  }

  function findAnchor() {
    const selectors = [
      '[data-message-author-role="assistant"]',
      '[data-testid*="assistant"]',
      'div[class*="assistant"]',
      '[class*="assistant"] [class*="action"]',
      'div[class*="mt-1.5"][class*="flex"][class*="h-5"]',
      'article',
      'main'
    ];
    for (let s = 0; s < selectors.length; s++) {
      const nodes = Array.from(document.querySelectorAll(selectors[s]));
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (!n || !n.isConnected) continue;
        if (n.querySelector && n.querySelector('.' + BADGE_CLASS)) continue;
        return n;
      }
    }
    return document.body;
  }

  function renderBadge(html, pending) {
    ensureStyle();
    const host = findAnchor();
    if (!host) return null;
    let badge = host.querySelector ? host.querySelector('.' + BADGE_CLASS) : null;
    if (!badge) {
      badge = document.createElement('div');
      badge.className = BADGE_CLASS;
      if (host.appendChild) host.appendChild(badge);
      else document.body.appendChild(badge);
    }
    badge.setAttribute('data-pending', pending ? 'true' : 'false');
    badge.innerHTML = html;
    return badge;
  }

  async function resolveBilling(usage, model) {
    if (typeof window.__codexLauncherRequest !== 'function') {
      return { ok: false, error: 'no_bridge' };
    }
    return window.__codexLauncherRequest('/usage/resolve', {
      model: model || '',
      inputTokens: usage.input,
      outputTokens: usage.output,
      totalTokens: usage.total,
      cachedTokens: usage.cached,
      observedAt: Date.now()
    }, 20000);
  }

  async function showUsage(usage, model) {
    if (!usage) return;
    const key = [usage.total, usage.input, usage.output, model || '', Math.floor(Date.now() / 2500)].join('|');
    if (seen[key]) return;
    seen[key] = Date.now();

    try {
      if (typeof window.__codexLauncherUpdateContext === 'function') {
        window.__codexLauncherUpdateContext({
          model: model || '',
          inputTokens: usage.input,
          totalTokens: usage.total
        });
      }
    } catch (_) {}

    const tokenText = 'Token <b>' + formatTokens(usage.total) + '</b> (↑' + formatTokens(usage.input) + ' / ↓' + formatTokens(usage.output) + ')';
    const pendingHtml = tokenText + ' · 扣费 <b>结算中…</b> · 余额 <b>--</b>';
    renderBadge(pendingHtml, true);
    renderFloat(pendingHtml, true);

    let costText = '结算中…';
    let balanceText = '--';
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) await new Promise(function (r) { setTimeout(r, 900); });
      try {
        const res = await resolveBilling(usage, model);
        if (res && res.ok) {
          const data = res.data || res;
          if (data.costText) costText = data.costText;
          if (data.balanceText) balanceText = data.balanceText;
          if (data.costReady) break;
        }
      } catch (_) {}
    }

    // Local estimate fallback when log not ready yet
    if (costText === '结算中…' && usage.total > 0) {
      // Rough display only; host log remains authoritative when ready.
      costText = '约算中';
    }

    const finalHtml = tokenText + ' · 扣费 <b>' + costText + '</b> · 余额 <b>' + balanceText + '</b>';
    renderBadge(finalHtml, false);
    renderFloat(finalHtml, true);
    if (window.__codexLauncherRenderBalance && balanceText !== '--') {
      window.__codexLauncherRenderBalance({ loggedIn: true, balanceText: balanceText });
    }
    setTimeout(function () {
      const n = document.getElementById(FLOAT_ID);
      if (n) {
        n.setAttribute('data-show', 'false');
        n.style.display = 'none';
      }
    }, 14000);
  }

  // Allow host CDP to push usage directly.
  window.__codexLauncherShowUsage = function (usage, model) {
    try {
      const u = normalizeUsage(usage) || usage;
      if (u) showUsage(u, model || '');
    } catch (_) {}
  };

  function extractUsageFromJson(data) {
    if (!data || typeof data !== 'object') return null;
    const candidates = [
      data.usage,
      data.response && data.response.usage,
      data.result && data.result.usage,
      data.data && data.data.usage,
      data.turn && data.turn.usage,
      data.message && data.message.usage,
      data.item && data.item.usage,
      data.payload && data.payload.usage
    ];
    for (let i = 0; i < candidates.length; i++) {
      const u = normalizeUsage(candidates[i]);
      if (u) return u;
    }
    try {
      const keys = Object.keys(data);
      for (let i = 0; i < keys.length; i++) {
        const val = data[keys[i]];
        if (val && typeof val === 'object' && val.usage) {
          const u = normalizeUsage(val.usage);
          if (u) return u;
        }
      }
    } catch (_) {}
    return null;
  }

  function maybeHandlePayload(text, url) {
    if (!text || text.length > 2000000) return;
    const hasUsage = /"usage"\s*:/.test(text) || /input_tokens|output_tokens|total_tokens|prompt_tokens|completion_tokens/.test(text);
    if (!hasUsage) {
      if (!url || !/(responses|chat\/completions|conversation|thread|api|codex|openai|baorong)/i.test(String(url))) return;
    }
    try {
      const data = JSON.parse(text);
      const usage = extractUsageFromJson(data);
      if (!usage) return;
      const model = data.model || (data.response && data.response.model) || '';
      showUsage(usage, model);
      return;
    } catch (_) {}

    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^data:\s*(\{.*\})\s*$/);
      if (!m) continue;
      try {
        const data = JSON.parse(m[1]);
        const usage = extractUsageFromJson(data);
        if (usage) showUsage(usage, data.model || '');
      } catch (_) {}
    }
  }

  // Register on shared net handlers (created by context-bar)
  window.__codexLauncherNetHandlers = window.__codexLauncherNetHandlers || [];
  if (!window.__codexLauncherUsageHandlerReg) {
    window.__codexLauncherUsageHandlerReg = true;
    window.__codexLauncherNetHandlers.push(function (text, url) {
      maybeHandlePayload(text, url);
    });
  }

  // Also install own hooks if context-bar not present yet
  if (!window.__codexLauncherNetHooked) {
    window.__codexLauncherNetHooked = true;
    function dispatchNet(text, url) {
      const handlers = window.__codexLauncherNetHandlers || [];
      for (let i = 0; i < handlers.length; i++) {
        try { handlers[i](text, url); } catch (_) {}
      }
    }
    try {
      const originalFetch = window.fetch;
      if (typeof originalFetch === 'function') {
        const wrapped = async function () {
          const args = arguments;
          const response = await originalFetch.apply(this, args);
          try {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            response.clone().text().then(function (text) { dispatchNet(text, url); }).catch(function () {});
          } catch (_) {}
          return response;
        };
        window.fetch = wrapped;
      }
    } catch (_) {}
  }

  // Keep float style alive
  if (!window.__codexLauncherUsageKeepAlive) {
    window.__codexLauncherUsageKeepAlive = true;
    setInterval(function () {
      try { ensureStyle(); } catch (_) {}
    }, 2000);
  }

  ensureFloat();
  try { console.log('[CodexLauncher] usage badge ready'); } catch (_) {}
  window.__codexLauncherUsageBadgeInstalled = true;
})();
