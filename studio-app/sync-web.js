/* Copies the web app into this folder so the desktop shell has something to
   serve, and so the installer has a snapshot it can put inside the package.
   The single source of truth stays at the repo root — chat/, styles.css, app.js
   and friends are never forked here, they are copied. Run before every start
   and before every build (npm does that through prestart/predist). */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const WEB_OUT = path.join(__dirname, "app-web");
const BUILD_OUT = path.join(__dirname, "build");

const FILES = [
  "index.html", "chat.html", "styles.css", "app.js", "prompts.js",
  "syntax.js", "sw.js", "manifest.webmanifest", "gsap.min.js",
];
const DIRS = ["icons", "chat"];

/* The landing page is the PWA entry in a browser; the desktop app opens the
   chat directly, but copying it costs nothing and keeps every link in the app
   pointing at something that exists. */
function copyAll() {
  fs.rmSync(WEB_OUT, { recursive: true, force: true });
  fs.mkdirSync(WEB_OUT, { recursive: true });
  const written = [];
  for (const name of FILES) {
    const src = path.join(ROOT, name);
    if (!fs.existsSync(src)) throw new Error(`missing ${name} — is this folder still inside the repo?`);
    fs.copyFileSync(src, path.join(WEB_OUT, name));
    written.push(name);
  }
  for (const name of DIRS) {
    fs.cpSync(path.join(ROOT, name), path.join(WEB_OUT, name), { recursive: true });
    written.push(name + "/");
  }
  return written;
}

/* electron-builder wants one icon of at least 256px and converts it to .ico
   for the exe, the installer and the shortcut. */
function copyInstallerIcon() {
  fs.mkdirSync(BUILD_OUT, { recursive: true });
  const src = path.join(ROOT, "icons", "icon-512.png");
  fs.copyFileSync(src, path.join(BUILD_OUT, "icon.png"));
  return path.join(BUILD_OUT, "icon.png");
}

const written = copyAll();
const icon = copyInstallerIcon();
console.log(`studio-app: served ${written.length} entries from the repo root into app-web/`);
console.log(`studio-app: installer icon ${path.relative(ROOT, icon)}`);
