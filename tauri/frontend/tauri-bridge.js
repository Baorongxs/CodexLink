(() => {
  const listeners = new Set();
  let listening = null;

  function ensureListening() {
    if (!listening) {
      listening = window.__TAURI__.event.listen('codexlink:host-message', (event) => {
        for (const callback of listeners) {
          try {
            callback({ data: event.payload });
          } catch (_) {}
        }
      });
    }
    return listening;
  }

  window.chrome = window.chrome || {};
  window.chrome.webview = {
    async postMessage(raw) {
      let payload = raw;
      if (typeof raw === 'string') {
        try {
          payload = JSON.parse(raw);
        } catch (_) {
          payload = { action: raw };
        }
      }
      try {
        await ensureListening();
        await window.__TAURI__.core.invoke('handle_action', { payload: payload || {} });
      } catch (error) {
        const data = {
          type: 'toast',
          error: true,
          message: String(error || '操作失败')
        };
        for (const callback of listeners) {
          try {
            callback({ data });
          } catch (_) {}
        }
      }
    },
    addEventListener(type, callback) {
      if (type === 'message' && typeof callback === 'function') {
        listeners.add(callback);
        ensureListening();
      }
    },
    removeEventListener(type, callback) {
      if (type === 'message') listeners.delete(callback);
    }
  };
})();
