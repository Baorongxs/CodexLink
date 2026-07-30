const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexMonitor", {
  getSnapshot: () => ipcRenderer.invoke("monitor:get-snapshot"),
  setExpanded: (expanded) => ipcRenderer.invoke("window:set-expanded", Boolean(expanded)),
  setPinned: (pinned) => ipcRenderer.invoke("window:set-pinned", Boolean(pinned)),
  setOpacity: (opacity) => ipcRenderer.invoke("window:set-opacity", Number(opacity)),
  beginDrag: (point) => ipcRenderer.invoke("window:drag-start", point),
  dragMove: (point) => ipcRenderer.send("window:drag-move", point),
  endDrag: () => ipcRenderer.send("window:drag-end"),
  quit: () => ipcRenderer.send("window:quit"),
  onSnapshot: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("monitor:snapshot", handler);
    return () => ipcRenderer.removeListener("monitor:snapshot", handler);
  },
  onAppCommand: (callback) => {
    const handler = (_event, command, payload) => callback(command, payload);
    ipcRenderer.on("app:command", handler);
    return () => ipcRenderer.removeListener("app:command", handler);
  }
});
