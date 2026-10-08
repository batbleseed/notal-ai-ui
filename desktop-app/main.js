const { app, BrowserWindow, Menu, shell, session } = require("electron");
const path = require("path");
const fs = require("fs");

const WEB_DIR = path.resolve(__dirname, "..");
const ENTRY = path.join(WEB_DIR, "chat.html");
const DIAG_PROBES = { "--smoke": smokeProbe, "--probe": probeProviders };
const DIAG_MODE = Object.keys(DIAG_PROBES).find(flag => process.argv.includes(flag)) || null;

// Providers check the Origin header before answering. A file:// window sends
// "file://", which they refuse, so the header is rewritten to the origin the
// keys already work from. Override with NOTAL_WEB_ORIGIN for another host.
const WEB_ORIGIN = process.env.NOTAL_WEB_ORIGIN || "https://batbleseed.github.io";

function installOriginFix() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "origin" && headers[key] === "file://") headers[key] = WEB_ORIGIN;
    }
    callback({ requestHeaders: headers });
  });
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "File", submenu: [{ role: "quit" }] },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" }, { role: "forceReload" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
        { role: "toggleDevTools" }, { role: "togglefullscreen" }
      ]
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }] }
  ]));
}

// Runs inside the page, so it cannot touch Node. Returned facts are printed by --smoke.
function smokeProbe() {
  const out = {};
  const shown = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    return getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden";
  };
  out.title = document.title;
  out.appLoaded = typeof window.relayBase === "function";
  out.stateLoaded = typeof state === "object" && state !== null;
  out.sidebarVisible = shown("#sidebar");
  out.composerVisible = shown("#composer");
  out.modelPicker = document.querySelector(".model-name")?.textContent ?? null;
  out.greeting = document.querySelector("#greetingTitle")?.textContent ?? null;
  out.historyItems = document.querySelectorAll("#historyList .history-item").length;
  out.installBtnHidden = document.querySelector("#amInstallBtn")?.hidden ?? null;
  out.theme = document.documentElement.dataset.theme ?? null;
  out.standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  out.dictation = "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
  try {
    localStorage.setItem("notal.smoke", "1");
    out.storagePersists = localStorage.getItem("notal.smoke") === "1";
    localStorage.removeItem("notal.smoke");
  } catch (err) {
    out.storagePersists = false;
    out.storageError = String(err && err.message);
  }
  return out;
}

// Runs inside the page with deliberately invalid keys: a 401/400 means the
// provider accepted the request far enough to answer (CORS passed), while
// "Failed to fetch" means the browser blocked it before it left the window.
function probeProviders() {
  const bad = "notal-desktop-cors-probe";
  const targets = [
    ["anthropic", "https://api.anthropic.com/v1/messages",
      { "content-type": "application/json", "x-api-key": bad, "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true" },
      { model: "claude-3-5-haiku-latest", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }],
    ["openai", "https://api.openai.com/v1/chat/completions",
      { "content-type": "application/json", authorization: "Bearer " + bad },
      { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }],
    ["gemini", "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
      { "content-type": "application/json", "x-goog-api-key": bad },
      { contents: [{ parts: [{ text: "hi" }] }] }]
  ];
  return Promise.all(targets.map(([name, url, headers, body]) =>
    fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
      .then(r => ({ [name]: "HTTP " + r.status }))
      .catch(err => ({ [name]: "blocked: " + (err && err.message || err) }))
  )).then(r => Object.assign({}, ...r));
}

async function runDiagnostics(win, probe) {
  const report = { entry: ENTRY, exists: fs.existsSync(ENTRY) };
  try {
    Object.assign(report, await win.webContents.executeJavaScript(`(${probe.toString()})()`, true));
    const png = await win.webContents.capturePage();
    const shot = path.join(__dirname, "render-check.png");
    fs.writeFileSync(shot, png.toPNG());
    report.screenshot = shot;
  } catch (err) {
    report.error = String(err && err.stack || err);
  }
  console.log("DIAGNOSTICS " + JSON.stringify(report, null, 2));
  app.exit(0);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: "#262624",
    icon: path.join(WEB_DIR, "icons", "icon-512.png"),
    title: "Notal AI",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });

  win.once("ready-to-show", () => win.show());

  win.webContents.on("did-finish-load", () => {
    if (DIAG_MODE) setTimeout(() => runDiagnostics(win, DIAG_PROBES[DIAG_MODE]), 1500);
  });

  // Links leave the app; nothing else is allowed to navigate the window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.loadFile(ENTRY);
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName("Notal AI");
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    installOriginFix();
    buildMenu();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => app.quit());
}
