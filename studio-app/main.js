/* Notal AI Studio v2 — the Windows app.

   What lives here: a loopback server that serves the chat app and answers as its
   own relay, the main window, the Quick Chat overlay, the tray, global
   shortcuts, desktop notifications, the update check, and native Save dialogs.

   What does NOT live here: a second copy of the chat. The web app at the repo
   root is the only place the conversation, the providers, the code canvas or the
   themes are implemented — sync-web.js brings those files in, so the desktop
   shell and the site can never drift apart. Quick Chat sends its questions into
   that same running engine over IPC and streams the answer back. */
"use strict";
const {
  app, BrowserWindow, Menu, Tray, Notification, globalShortcut,
  ipcMain, shell, dialog, nativeImage, session, screen,
} = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");

const relay = require("./studio-relay");

const APP_NAME = "Notal AI Studio";
const VERSION = require("./package.json").version;
/* A fixed loopback port is what gives the desktop app a stable origin. Firebase
   authorises sign-in per origin, and the whole app keeps its chats, models and
   keys in localStorage, which is keyed to the origin — a random port would look
   like a brand-new install on every launch and lose all of it. */
const PORT = 4179;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHAT_URL = `${ORIGIN}/chat/`;
const QUICK_URL = `${ORIGIN}/studio/quick`;

const WEB_DIR = app.isPackaged ? path.join(__dirname, "app-web") : path.resolve(__dirname, "..");
const QUICK_DIR = path.join(__dirname, "quick");
const SKILLS_DEFAULT = path.join(__dirname, "skills-default.md");
const UPDATE_FEED = "https://api.github.com/repos/batbleseed/notal-ai-ui/releases/latest";
const UPDATE_CACHE_MS = 12 * 60 * 60 * 1000;

const DIAG_FLAGS = ["--smoke", "--quick", "--relay"];
const DIAG = process.argv.find(a => DIAG_FLAGS.includes(a)) || null;

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".md": "text/markdown; charset=utf-8",
  ".woff2": "font/woff2",
};

let mainWin = null, quickWin = null, tray = null;
let quitting = false, quickPinned = false, engineBusy = false;
const hotkeys = new Map();          // accel -> { label, ok, error }
const permissionsAsked = [];        // so the smoke report can say what was wanted
const update = { checkedAt: null, latest: null, url: null, notes: null, error: null, current: VERSION };

/* ---------------- the Studio brief and skills.md ----------------
   The app's own prompts stay in prompts.js. On top of them the desktop build
   adds what is only true here — there is a local relay, a Quick Chat, files can
   be saved to disk — and the owner's skills.md, read fresh from disk every
   request so an edit takes effect without a restart. */
function skillsPath() { return path.join(app.getPath("userData"), "skills.md"); }

function ensureSkillsFile() {
  const target = skillsPath();
  try {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(SKILLS_DEFAULT, target);
    }
  } catch { /* a skills file that cannot be written is not worth losing a launch */ }
  return target;
}

function readSkills() {
  try {
    const text = fs.readFileSync(skillsPath(), "utf8");
    return text.length > 24_000 ? text.slice(0, 24_000) + "\n…(skills.md is longer than the app will read)" : text;
  } catch { return ""; }
}

function studioBrief() {
  const skills = readSkills().trim();
  return `

## You are running inside Notal AI Studio for Windows

- This is the desktop app, not a browser tab. It has its own relay on this
  machine, so requests, pages and local models are all reachable.
- The user can reach you from Quick Chat (Alt+Space) without opening the main
  window. Keep answers that come through Quick Chat short and self-contained:
  there is no scrolling room for a preamble.
- Chats can be saved out as real files. When the user asks for a document, give
  one block of Markdown they can save, and say what to name it.
- Generated code lands in a canvas with line numbers, Download and a Preview that
  runs HTML, CSS and JavaScript in a sandbox. Write one complete file per block
  and name the language.
- The machine is the user's own. Never suggest a workaround that requires
  anything they have not installed.

${skills ? `## Skills from skills.md\nThe user keeps these instructions in a file on disk\n(${skillsPath()}):\n\n${skills}` : ""}`;
}

/* ---------------- the server ---------------- */
function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

function inside(dir, wanted) {
  const file = path.resolve(dir, wanted);
  return file === dir || file.startsWith(dir + path.sep) ? file : null;
}

function route(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, ORIGIN).pathname); }
  catch { return relay.json(res, 400, { error: "bad request path" }); }

  const send = (status, obj) => relay.json(res, status, obj);

  if (req.method === "POST" && pathname === "/relay") return relay.handleRelay(req, res);
  if (req.method === "POST" && pathname === "/browse") return relay.handleBrowse(req, res);
  if (req.method === "GET" && pathname === "/health")
    return relay.handleHealth(res, { version: VERSION, platform: process.platform, name: APP_NAME, local: true });

  if (pathname === "/studio/prompt") return send(200, { prompt: studioBrief(), skills: Boolean(readSkills().trim()) });
  if (pathname === "/studio/skills") return send(200, { path: skillsPath(), content: readSkills() });
  if (pathname === "/studio/ollama") return relay.handleOllama(req, res);
  if (pathname === "/studio/health")
    return send(200, { ok: true, version: VERSION, name: APP_NAME, platform: process.platform,
      packaged: app.isPackaged, webDir: path.relative(path.resolve(__dirname, ".."), WEB_DIR) || ".",
      skillsPath: skillsPath(), hotkeys: [...hotkeys.entries()].map(([accel, h]) => ({ accel, ...h })),
      update, quickChat: Boolean(quickWin && quickWin.isVisible()), engineBusy });

  /* Quick Chat is served from this folder, everything else from the web app. */
  if (pathname === "/studio/quick" || pathname === "/studio/quick/")
    return serveFile(res, path.join(QUICK_DIR, "index.html"));
  if (pathname.startsWith("/studio/quick/")) {
    const file = inside(QUICK_DIR, pathname.slice("/studio/quick/".length));
    return file ? serveFile(res, file) : send(400, { error: "bad path" });
  }

  if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: "use GET" });
  const wanted = pathname.replace(/^\/+/, "");
  const target = inside(WEB_DIR, wanted || "index.html");
  if (!target) return send(400, { error: "outside the app folder" });
  try {
    if (fs.statSync(target).isDirectory()) return serveFile(res, path.join(target, "index.html"));
  } catch { /* falls through to the file read, which answers 404 */ }
  return serveFile(res, target);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      /* one bad page read must never take the app down with it */
      Promise.resolve(route(req, res)).catch(err => {
        if (!res.headersSent) relay.json(res, 500, { error: String(err && err.message || err) });
        else res.destroy();
      });
    });
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

/* ---------------- windows ---------------- */
const PREFS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: path.join(__dirname, "preload.js"),
  spellcheck: true,
};

function iconImage() {
  const mark = path.join(WEB_DIR, "icons", "notal-mark.png");
  const full = path.join(WEB_DIR, "icons", "icon-512.png");
  for (const file of [mark, full]) {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img;
  }
  return null;
}

function trayImage() {
  const img = iconImage();
  if (!img) return nativeImage.createEmpty();
  const size = 20;
  const scaled = img.getSize().width > size ? img.resize({ width: size, height: size }) : img;
  return scaled;
}

/* Google sign-in runs through a popup, so the auth flow has to get through;
   every other link belongs in the system browser. */
function isAuthPopup(url) {
  if (url.startsWith("about:")) return true;
  try {
    const host = new URL(url).hostname;
    return host === "accounts.google.com" || host.endsWith(".firebaseapp.com");
  } catch { return false; }
}

function guardWindow(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAuthPopup(url)) return { action: "allow" };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (new URL(url).origin === ORIGIN) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: "#262624",
    icon: iconImage() || undefined,
    title: APP_NAME,
    show: false,
    autoHideMenuBar: false,
    webPreferences: PREFS,
  });
  guardWindow(win);
  win.once("ready-to-show", () => win.show());
  win.webContents.on("did-finish-load", () => {
    if (DIAG === "--smoke") setTimeout(() => runDiagnostics(win, smokeProbe, { settingsTab: "desktop" }), 1200);
    win.flashFrame(false);
  });
  win.on("focus", () => win.flashFrame(false));
  /* Closing the window sends it to the tray. The engine has to stay alive for
     Quick Chat to have something to ask, and a chat you were reading should not
     vanish because you hit the X. Quitting is the tray's job. */
  win.on("close", (e) => {
    if (quitting || DIAG) return;
    e.preventDefault();
    win.hide();
    showTrayHintOnce();
  });
  win.on("hide", () => rebuildTrayMenu());
  return win;
}

let quickHintShown = false;
function showTrayHintOnce() {
  if (quickHintShown || !(tray && Notification.isSupported())) return;
  quickHintShown = true;
  new Notification({
    title: APP_NAME + " is still running",
    body: "It lives in the tray now. Alt+Space opens Quick Chat; right-click the tray icon to quit.",
  }).show();
}

function createQuickWindow() {
  const win = new BrowserWindow({
    width: 580,
    height: 420,
    minWidth: 380,
    minHeight: 260,
    parent: undefined,
    frame: false,
    transparent: false,
    backgroundColor: "#1b1a18",
    icon: iconImage() || undefined,
    title: APP_NAME + " — Quick Chat",
    show: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    maximizable: false,
    webPreferences: { ...PREFS, spellcheck: true },
  });
  guardWindow(win);
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  placeQuick(win);
  /* an overlay you are not typing in should get out of the way */
  win.on("blur", () => { if (!quickPinned && win.isVisible()) win.hide(); });
  win.on("show", () => { win.webContents.send("studio:quick-focus-input"); rebuildTrayMenu(); });
  win.on("hide", () => rebuildTrayMenu());
  win.on("closed", () => { quickWin = null; });
  return win;
}

function placeQuick(win) {
  const area = screen.getPrimaryDisplay().workArea;
  const [w, h] = win.getSize();
  win.setBounds({ x: Math.round(area.x + (area.width - w) / 2), y: area.y + Math.round(area.height * 0.08), width: w, height: h });
}

function toggleQuick(show = !quickWin?.isVisible()) {
  if (!quickWin) quickWin = createQuickWindow();
  if (quickWin.webContents.isLoading()) quickWin.loadURL(QUICK_URL);
  if (show) {
    if (!quickWin.isVisible()) { placeQuick(quickWin); quickWin.show(); }
    quickWin.focus();
  } else quickWin.hide();
}

/* ---------------- tray ---------------- */
function trayActions() {
  const hk = (id) => [...hotkeys.entries()].find(([, h]) => h.id === id);
  const label = (id, base) => {
    const found = hk(id);
    if (!found) return base;
    return found[1].ok ? `${base}	${found[0]}` : `${base} (another app holds ${found[0]})`;
  };
  const enabled = (id) => {
    const found = hk(id);
    return !found || found[1].ok;
  };
  return {
    quick: { label: label("quick", "Quick Chat"), id: "quick", ok: enabled("quick") },
    newChat: { label: label("new-chat", "New chat"), id: "new-chat", ok: enabled("new-chat") },
    export: { label: label("export", "Save this chat…"), id: "export", ok: enabled("export") },
    updates: { label: update.error ? "Check for updates (last check failed)"
      : update.latest ? `Update available — v${update.latest}` : "Check for updates", id: "updates", ok: true },
  };
}

function rebuildTrayMenu() {
  if (!tray) return;
  const a = trayActions();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: APP_NAME, enabled: false },
    { label: mainWin && mainWin.isVisible() ? "Hide window" : "Show window",
      click: () => (mainWin && mainWin.isVisible() ? mainWin.hide() : showMain()) },
    { label: a.quick.label, enabled: a.quick.ok, click: () => toggleQuick(true) },
    { type: "separator" },
    { label: a.newChat.label, enabled: a.newChat.ok, click: () => runAction("new-chat") },
    { label: a.export.label, enabled: a.export.ok, click: () => runAction("export") },
    { label: "Open skills.md", click: () => openSkills() },
    { type: "separator" },
    { label: a.updates.label, click: () => checkForUpdates({ manual: true }) },
    { label: `Version ${VERSION}`, enabled: false },
    { type: "separator" },
    { label: "Quit " + APP_NAME, click: () => { quitting = true; app.quit(); } },
  ]));
  tray.setToolTip(mainWin && mainWin.isVisible() ? APP_NAME : `${APP_NAME} — Quick Chat is Alt+Space`);
}

function createTray() {
  tray = new Tray(trayImage());
  tray.on("click", () => (mainWin && mainWin.isVisible() ? mainWin.hide() : showMain()));
  tray.on("double-click", () => toggleQuick(true));
  tray.on("right-click", () => tray.popUpContextMenu());
  rebuildTrayMenu();
}

function showMain() {
  if (!mainWin) mainWin = createMainWindow();
  if (mainWin.isMinimized()) mainWin.restore();
  if (!mainWin.isVisible()) mainWin.show();
  mainWin.focus();
}

function openSkills() {
  ensureSkillsFile();
  shell.openPath(skillsPath());
}

/* ---------------- menu ---------------- */
function buildMenu() {
  const a = () => trayActions();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "Studio",
      submenu: [
        { label: "Quick Chat", accelerator: "Alt+Space", click: () => toggleQuick(true) },
        { label: "New chat", accelerator: "Ctrl+Alt+N", click: () => runAction("new-chat") },
        { label: "Save this chat…", accelerator: "Ctrl+Alt+E", click: () => runAction("export") },
        { label: "Toggle dark / light", click: () => runAction("toggle-theme") },
        { label: "Open skills.md", click: () => openSkills() },
        { type: "separator" },
        { label: "Check for updates", click: () => checkForUpdates({ manual: true }) },
        { type: "separator" },
        { role: "quit", label: "Quit " + APP_NAME },
      ],
    },
    { label: "File", submenu: [{ role: "close" }] },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "delete" },
        { type: "separator" }, { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" }, { role: "forceReload" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
        { role: "toggleDevTools" }, { role: "togglefullscreen" },
      ],
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { label: "Quick Chat", click: () => toggleQuick(true) }, { role: "close" }] },
    {
      label: "Help",
      submenu: [
        { label: "Notal AI on GitHub", click: () => shell.openExternal("https://github.com/batbleseed/notal-ai-ui") },
        { label: `About ${APP_NAME} ${VERSION}`, enabled: false },
      ],
    },
  ]));
}

/* ---------------- global shortcuts ---------------- */
const SHORTCUTS = [
  { accel: "Alt+Space", id: "quick", label: "Quick Chat" },
  { accel: "Ctrl+Alt+N", id: "new-chat", label: "New chat" },
  { accel: "Ctrl+Alt+E", id: "export", label: "Save this chat" },
  { accel: "Ctrl+Alt+U", id: "updates", label: "Check for updates" },
];

function registerShortcuts() {
  for (const s of SHORTCUTS) {
    let ok = false, error = null;
    try {
      ok = globalShortcut.register(s.accel, () => runAction(s.id));
      if (!ok) error = "another app already answers that combination";
    } catch (err) { error = String(err && err.message || err); }
    hotkeys.set(s.accel, { id: s.id, label: s.label, ok, error });
  }
  rebuildTrayMenu();
}

function runAction(id) {
  if (id === "quick") return toggleQuick(true);
  if (id === "updates") return checkForUpdates({ manual: true });
  if (id === "toggle-theme") { showMain(); return sendAction("toggle-theme"); }
  if (id === "new-chat") { showMain(); return sendAction("new-chat"); }
  if (id === "export") {
    requestExport().then((r) => {
      if (r.saved) notify(APP_NAME, "Chat saved to " + r.path);
      else if (r.error) notify(APP_NAME, "Could not save the chat: " + r.error);
    });
    return;
  }
}

function sendAction(name) {
  if (!mainWin) return false;
  mainWin.webContents.send("studio:action", name);
  return true;
}

/* ---------------- notifications ---------------- */
function notify(title, body) {
  if (!Notification.isSupported()) return false;
  new Notification({ title, body: String(body || "").slice(0, 220) }).show();
  return true;
}

/* ---------------- update check ---------------- */
function parseVersion(tag) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(tag || ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function updateCachePath() { return path.join(app.getPath("userData"), "studio-updates.json"); }

function loadUpdateCache() {
  try { Object.assign(update, JSON.parse(fs.readFileSync(updateCachePath(), "utf8"))); } catch { /* never checked */ }
}

function saveUpdateCache() {
  try { fs.writeFileSync(updateCachePath(), JSON.stringify(update)); } catch { /* not worth a dialog */ }
}

async function checkForUpdates({ manual = false } = {}) {
  if (manual) notify(APP_NAME, "Checking GitHub for a newer build…");
  try {
    const res = await fetch(UPDATE_FEED, { headers: { "user-agent": `Notal-AI-Studio/${VERSION}`, accept: "application/vnd.github+json" } });
    if (res.status === 404) {
      Object.assign(update, { checkedAt: Date.now(), latest: null, error: null, note: "nothing has been published as a release yet" });
      if (manual) notify(APP_NAME, `Version ${VERSION} is the newest there is — no release has been published for this app yet.`);
    } else if (!res.ok) {
      throw new Error(`GitHub answered ${res.status}`);
    } else {
      const data = await res.json();
      const tag = data.tag_name || data.name || "";
      Object.assign(update, {
        checkedAt: Date.now(), error: null, note: null,
        latest: parseVersion(tag) ? `${parseVersion(tag).join(".")}` : null,
        url: data.html_url || null,
        notes: (data.body || "").slice(0, 600),
        name: data.name || tag,
      });
      if (update.latest && isNewer(update.latest, VERSION)) {
        notify(APP_NAME, `v${update.latest} is out — you are on ${VERSION}. Opening the release page.`);
        if (update.url) shell.openExternal(update.url);
      } else if (manual) {
        notify(APP_NAME, `You are up to date (v${VERSION}).`);
      }
    }
  } catch (err) {
    update.error = String(err && err.message || err);
    update.checkedAt = Date.now();
    if (manual) notify(APP_NAME, `Could not check for updates: ${update.error}`);
  }
  saveUpdateCache();
  rebuildTrayMenu();
  return update;
}

/* ---------------- export: the main window holds the chat, so ask it ---------------- */
let exportWaiters = [];

function requestExport() {
  showMain();
  return new Promise((resolve) => {
    if (!mainWin) { resolve({ saved: false, error: "the window is not open" }); return; }
    const timer = setTimeout(() => {
      exportWaiters = exportWaiters.filter(w => w.resolve !== resolve);
      resolve({ saved: false, error: "the chat did not answer" });
    }, 4000);
    exportWaiters.push({ resolve, timer });
    mainWin.webContents.send("studio:action", "export-request");
  });
}

/* ---------------- IPC ---------------- */
function wireIpc() {
  ipcMain.on("studio:engine-busy", (e, busy) => { engineBusy = Boolean(busy); });

  ipcMain.handle("studio:save-file", async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWin;
    const name = String(payload?.suggestedName || "notal-chat.md").replace(/[\\/:*?"<>|]/g, "-").slice(0, 120);
    const text = String(payload?.text ?? "");
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: payload?.title || "Save",
      defaultPath: name,
      filters: payload?.format === "json"
        ? [{ name: "JSON", extensions: ["json"] }, { name: "All files", extensions: ["*"] }]
        : [{ name: "Markdown", extensions: ["md", "txt"] }, { name: "All files", extensions: ["*"] }],
    });
    if (canceled || !filePath) return { saved: false, canceled: true };
    try {
      fs.writeFileSync(filePath, text, "utf8");
      return { saved: true, path: filePath, bytes: Buffer.byteLength(text) };
    } catch (err) {
      return { saved: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle("studio:open-path", (e, p) => shell.openPath(String(p)));
  ipcMain.on("studio:show-main", () => showMain());
  ipcMain.handle("studio:info", () => ({
    version: VERSION, name: APP_NAME, platform: process.platform,
    packaged: app.isPackaged, skillsPath: skillsPath(), userData: app.getPath("userData"),
  }));
  ipcMain.handle("studio:notify", (e, { title, body }) => notify(String(title || APP_NAME), body));
  ipcMain.handle("studio:check-updates", () => checkForUpdates({ manual: true }));
  ipcMain.handle("studio:skills-path", () => ({ path: ensureSkillsFile(), content: readSkills() }));
  ipcMain.handle("studio:hotkeys", () => [...hotkeys.entries()].map(([accel, h]) => ({ accel, ...h })));
  ipcMain.handle("studio:quick-state", () => ({ busy: engineBusy, mainVisible: Boolean(mainWin && mainWin.isVisible()) }));

  ipcMain.on("studio:export-payload", (e, payload) => {
    const waiter = exportWaiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    const name = (payload?.title || "notal-chat").slice(0, 60) + (payload?.format === "json" ? ".json" : ".md");
    const win = BrowserWindow.fromWebContents(e.sender) || mainWin;
    dialog.showSaveDialog(win, {
      title: "Save this chat",
      defaultPath: name.replace(/[\\/:*?"<>|]/g, "-"),
      filters: payload?.format === "json"
        ? [{ name: "JSON", extensions: ["json"] }]
        : [{ name: "Markdown", extensions: ["md", "txt"] }],
    }).then(({ canceled, filePath }) => {
      if (canceled || !filePath) return waiter.resolve({ saved: false, canceled: true });
      try {
        fs.writeFileSync(filePath, String(payload?.text ?? ""), "utf8");
        waiter.resolve({ saved: true, path: filePath });
      } catch (err) { waiter.resolve({ saved: false, error: String(err && err.message || err) }); }
    });
  });

  /* Quick Chat asks, the main window's engine answers, the tokens travel back. */
  ipcMain.on("studio:quick-send", (e, job) => {
    if (!mainWin) mainWin = createMainWindow();
    engineBusy = true;
    mainWin.webContents.send("studio:quick-run", { id: job.id, text: String(job.text || "") });
  });
  ipcMain.on("studio:quick-cancel", (e, job) => {
    if (mainWin) mainWin.webContents.send("studio:quick-cancel", { id: job.id });
  });
  ipcMain.on("studio:quick-hide", () => { if (quickWin) quickWin.hide(); });
  ipcMain.on("studio:quick-open", () => toggleQuick(true));
  ipcMain.on("studio:quick-pin", (e, pinned) => {
    quickPinned = Boolean(pinned);
    if (quickWin) quickWin.setAlwaysOnTop(true, pinned ? "screen-saver" : "floating");
  });
  for (const kind of ["chunk", "reasoning", "done"]) {
    ipcMain.on(`studio:quick-${kind}`, (e, payload) => {
      if (kind === "done") engineBusy = false;
      if (quickWin && quickWin.isVisible()) quickWin.webContents.send("studio:quick-event", { kind, ...payload });
      else if (kind === "done" && mainWin && !mainWin.isFocused())
        notify(APP_NAME, String(payload?.text || "Reply ready").slice(0, 180));
    });
  }
}

/* ---------------- permissions ---------------- */
function askPermissions() {
  const ses = session.defaultSession;
  const allow = new Set(["notifications", "clipboard-sanitized-write", "media", "display-media", "fullscreen"]);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    permissionsAsked.push(permission);
    callback(allow.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission) => allow.has(permission));
  /* the microphone is usable in Electron, but Chromium's speech recognition is
     not — it belongs to Google's service, which this app does not have. The
     permission is granted so recording still works for anything that transcribes
     through a provider. */
}

/* ---------------- diagnostics ---------------- */
/* A packaged Windows .exe is a GUI program with no console attached, so printing
   is not enough to see a result. Every diagnostic also lands in the app's data
   folder, which is what makes `Notal AI Studio.exe --smoke` useful on an install. */
function finishDiag(label, report) {
  const file = path.join(diagDir(), `studio-diag${DIAG}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    report.diagFile = file;
  } catch { /* the printout still stands on its own */ }
  console.log(label + " " + JSON.stringify(report, null, 2));
  app.exit(report.error ? 1 : 0);
}

/* Packaged, the app folder is inside a read-only archive, so anything a
   diagnostic produces goes next to skills.md instead. */
function diagDir() { return app.getPath("userData"); }

function smokeProbe() {
  const shown = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    return getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden";
  };
  const state = JSON.parse(localStorage.getItem("notal.state") || "{}");
  return {
    title: document.title,
    appLoaded: typeof window.relayBase === "function",
    desktopBridge: Boolean(window.notal && window.notal.desktop),
    relayChosen: window.relayBase ? window.relayBase() : null,
    stylesApplied: getComputedStyle(document.querySelector(".app")).display === "flex",
    sidebarVisible: shown("#sidebar"),
    composerVisible: shown("#composer"),
    theme: document.documentElement.dataset.theme || null,
    mode: state.mode || null,
    conversations: (state.conversations || []).length,
    models: (state.models || []).length,
    providers: (state.providers || []).length,
    speechRecognition: "SpeechRecognition" in window || "webkitSpeechRecognition" in window,
    mediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
    notifications: typeof Notification !== "undefined" ? Notification.permission : "absent",
    secureContext: window.isSecureContext === true,
    clipboard: Boolean(navigator.clipboard?.writeText),
    swScope: null,
    canvasApi: Boolean(window.syntaxNodes),
  };
}

async function runDiagnostics(win, probe, opts = {}) {
  const report = { url: win.webContents.getURL() };
  try {
    Object.assign(report, await win.webContents.executeJavaScript(`(${probe.toString()})()`, true));
    report.swScope = (await win.webContents.executeJavaScript(
      `(async()=>(await navigator.serviceWorker.getRegistration())?.scope||null)()`, true));
    const png = await win.webContents.capturePage();
    report.screenshot = path.join(diagDir(), "render-check.png");
    fs.writeFileSync(report.screenshot, png.toPNG());

    if (opts.settingsTab) {
      /* the Desktop tab only exists once app.js sees window.notal, so this is
         the one view that proves the two halves are wired to each other */
      report.tabShown = await win.webContents.executeJavaScript(
        `openSettings(${JSON.stringify(opts.settingsTab)}); ` +
        `!document.getElementById("panel-${opts.settingsTab}")?.hidden`, true);
      /* the local-model line waits on a 1.5s probe of Ollama's port */
      await new Promise(r => setTimeout(r, 2400));
      const shot = await win.webContents.capturePage();
      report.settingsShot = path.join(diagDir(), "render-check-settings.png");
      fs.writeFileSync(report.settingsShot, shot.toPNG());
      report.lines = await win.webContents.executeJavaScript(
        `Object.fromEntries(["studioRelayLine","studioHotkeys","studioSkills","studioOllama","studioUpdate","studioPaths"]` +
        `.map(id => [id, (document.getElementById(id)?.textContent || "").replace(/\\s+/g," ").trim()]))`, true);
    }
  } catch (err) {
    report.error = String(err && err.stack || err);
  }
  finishDiag("DIAGNOSTICS", report);
}

/* Drives a whole Quick Chat round trip: question in the overlay, tokens back out
   of the main window's engine, answer landed in the conversation. It runs on the
   built-in reply path so the test spends no one's API quota, and it puts the
   model selection back the way it found it. */
async function quickRoundTrip() {
  const report = {};
  const overlayLogs = [];
  try {
    const pick = await mainWin.webContents.executeJavaScript(`(function () {
      const b = (state.models || []).find(m => m.provider === "Notal built-in");
      if (!b) return { ok: false, models: (state.models || []).map(m => m.provider) };
      const had = state.selectedModel;
      state.selectedModel = b.id; save();
      return { ok: true, had, chosen: b.name };
    })()`, true);
    report.setup = pick;
    if (!pick.ok) throw new Error("this profile has no built-in model to test with: " + JSON.stringify(pick.models));

    quickWin = createQuickWindow();
    quickWin.webContents.on("console-message", (...a) =>
      overlayLogs.push(a.slice(1).map(String).join(" ").slice(0, 220)));
    quickWin.loadURL(QUICK_URL);
    await new Promise(r => quickWin.webContents.once("did-finish-load", r));
    await new Promise(r => setTimeout(r, 500));
    quickWin.show();
    report.quickLoaded = quickWin.webContents.getURL();

    /* Type in the box and submit the form, the way a person does — calling
       quickSend() directly would skip the overlay's own rendering and prove
       nothing about what the overlay shows. */
    report.roundTrip = await Promise.race([
      quickWin.webContents.executeJavaScript(`(async () => {
      const settled = await new Promise((resolve) => {
        const stop = window.notal.onQuickEvent((ev) => {
          if (ev.kind === "done") { stop(); resolve(ev); }
        });
        setTimeout(() => { stop(); resolve({ timedOut: true }); }, 25000);
        document.querySelector("#qInput").value = "say hi from quick chat";
        document.querySelector("#qForm").requestSubmit();
      });
      return { chars: (settled.text || "").length, error: settled.error || null,
        timedOut: settled.timedOut || false,
        onScreen: (document.querySelector("#qThread")?.textContent || "").replace(/\\s+/g, " ").slice(0, 220),
        stillThinking: document.querySelector("#qHead")?.classList.contains("thinking"),
        turns: document.querySelectorAll(".q-turn").length,
        metaLines: document.querySelectorAll(".q-meta").length,
        stopHidden: document.querySelector("#qStop")?.hidden,
        stopDisplay: getComputedStyle(document.querySelector("#qStop")).display,
        sendDisabled: document.querySelector("#qSend")?.disabled };
    })()`, true),
      /* if the overlay's script is missing, the form submits for real and takes
         the page with it — then this await would never come back. */
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("the overlay never finished a round trip — quick.js is not running in it")),
        35000)),
    ]);
    /* quick.js fills the model line as soon as it runs; an empty one means the
       overlay loaded as a dead page. */
    report.quickScriptRan = await quickWin.webContents.executeJavaScript(
      `(document.querySelector("#qModel")?.textContent || "").trim().length > 0`, true);

    /* Shot before anything else touches a window: the overlay hides when it loses
       focus, and capturePage() on a hidden frameless window never answers. The
       short wait lets the last paint commit — without it the frame still shows
       the answer arriving rather than the finished thread. */
    await new Promise(r => setTimeout(r, 400));
    try {
      const png = await Promise.race([
        quickWin.capturePage(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("capture timed out")), 5000)),
      ]);
      report.shot = path.join(diagDir(), "render-check-quick.png");
      fs.writeFileSync(report.shot, png.toPNG());
    } catch (err) {
      report.shot = "no shot: " + (err?.message || err);
    }

    report.landed = await mainWin.webContents.executeJavaScript(`(function () {
      const conv = activeConv();
      const msgs = conv ? conv.messages : [];
      return { conversations: state.conversations.length, messages: msgs.length,
        lastUser: (msgs.filter(m => m.role === "user").pop() || {}).text || null,
        lastAssistant: ((msgs.filter(m => m.role === "assistant").pop() || {}).text || "").slice(0, 120) };
    })()`, true);

    await mainWin.webContents.executeJavaScript(
      `state.selectedModel = ${JSON.stringify(pick.had)}; save(); "restored"`, true);
    report.restored = true;
  } catch (err) {
    report.error = String(err && err.stack || err);
  }
  report.overlayLogs = overlayLogs.slice(0, 10);
  finishDiag("QUICKDIAG", report);
}

/* Proves the built-in relay without opening a window: a real page read, a
   provider call with a deliberately wrong key (the provider's own auth error
   coming back is what shows forwarding and status passthrough work), and a
   stream test against a local mock if one is listening. */
async function relayDiag() {
  const out = { origin: ORIGIN };
  const post = async (p, body) => {
    const r = await fetch(ORIGIN + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try {
    out.health = await (await fetch(ORIGIN + "/health")).json();
    const page = await post("/browse", { url: "https://example.com/" });
    out.browse = { status: page.status, ok: page.json?.ok, title: /<title>([^<]*)</.exec(page.json?.html || "")?.[1] || null, bytes: (page.json?.html || "").length, error: page.json?.error || null };
    out.browsePrivate = await post("/browse", { url: "http://127.0.0.1:" + PORT + "/health" });
    const bad = await post("/relay", {
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": "notal-studio-diag", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: { model: "claude-3-5-haiku-latest", max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
    });
    out.relay = { status: bad.status, providerError: bad.json?.error?.type || bad.json?.error?.message || bad.json };
    const blocked = await post("/relay", { url: "http://example.com/", body: {} });
    out.relayRefusesPlainHttp = blocked.status === 403;
    out.skills = (await (await fetch(ORIGIN + "/studio/skills")).json()).path;
    out.prompt = (await (await fetch(ORIGIN + "/studio/prompt")).json()).prompt.length;
    out.ollama = await (await fetch(ORIGIN + "/studio/ollama")).json();
    /* every page and asset the two windows load, by the URL each one asks for.
       A 404 here means the overlay opens with no script and no sheet. */
    const wanted = ["/chat/", "/styles.css", "/app.js", "/studio/quick",
      "/studio/quick/quick.js", "/studio/quick/quick.css"];
    const answered = await Promise.all(wanted.map(async (p) =>
      [p, (await fetch(ORIGIN + p)).status]));
    out.assets = Object.fromEntries(answered);
  } catch (err) {
    out.error = String(err && err.stack || err);
  }
  finishDiag("RELAYDIAG", out);
}

/* ---------------- boot ---------------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName(APP_NAME);
  app.on("second-instance", () => {
    if (process.argv.some(a => DIAG_FLAGS.includes(a))) return;
    const wantQuick = process.argv.includes("--from-quick");
    if (wantQuick) toggleQuick(true);
    else showMain();
  });

  app.whenReady().then(async () => {
    let server;
    try {
      server = await startServer();
    } catch (err) {
      const busy = err.code === "EADDRINUSE";
      dialog.showErrorBox(APP_NAME + " cannot start", busy
        ? `Port ${PORT} is already taken by something else, and ${APP_NAME} needs it to keep your chats between launches.\n\nClose whatever is using that port and start the app again.`
        : String(err && err.message || err));
      app.exit(1);
      return;
    }

    ensureSkillsFile();
    loadUpdateCache();
    askPermissions();
    app.setAppUserModelId("ai.notal.studio");

    if (DIAG === "--relay") { await relayDiag(); return; }

    buildMenu();
    wireIpc();
    mainWin = createMainWindow();
    mainWin.loadURL(CHAT_URL);
    createTray();
    registerShortcuts();

    if (!DIAG) setTimeout(() => {
      if (!update.checkedAt || Date.now() - update.checkedAt > UPDATE_CACHE_MS) checkForUpdates({});
    }, 9000);

    if (DIAG === "--quick") setTimeout(() => quickRoundTrip(), 2500);
    app.on("before-quit", () => { quitting = true; server.close(); });
  });

  /* closing the last window does not close the app: the tray and Quick Chat are
     the reason it is still there, and "Quit" in either one is the way out */
  app.on("window-all-closed", () => {});
  app.on("will-quit", () => globalShortcut.unregisterAll());
}
