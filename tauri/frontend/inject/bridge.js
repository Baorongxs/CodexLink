(() => {
  const BINDING = '__codexLauncherBridge';
  window.__codexLauncherCallbacks = window.__codexLauncherCallbacks || new Map();
  window.__codexLauncherSeq = Number(window.__codexLauncherSeq || 0);

  window.__codexLauncherRequest = function requestHost(path, body, timeoutMs) {
    timeoutMs = timeoutMs || 12000;
    return new Promise((resolve) => {
      const id = String(++window.__codexLauncherSeq);
      const payload = { id: id, path: path, payload: body || {}, ts: Date.now() };
      const finish = (result) => {
        try { window.__codexLauncherCallbacks.delete(id); } catch (_) {}
        resolve(result || { ok: false, error: 'empty' });
      };
      const timer = timeoutMs > 0
        ? window.setTimeout(() => finish({ ok: false, error: 'bridge_timeout' }), timeoutMs)
        : 0;
      window.__codexLauncherCallbacks.set(id, { resolve: finish, timer: timer });
      try {
        const binding = window[BINDING];
        if (typeof binding === 'function') {
          binding(JSON.stringify(payload));
          return;
        }
        finish({ ok: false, error: 'binding_missing' });
      } catch (error) {
        finish({ ok: false, error: String(error && error.message || error) });
      }
    });
  };

  window.__codexLauncherResolve = function resolveHost(raw) {
    try {
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const entry = window.__codexLauncherCallbacks.get(String(data && data.id));
      if (!entry) return;
      if (entry.timer) window.clearTimeout(entry.timer);
      entry.resolve(data.result || data);
    } catch (_) {}
  };

  if (!window.__codexLauncherBridgeMsgHooked) {
    window.__codexLauncherBridgeMsgHooked = true;
    window.addEventListener('message', (event) => {
      const data = event && event.data;
      if (!data || data.type !== 'codex-launcher-bridge-result') return;
      window.__codexLauncherResolve(data);
    }, true);
  }

  window.__codexLauncherBridgeInstalled = true;
})();
