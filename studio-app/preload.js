/* The only door between the chat app and Windows.

   The renderer keeps running with nodeIntegration off and sandbox on, exactly
   as it does in a browser tab — it has no require, no fs, no Electron. Anything
   it can do on the desktop is a named method on window.notal, and every one of
   them either goes over IPC to the main process or is a fact about this build.

   Nothing here changes how the chat works. It is the same app.js in both places;
   this bridge is what lets it save a file, answer Quick Chat, or light up a tray
   icon when it is finished thinking. */
const { contextBridge, ipcRenderer } = require("electron");

/* Quick Chat ids are made here so a question and its answer tokens cannot be
   confused with another job, e.g. when two asks land in the same second. */
let jobSeq = 0;

function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("notal", {
  desktop: true,
  /* the main process answers these, so nothing here repeats a version number
     that lives in package.json */
  info: () => ipcRenderer.invoke("studio:info"),
  /* the relay this app runs for itself, on this machine */
  relayOrigin: "http://127.0.0.1:4179",

  /* ---- desktop services ---- */
  saveFile: (payload) => ipcRenderer.invoke("studio:save-file", payload),
  notify: (title, body) => ipcRenderer.invoke("studio:notify", { title, body }),
  checkUpdates: () => ipcRenderer.invoke("studio:check-updates"),
  skillsInfo: () => ipcRenderer.invoke("studio:skills-path"),
  hotkeys: () => ipcRenderer.invoke("studio:hotkeys"),
  quickState: () => ipcRenderer.invoke("studio:quick-state"),
  openPath: (p) => ipcRenderer.invoke("studio:open-path", p),
  showMain: () => ipcRenderer.send("studio:show-main"),
  engineBusy: (busy) => ipcRenderer.send("studio:engine-busy", Boolean(busy)),

  /* ---- the main window: things the tray and the shortcuts ask it to do ---- */
  onAction: (handler) => on("studio:action", handler),
  sendExport: (payload) => ipcRenderer.send("studio:export-payload", payload),
  onQuickRun: (handler) => on("studio:quick-run", handler),
  onQuickCancel: (handler) => on("studio:quick-cancel", handler),
  quickChunk: (id, text) => ipcRenderer.send("studio:quick-chunk", { id, text }),
  quickReasoning: (id, text) => ipcRenderer.send("studio:quick-reasoning", { id, text }),
  quickDone: (id, payload) => ipcRenderer.send("studio:quick-done", { id, ...payload }),

  /* ---- the Quick Chat overlay ---- */
  quickSend: (text) => {
    const id = ++jobSeq;
    ipcRenderer.send("studio:quick-send", { id, text });
    return id;
  },
  quickCancel: (id) => ipcRenderer.send("studio:quick-cancel", { id }),
  quickHide: () => ipcRenderer.send("studio:quick-hide"),
  openQuick: () => ipcRenderer.send("studio:quick-open"),
  setPinned: (pinned) => ipcRenderer.send("studio:quick-pin", Boolean(pinned)),
  onQuickEvent: (handler) => on("studio:quick-event", handler),
  onQuickFocusInput: (handler) => on("studio:quick-focus-input", handler),
});
