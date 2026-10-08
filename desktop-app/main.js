const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");

const WEB_DIR = path.resolve(__dirname, "..");
const DIAG_PROBES = { "--smoke": smokeProbe, "--probe": probeProviders, "--auth": probeAuth };
const DIAG_MODE = Object.keys(DIAG_PROBES).find(flag => process.argv.includes(flag)) || null;

const PORT = 4178;

// Firebase authorizes sign-in by origin and refuses file://, and the app keeps
// its whole state in localStorage, which is keyed to the origin. Serving over a
// fixed loopback port gives the desktop app a real origin that stays the same
// across launches, so history and keys survive restarts.
const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let wanted;
      try {
        wanted = decodeURIComponent(new URL(req.url, "http://localhost").pathname).replace(/^\/+/, "");
      } catch {
        res.writeHead(400).end("Bad request path");
        return;
      }
      const file = path.resolve(WEB_DIR, wanted || "index.html");
      if (!file.startsWith(WEB_DIR + path.sep)) {
        res.writeHead(403).end("Outside the app folder");
        return;
      }
      fs.stat(file, (statErr, stats) => {
        const target = !statErr && stats.isDirectory() ? path.join(file, "index.html") : file;
        fs.readFile(target, (err, data) => {
          if (err) {
            res.writeHead(404).end("Not found");
            return;
          }
          res.writeHead(200, { "content-type": MIME[path.extname(target)] || "application/octet-stream" });
          res.end(data);
        });
      });
    });
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolve(server));
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
async function smokeProbe() {
  const out = {};
  const shown = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    return getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden";
  };
  out.title = document.title;
  out.appLoaded = typeof window.relayBase === "function";
  out.stylesApplied = getComputedStyle(document.querySelector(".app")).display === "flex";
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
  out.secureContext = window.isSecureContext === true;
  out.webCrypto = !!window.crypto?.subtle;
  try {
    localStorage.setItem("notal.smoke", "1");
    out.storagePersists = localStorage.getItem("notal.smoke") === "1";
    localStorage.removeItem("notal.smoke");
  } catch (err) {
    out.storagePersists = false;
    out.storageError = String(err && err.message);
  }
  out.swScope = (await navigator.serviceWorker.getRegistration())?.scope ?? null;
  return out;
}

// Runs inside the page with deliberately invalid keys: a 401/400 means the
// provider accepted the request far enough to answer (CORS passed), while
// "Failed to fetch" means the window blocked it before it left the app.
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

// Starts the real Google sign-in flow but never enters credentials: the point
// is to see whether Firebase accepts this origin at all.
function probeAuth() {
  return ensureAuth().then(({ auth, mods }) => {
    const settled = mods.signInWithPopup(auth, new mods.GoogleAuthProvider())
      .then(() => ({ auth: "signed in without anyone typing a password, which should not happen" }))
      .catch(err => ({ auth: "rejected: " + (err && err.code || err) }));
    return Promise.race([settled, new Promise(r => setTimeout(() => r({ auth: "popup stayed open, so the origin was accepted" }), 9000))]);
  }).catch(err => ({ auth: "could not start: " + (err && err.message || err) }));
}

async function runDiagnostics(win, probe) {
  const report = { url: win.webContents.getURL() };
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

// Firebase's Google sign-in runs through a popup window, so the auth flow has
// to get through; every other link belongs in the system browser.
function isAuthPopup(url) {
  if (url.startsWith("about:")) return true;
  try {
    const host = new URL(url).hostname;
    return host === "accounts.google.com" || host.endsWith(".firebaseapp.com");
  } catch {
    return false;
  }
}

function createWindow(appUrl) {
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

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAuthPopup(url)) return { action: "allow" };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  const appOrigin = new URL(appUrl).origin;
  win.webContents.on("will-navigate", (e, url) => {
    if (new URL(url).origin === appOrigin) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  win.loadURL(appUrl);
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

  app.whenReady().then(async () => {
    let server;
    try {
      server = await startServer();
    } catch (err) {
      const busy = err.code === "EADDRINUSE";
      dialog.showErrorBox("Notal AI cannot start", busy
        ? `Port ${PORT} is already taken by another program, and Notal AI needs it to keep your chats between launches.`
        : String(err && err.message || err));
      app.exit(1);
      return;
    }
    const appUrl = `http://localhost:${PORT}/chat/`;
    buildMenu();
    createWindow(appUrl);
    app.on("before-quit", () => server.close());
  });

  app.on("window-all-closed", () => app.quit());
}
