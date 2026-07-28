(() => {
  const BAL_ID = 'codex-launcher-balance-overlay';
  const CTX_ID = 'codex-launcher-context-bar';
  const FLOAT_ID = 'codex-launcher-usage-float';
  const STYLE_ID = 'codex-launcher-usage-core-style';

  window.__codexLauncherUsageCore = window.__codexLauncherUsageCore || {
    seenLogIds: Object.create(null),
    lastUsageKey: '',
    model: '',
    used: 0,
    limit: 200000,
    lastTurn: null
  };
  const state = window.__codexLauncherUsageCore;

  function num(v) {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function formatTokens(n) {
    const v = Math.max(0, num(n));
    if (v >= 1000000) return (v / 1000000).toFixed(2).replace(/\.00$/, '') + 'M';
    if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(Math.round(v));
  }

  // Model context window map (tokens). Prefer explicit modelContextWindow when available.
  function modelLimit(model) {
    const m = String(model || '').toLowerCase().replace(/\s+/g, '');
    if (!m) return state.limit || 200000;

    // explicit size tags
    if (/400k|400000/.test(m)) return 400000;
    if (/272k|272000/.test(m)) return 272000;
    if (/256k|256000/.test(m)) return 256000;
    if (/200k|200000/.test(m)) return 200000;
    if (/128k|128000/.test(m)) return 128000;
    if (/64k|64000/.test(m)) return 64000;
    if (/32k|32000/.test(m)) return 32000;
    if (/16k|16384/.test(m)) return 16384;
    if (/8k|8192/.test(m)) return 8192;

    // Codex / GPT-5 family (desktop commonly 200k–272k)
    if (/gpt-5\.3|gpt5\.3|gpt-5-3/.test(m)) return 272000;
    if (/gpt-5\.2|gpt5\.2/.test(m)) return 272000;
    if (/gpt-5\.1|gpt5\.1/.test(m)) return 272000;
    if (/gpt-5|gpt5|codex/.test(m)) return 200000;
    if (/o4-mini|o3-mini/.test(m)) return 200000;
    if (/o3|o4/.test(m)) return 200000;
    if (/gpt-4\.1|gpt4\.1/.test(m)) return 1047576;
    if (/gpt-4o|gpt4o/.test(m)) return 128000;
    if (/gpt-4-turbo|gpt-4\.?turbo/.test(m)) return 128000;
    if (/claude-3-7|claude-4|sonnet-4|opus-4/.test(m)) return 200000;
    if (/claude-3-5|sonnet|opus|haiku/.test(m)) return 200000;
    if (/deepseek/.test(m)) return 128000;
    if (/gemini-2|gemini-1\.5-pro/.test(m)) return 1048576;
    if (/gemini/.test(m)) return 128000;

    // route labels in this launcher
    if (/gpt-pro|pro-1|pro-2|pro-3|pro-4/.test(m)) return 200000;
    if (/gpt-plus|plus-1|plus-2|plus-3|plus-4/.test(m)) return 200000;

    return 200000;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '#' + BAL_ID + '{position:fixed!important;top:8px!important;right:148px!important;left:auto!important;transform:none!important;z-index:2147483646!important;height:28px;padding:0 12px;border-radius:999px;border:1px solid rgba(15,23,42,.12);background:rgba(255,255,255,.96);box-shadow:0 4px 14px rgba(0,0,0,.18);display:inline-flex!important;align-items:center;gap:6px;font:600 12px/28px ui-sans-serif,system-ui,Segoe UI,sans-serif;color:#0f172a;pointer-events:none;white-space:nowrap;visibility:visible!important;opacity:1!important}' +
      '#' + BAL_ID + ' .cl-label{color:#64748b;font-weight:700;font-size:11px}' +
      '#' + BAL_ID + ' .cl-value{color:#0f172a;font-weight:800;font-size:12px}' +
      '#' + CTX_ID + '{position:fixed!important;top:8px!important;left:50%!important;transform:translateX(-50%)!important;z-index:2147483646!important;width:min(420px,50vw);min-width:220px;height:28px;padding:0 12px;border-radius:999px;border:1px solid rgba(15,23,42,.12);background:rgba(255,255,255,.96);box-shadow:0 4px 14px rgba(0,0,0,.16);display:grid!important;grid-template-columns:auto 1fr auto;align-items:center;gap:8px;font:600 11px/1 ui-sans-serif,system-ui,Segoe UI,sans-serif;color:#0f172a;pointer-events:none;visibility:visible!important;opacity:1!important}' +
      '#' + CTX_ID + ' .cl-ctx-label{color:#64748b;font-weight:700;white-space:nowrap}' +
      '#' + CTX_ID + ' .cl-ctx-track{position:relative;height:6px;border-radius:999px;background:rgba(148,163,184,.28);overflow:hidden;min-width:0}' +
      '#' + CTX_ID + ' .cl-ctx-fill{position:absolute;left:0;top:0;bottom:0;width:0%;border-radius:inherit;background:linear-gradient(90deg,#38bdf8,#0ea5e9);transition:width .25s ease}' +
      '#' + CTX_ID + '[data-level="warn"] .cl-ctx-fill{background:linear-gradient(90deg,#fbbf24,#f59e0b)}' +
      '#' + CTX_ID + '[data-level="crit"] .cl-ctx-fill{background:linear-gradient(90deg,#fb7185,#e11d48)}' +
      '#' + CTX_ID + ' .cl-ctx-value{color:#0f172a;font-weight:800;font-size:11px;white-space:nowrap;min-width:5.2em;text-align:right}' +
      '#' + FLOAT_ID + '{position:fixed!important;left:50%!important;bottom:18px!important;transform:translateX(-50%)!important;z-index:2147483646!important;max-width:min(820px,94vw);display:none;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;border:1px solid rgba(15,23,42,.12);background:rgba(255,255,255,.97);box-shadow:0 10px 28px rgba(15,23,42,.18);color:#0f172a;font:600 12px/1.2 ui-sans-serif,system-ui,Segoe UI,sans-serif;white-space:nowrap;pointer-events:none}' +
      '#' + FLOAT_ID + '[data-show="true"]{display:inline-flex!important}' +
      '#' + FLOAT_ID + ' b{font-weight:800}';
    (document.documentElement || document.head || document.body).appendChild(style);
  }

  function ensureBalance() {
    ensureStyle();
    let n = document.getElementById(BAL_ID);
    if (!n) {
      n = document.createElement('div');
      n.id = BAL_ID;
      n.innerHTML = '<span class="cl-label">余额</span><span class="cl-value">--</span>';
      (document.body || document.documentElement).appendChild(n);
    }
    return n;
  }

  function ensureContext() {
    ensureStyle();
    let n = document.getElementById(CTX_ID);
    if (!n) {
      n = document.createElement('div');
      n.id = CTX_ID;
      n.innerHTML =
        '<span class="cl-ctx-label">上下文</span>' +
        '<span class="cl-ctx-track"><span class="cl-ctx-fill"></span></span>' +
        '<span class="cl-ctx-value">0% · ' + formatTokens(state.limit) + '</span>';
      (document.body || document.documentElement).appendChild(n);
    }
    return n;
  }

  function ensureFloat() {
    ensureStyle();
    let n = document.getElementById(FLOAT_ID);
    if (!n) {
      n = document.createElement('div');
      n.id = FLOAT_ID;
      (document.body || document.documentElement).appendChild(n);
    }
    return n;
  }

  function renderBalance(s) {
    const node = ensureBalance();
    const loggedIn = !!(s && s.loggedIn);
    const value = node.querySelector('.cl-value');
    if (value) value.textContent = loggedIn ? ((s && s.balanceText) || window.__codexLauncherLastBalance || '$--') : '未登录';
    if (loggedIn && s && s.balanceText) window.__codexLauncherLastBalance = s.balanceText;
  }

  function renderContext() {
    const node = ensureContext();
    const used = Math.max(0, num(state.used));
    const limit = Math.max(1, num(state.limit) || 200000);
    const percent = Math.max(0, Math.min(100, (used / limit) * 100));
    const remain = Math.max(0, limit - used);
    let level = 'ok';
    if (percent >= 90) level = 'crit';
    else if (percent >= 75) level = 'warn';
    node.setAttribute('data-level', level);
    const fill = node.querySelector('.cl-ctx-fill');
    const value = node.querySelector('.cl-ctx-value');
    if (fill) fill.style.width = percent.toFixed(1) + '%';
    if (value) {
      value.textContent = Math.round(percent) + '% · ' + formatTokens(remain);
      value.title =
        '已用 ' + formatTokens(used) + ' / ' + formatTokens(limit) +
        (state.model ? (' · ' + state.model) : '');
    }
    node.title = value ? value.title : '上下文';
  }

  function renderFloat(html, show) {
    const node = ensureFloat();
    node.innerHTML = html;
    node.setAttribute('data-show', show ? 'true' : 'false');
    node.style.display = show ? 'inline-flex' : 'none';
  }

  function updateContext(partial) {
    if (!partial || typeof partial !== 'object') return;
    if (partial.model) {
      state.model = String(partial.model);
      state.limit = modelLimit(state.model);
    }
    if (num(partial.limit) > 0) state.limit = num(partial.limit);
    if (partial.used != null && isFinite(Number(partial.used))) state.used = Math.max(0, num(partial.used));
    else if (partial.inputTokens != null && isFinite(Number(partial.inputTokens))) state.used = Math.max(state.used, num(partial.inputTokens));
    else if (partial.totalTokens != null && isFinite(Number(partial.totalTokens))) state.used = Math.max(state.used, num(partial.totalTokens));
    // never shrink context used unless explicit smaller used provided with force
    if (partial.forceUsed != null) state.used = Math.max(0, num(partial.forceUsed));
    renderContext();
  }

  function normalizeUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const input = num(
      raw.input_tokens != null ? raw.input_tokens :
      (raw.inputTokens != null ? raw.inputTokens :
      (raw.prompt_tokens != null ? raw.prompt_tokens :
      (raw.promptTokens != null ? raw.promptTokens : raw.input)))
    );
    const output = num(
      raw.output_tokens != null ? raw.output_tokens :
      (raw.outputTokens != null ? raw.outputTokens :
      (raw.completion_tokens != null ? raw.completion_tokens :
      (raw.completionTokens != null ? raw.completionTokens : raw.output)))
    );
    let total = num(
      raw.total_tokens != null ? raw.total_tokens :
      (raw.totalTokens != null ? raw.totalTokens :
      (raw.requestTotalTokens != null ? raw.requestTotalTokens : raw.total))
    );
    if (!total) total = input + output;
    const cached = num(
      raw.cached_tokens != null ? raw.cached_tokens :
      (raw.cachedTokens != null ? raw.cachedTokens :
      (raw.cache_read_input_tokens != null ? raw.cache_read_input_tokens : 0))
    );
    if (!input && !output && !total) return null;
    return { input: input, output: output, total: total || (input + output), cached: cached };
  }

  async function showUsage(usage, model, meta) {
    if (!usage) return;
    const key = [usage.total, usage.input, usage.output, model || '', (meta && meta.logId) || '', Math.floor(Date.now() / 2000)].join('|');
    if (state.lastUsageKey === key) return;
    state.lastUsageKey = key;
    state.lastTurn = { usage: usage, model: model || state.model, at: Date.now() };

    if (model) state.model = String(model);
    // Context used for next prompt is roughly previous total (conversation size).
    // Prefer input tokens as "current context" when available; else total.
    const ctxUsed = usage.input > 0 ? usage.input : usage.total;
    updateContext({
      model: state.model,
      used: Math.max(state.used, ctxUsed),
      limit: state.limit || modelLimit(state.model)
    });

    const tokenText =
      'Token <b>' + formatTokens(usage.total) + '</b> (↑' + formatTokens(usage.input) + ' / ↓' + formatTokens(usage.output) + ')';
    renderFloat(tokenText + ' · 扣费 <b>结算中…</b> · 余额 <b>--</b>', true);

    let costText = '结算中…';
    let balanceText = '--';
    if (meta && meta.costText) costText = meta.costText;
    if (meta && meta.balanceText) balanceText = meta.balanceText;

    if (!meta || !meta.costReady) {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 900));
        try {
          if (typeof window.__codexLauncherRequest !== 'function') break;
          const res = await window.__codexLauncherRequest('/usage/resolve', {
            model: model || state.model || '',
            inputTokens: usage.input,
            outputTokens: usage.output,
            totalTokens: usage.total,
            cachedTokens: usage.cached,
            observedAt: Date.now(),
            logId: (meta && meta.logId) || ''
          }, 20000);
          if (res && res.ok) {
            const data = res.data || res;
            if (data.costText) costText = data.costText;
            if (data.balanceText) balanceText = data.balanceText;
            if (data.costReady) break;
          }
        } catch (_) {}
      }
    }

    if (costText === '结算中…' && usage.total > 0) costText = '约算中';
    const finalHtml = tokenText + ' · 扣费 <b>' + costText + '</b> · 余额 <b>' + balanceText + '</b>';
    renderFloat(finalHtml, true);
    if (balanceText !== '--') renderBalance({ loggedIn: true, balanceText: balanceText });
    setTimeout(() => {
      const n = document.getElementById(FLOAT_ID);
      if (n) {
        n.setAttribute('data-show', 'false');
        n.style.display = 'none';
      }
    }, 16000);
  }

  // Host can push usage (from New API logs).
  window.__codexLauncherShowUsage = function (usage, model, meta) {
    try {
      const u = normalizeUsage(usage) || usage;
      if (u) showUsage(u, model || state.model || '', meta || null);
    } catch (_) {}
  };
  window.__codexLauncherRenderBalance = renderBalance;
  window.__codexLauncherUpdateContext = updateContext;
  window.__codexLauncherGetContext = function () {
    return {
      used: state.used,
      limit: state.limit,
      remain: Math.max(0, state.limit - state.used),
      percent: Math.max(0, Math.min(100, (state.used / Math.max(1, state.limit)) * 100)),
      model: state.model
    };
  };

  // -------- Deep object scan for Codex native token status --------
  function extractTokenStatus(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const limit = num(
      obj.modelContextWindow != null ? obj.modelContextWindow :
      (obj.model_context_window != null ? obj.model_context_window :
      (obj.contextWindow != null ? obj.contextWindow : obj.context_window))
    );
    const last = obj.last || obj.lastUsage || obj.lastTokenUsage || obj.last_token_usage || null;
    let total = 0, input = 0, output = 0;
    if (last && typeof last === 'object') {
      total = num(last.totalTokens != null ? last.totalTokens : (last.total_tokens != null ? last.total_tokens : last.total));
      input = num(last.inputTokens != null ? last.inputTokens : (last.input_tokens != null ? last.input_tokens : last.prompt_tokens));
      output = num(last.outputTokens != null ? last.outputTokens : (last.output_tokens != null ? last.output_tokens : last.completion_tokens));
      if (!total) total = input + output;
    } else {
      total = num(obj.totalTokens != null ? obj.totalTokens : obj.total_tokens);
      input = num(obj.inputTokens != null ? obj.inputTokens : obj.input_tokens);
      output = num(obj.outputTokens != null ? obj.outputTokens : obj.output_tokens);
      if (!total) total = input + output;
    }
    const model = obj.model || (obj.config && obj.config.model) || '';
    if (limit <= 0 && total <= 0) return null;
    return { limit: limit, total: total, input: input, output: output, model: model };
  }

  function scanValue(value, depth, seen, hits) {
    if (!value || depth > 6 || hits.length > 12) return;
    if (typeof value !== 'object') return;
    try {
      if (seen.has(value)) return;
      seen.add(value);
    } catch (_) { return; }

    try {
      const status = extractTokenStatus(value);
      if (status && (status.limit > 0 || status.total > 0)) hits.push(status);
    } catch (_) {}

    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(value.length, 40); i++) scanValue(value[i], depth + 1, seen, hits);
      return;
    }

    let keys;
    try { keys = Object.keys(value); } catch (_) { return; }
    for (let i = 0; i < keys.length && hits.length < 12; i++) {
      const k = keys[i];
      if (!/(token|usage|context|model|last|turn|conversation|thread|memo|state|store|query|data|config)/i.test(k)) continue;
      try { scanValue(value[k], depth + 1, seen, hits); } catch (_) {}
    }
  }

  function scanFiber() {
    const hits = [];
    const seen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    function walk(node, depth) {
      if (!node || depth > 70 || hits.length > 12) return;
      try {
        scanValue(node.memoizedProps, 0, seen || new Set(), hits);
        // linked list memoizedState
        let st = node.memoizedState;
        let guard = 0;
        while (st && guard++ < 40 && hits.length < 12) {
          scanValue(st.memoizedState, 0, seen || new Set(), hits);
          scanValue(st.queue, 0, seen || new Set(), hits);
          st = st.next;
        }
      } catch (_) {}
      walk(node.child, depth + 1);
      walk(node.sibling, depth);
    }
    try {
      const root = window.__codexRoot && window.__codexRoot._internalRoot && window.__codexRoot._internalRoot.current;
      if (root) walk(root, 0);
    } catch (_) {}
    return hits;
  }

  function applyNativeHits(hits) {
    if (!hits || !hits.length) return;
    // prefer hit with largest limit / total
    hits.sort((a, b) => (b.limit || 0) - (a.limit || 0) || (b.total || 0) - (a.total || 0));
    const best = hits[0];
    if (best.model) state.model = String(best.model);
    if (best.limit > 0) state.limit = best.limit;
    else if (state.model) state.limit = modelLimit(state.model);
    if (best.total > 0) {
      // totalTokens in last_token_usage is the current context occupancy
      state.used = Math.max(state.used, best.total);
      renderContext();
      // if total grew, treat as turn usage update (delta unknown => show absolute total)
      if (!state.lastTurn || best.total !== (state.lastTurn.usage && state.lastTurn.usage.total)) {
        // only show float when we also have input/output; otherwise just context bar
        if (best.input || best.output) {
          showUsage({ input: best.input, output: best.output, total: best.total, cached: 0 }, state.model, null);
        }
      }
    } else {
      renderContext();
    }
  }

  // Detect model label from DOM (e.g. GPT-PRO-1, gpt-5.x)
  function detectModelFromDom() {
    try {
      const buttons = document.querySelectorAll('button,span,div');
      for (let i = 0; i < buttons.length; i++) {
        const t = (buttons[i].textContent || '').trim().replace(/\s+/g, ' ');
        if (!t || t.length > 40) continue;
        if (/gpt-pro|gpt-plus|gpt-5|gpt-4|o3|o4|codex|claude|gemini|deepseek/i.test(t)) {
          // ignore long Chinese UI labels
          if (/[\u4e00-\u9fff]/.test(t) && !/gpt|o3|o4|claude|gemini/i.test(t)) continue;
          return t;
        }
      }
    } catch (_) {}
    return '';
  }

  // Collect usages from arbitrary payloads (backup for rare page-side traffic)
  function collectUsages(value, depth, seen, out) {
    if (value == null || depth > 7 || out.length > 20) return;
    if (typeof value === 'string') {
      if (value.length > 2000000) return;
      if (!/(usage|input_tokens|output_tokens|total_tokens|prompt_tokens|completion_tokens|last_token)/i.test(value)) return;
      try {
        if (value.charAt(0) === '{' || value.charAt(0) === '[') collectUsages(JSON.parse(value), depth + 1, seen, out);
      } catch (_) {
        const lines = value.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const m = line.match(/^data:\s*(\{.*\})\s*$/);
          if (m) {
            try { collectUsages(JSON.parse(m[1]), depth + 1, seen, out); } catch (_) {}
          }
        }
      }
      return;
    }
    if (typeof value !== 'object') return;
    try {
      if (seen.has(value)) return;
      seen.add(value);
    } catch (_) { return; }

    // last_token_usage + modelContextWindow pair
    try {
      const status = extractTokenStatus(value);
      if (status && status.total > 0) {
        out.push({
          usage: { input: status.input, output: status.output, total: status.total, cached: 0 },
          model: status.model || state.model,
          limit: status.limit
        });
      }
    } catch (_) {}

    const u = normalizeUsage(value.usage || value.tokenUsage || value.token_usage || value.last || value.last_token_usage || value);
    if (u) {
      const model = value.model || (value.response && value.response.model) || state.model;
      out.push({ usage: u, model: model });
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(value.length, 80); i++) collectUsages(value[i], depth + 1, seen, out);
      return;
    }
    let keys;
    try { keys = Object.keys(value); } catch (_) { return; }
    for (let i = 0; i < keys.length && out.length < 20; i++) {
      const k = keys[i];
      if (!/(usage|token|context|response|message|event|delta|data|payload|result|body|last|info|turn|item)/i.test(k)) continue;
      try { collectUsages(value[k], depth + 1, seen, out); } catch (_) {}
    }
  }

  function handlePayload(text, url) {
    const out = [];
    collectUsages(text, 0, typeof WeakSet !== 'undefined' ? new WeakSet() : new Set(), out);
    if (!out.length) return;
    // pick largest total
    out.sort((a, b) => (b.usage.total || 0) - (a.usage.total || 0));
    const best = out[0];
    if (best.limit > 0) state.limit = best.limit;
    showUsage(best.usage, best.model || state.model, null);
  }

  // Shared net handlers (may rarely catch traffic)
  window.__codexLauncherNetHandlers = window.__codexLauncherNetHandlers || [];
  if (!window.__codexLauncherUsageCoreHandlerReg) {
    window.__codexLauncherUsageCoreHandlerReg = true;
    window.__codexLauncherNetHandlers.push(function (text, url) {
      try { handlePayload(text, url); } catch (_) {}
    });
  }

  if (!window.__codexLauncherNetHooked) {
    window.__codexLauncherNetHooked = true;
    function dispatchNet(text, url) {
      const hs = window.__codexLauncherNetHandlers || [];
      for (let i = 0; i < hs.length; i++) {
        try { hs[i](text, url); } catch (_) {}
      }
    }
    try {
      const originalFetch = window.fetch;
      if (typeof originalFetch === 'function') {
        window.fetch = async function () {
          const args = arguments;
          const response = await originalFetch.apply(this, args);
          try {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            response.clone().text().then(function (t) { dispatchNet(t, url); }).catch(function () {});
          } catch (_) {}
          return response;
        };
      }
    } catch (_) {}
  }

  // Keep UI alive + periodic native scan
  if (!window.__codexLauncherUsageCoreLoop) {
    window.__codexLauncherUsageCoreLoop = true;
    setInterval(function () {
      try {
        ensureBalance();
        ensureContext();
        const m = detectModelFromDom();
        if (m && m !== state.model) {
          state.model = m;
          state.limit = modelLimit(m);
          renderContext();
        }
        const hits = scanFiber();
        if (hits && hits.length) applyNativeHits(hits);
        else renderContext();
      } catch (_) {}
    }, 1500);
  }

  // initial mount
  try {
    ensureBalance();
    ensureContext();
    const m = detectModelFromDom();
    if (m) {
      state.model = m;
      state.limit = modelLimit(m);
    }
    renderContext();
    if (window.__codexLauncherLastBalance) {
      renderBalance({ loggedIn: true, balanceText: window.__codexLauncherLastBalance });
    }
    if (typeof window.__codexLauncherRequest === 'function') {
      window.__codexLauncherRequest('/balance/get', {}, 5000).then(function (res) {
        if (res && res.ok) renderBalance(res.data || res);
      }).catch(function () {});
    }
  } catch (_) {}

  try { console.log('[CodexLauncher] usage core ready'); } catch (_) {}
})();
