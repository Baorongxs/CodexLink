const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();

contextBridge.exposeInMainWorld('chrome', {
  webview: {
    postMessage(payload) {
      ipcRenderer.send('codexlink:message', payload);
    },
    addEventListener(type, callback) {
      if (type === 'message' && typeof callback === 'function') listeners.add(callback);
    },
    removeEventListener(type, callback) {
      if (type === 'message') listeners.delete(callback);
    }
  }
});

ipcRenderer.on('codexlink:host-message', (_event, data) => {
  for (const callback of listeners) {
    try { callback({ data }); } catch (_) {}
  }
});
