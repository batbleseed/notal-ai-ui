/* Notal AI — the companion's background worker.

   Two things happen here: work is aimed at a tab (read it, map what is clickable,
   click, type), and a tab is moved (open, navigate, close). Everything a page
   would resent — its own text, and the label of whatever is about to be pressed —
   comes back with the result, so Notal can show the user what actually happened
   rather than what the model meant.

   It is a service worker, so it starts and stops between messages and keeps no
   state worth trusting. Each function handed to chrome.scripting has to stand on
   its own: it is serialized and run in the target page, so it cannot call back
   into this file. */

/* Set once per Notal tab so a listing can say which tab is the one asking. */
const notalTabs = new Set();

const PAGE_LIMIT = 20000;
const ELEMENT_LIMIT = 120;
const NAVIGATE_MS = 12000;

/* ---------- which pages may ask ----------
   Installed from the Chrome Web Store this extension sits beside nothing, so
   there is no folder that says which page is Notal. The address is asked for
   instead: a page on localhost or 127.0.0.1 is taken as Notal's own — a local
   server is one this machine started — and anything else the user wants to use
   is typed onto the options page, which is also what injects the bridge there.
   A page opened straight off disk is deliberately not trusted: any downloaded
   .html would otherwise be able to drive the other tabs. */
const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const DEV_PATTERNS = [
  "http://localhost/*", "http://127.0.0.1/*", "http://[::1]/*",
  "https://localhost/*", "https://127.0.0.1/*", "https://[::1]/*",
];
const BRIDGE_ID = "notal-bridge";

/* origins the user added, e.g. a Notal hosted on github.io */
let extraOrigins = new Set();

function normalizeOrigin(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return null; }
  /* the whole address is accepted because that is what a person copies out of a
     bar, but only the origin is kept: trust is per site, not per page */
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.hostname.includes("*")) return null;
  return u.origin;
}

function bridgePatterns() {
  return [...new Set([...DEV_PATTERNS, ...[...extraOrigins].map(o => `${o}/*`)])];
}

async function syncBridge() {
  /* registering twice under one id is an error, so this replaces its own record
     each time rather than adding to it */
  await chrome.scripting.unregisterContentScripts({ id: BRIDGE_ID }).catch(() => {});
  await chrome.scripting.registerContentScripts([{
    id: BRIDGE_ID, matches: bridgePatterns(), js: ["bridge.js"],
    run_at: "document_idle", all_frames: false,
  }]);
  return [...extraOrigins];
}

async function loadAllow() {
  const stored = await chrome.storage.sync.get(["notalOrigins"]);
  const list = Array.isArray(stored?.notalOrigins) ? stored.notalOrigins : [];
  extraOrigins = new Set(list.map(normalizeOrigin).filter(Boolean));
  return [...extraOrigins];
}

function senderAllowed(sender) {
  let u;
  try { u = new URL(sender?.url || ""); } catch { return false; }
  if (DEV_HOSTS.has(u.hostname.replace(/^\[|\]$/g, "").toLowerCase())) return true;
  return extraOrigins.has(u.origin);
}

/* Nothing is answered before the list has been read: an early "not allowed" is
   better than a reply given while the rules were still unknown. */
const allowReady = loadAllow().then(syncBridge).catch(() => []);

chrome.runtime.onInstalled.addListener(() => { allowReady.then(syncBridge); });
chrome.runtime.onStartup.addListener(() => { allowReady.then(syncBridge); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !("notalOrigins" in changes)) return;
  loadAllow().then(syncBridge).catch(() => {});
});

/* A page that was already open has no bridge in it, because injection happens
   when a document loads. This is the button on the options page that fixes that
   without asking the user to go hunting for the tab. */
async function rebindOpenTabs() {
  await allowReady;
  const tabs = await chrome.tabs.query({});
  const hit = [];
  for (const t of tabs) {
    if (!t.id || !senderAllowed({ url: t.url })) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["bridge.js"] });
      hit.push({ id: t.id, url: t.url });
    } catch { /* a tab that refuses injection is not Notal's, so it is left alone */ }
  }
  return { rebound: hit.length, tabs: hit };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.notalPlugin !== 1) return;
  /* the options page belongs to this extension and has no tab of its own, so it
     is answered on its address rather than as a page asking for work */
  if (msg.method === "rebind" && sender?.url === chrome.runtime.getURL("options.html")) {
    rebindOpenTabs().then(
      (result) => sendResponse({ notalPlugin: 1, ok: true, result }),
      (err) => sendResponse({ notalPlugin: 1, ok: false, error: String(err?.message || err) })
    );
    return true;
  }
  if (!msg.id || !msg.method) return;
  /* only a content script has a tab — a message that arrives without one did not
     come through the bridge, and this worker does not answer it */
  if (!sender?.tab?.id) return;

  allowReady.then(async () => {
    if (!senderAllowed(sender)) {
      const origin = (() => { try { return new URL(sender.url).origin; } catch { return "that page"; } })();
      throw new Error(`${origin} was never given to this companion — add it on the extension's options page.`);
    }
    return handle(msg.method, msg.args || {}, sender.tab.id);
  }).then(
    (result) => sendResponse({ notalPlugin: 1, replyTo: msg.id, ok: true, result }),
    (err) => sendResponse({ notalPlugin: 1, replyTo: msg.id, ok: false,
      error: String(err?.message || err) })
  );
  /* the reply is async, and the channel only stays open if this says so */
  return true;
});

chrome.tabs.onRemoved.addListener((id) => notalTabs.delete(id));

async function handle(method, args, fromTab) {
  notalTabs.add(fromTab);
  if (method === "ping") return { extension: "notal-browser",
    version: chrome.runtime.getManifest().version };
  if (method === "tabs") {
    const tabs = await chrome.tabs.query({});
    return { tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url,
      active: t.active, notal: notalTabs.has(t.id) })) };
  }
  const tab = await resolveTab(args.tab, fromTab);
  if (method === "read") { assertReadable(tab); return inTab(tab, readPage, [PAGE_LIMIT]); }
  if (method === "snapshot") { assertReadable(tab); return inTab(tab, mapPage, [ELEMENT_LIMIT, 3000]); }
  if (method === "open") {
    const url = requireUrl(args.url);
    /* a background tab: the user keeps the focus they had, and Notal gets the
       number it needs to act on the page it just opened */
    const created = await chrome.tabs.create({ url, active: false });
    await settled(created.id);
    return { tab: created.id, url: created.url };
  }
  if (method === "navigate") {
    const url = requireUrl(args.url);
    await chrome.tabs.update(tab.id, { url });
    await settled(tab.id);
    return { tab: tab.id, url: (await chrome.tabs.get(tab.id)).url };
  }
  if (method === "click") {
    flash(tab.id);
    const out = await inTab(tab, pressThing, [args.index, args.expect]);
    await aBeat();
    return { ...out, url: (await chrome.tabs.get(tab.id)).url };
  }
  if (method === "type") {
    flash(tab.id);
    const out = await inTab(tab, writeThing, [args.index, String(args.text ?? ""), !!args.submit]);
    if (args.submit) await aBeat();
    return { ...out, url: (await chrome.tabs.get(tab.id)).url };
  }
  if (method === "close") {
    const url = tab.url;
    await chrome.tabs.remove(tab.id);
    return { closed: true, url };
  }
  throw new Error(`the companion has no "${method}" action`);
}

function requireUrl(url) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) throw new Error("only an http(s) address can be opened");
  return u;
}

/* Without a number, the tab meant is the one the user was last looking at — but
   never Notal's own tab, which is where the request came from. */
async function resolveTab(tabId, fromTab) {
  if (tabId != null && tabId !== "") {
    const t = await chrome.tabs.get(Number(tabId)).catch(() => null);
    if (!t) throw new Error(`there is no tab ${tabId} open any more`);
    return t;
  }
  const candidates = (await chrome.tabs.query({ currentWindow: true }))
    .filter(t => t.id !== fromTab && !t.url?.startsWith("chrome://"));
  const active = candidates.find(t => t.active) ?? candidates.at(-1);
  if (!active) throw new Error("no other tab to work on — open one first, or say which tab to read");
  return active;
}

function assertReadable(tab) {
  if (/^(chrome|about|edge|devtools|chrome-extension|view-source):/i.test(tab.url || ""))
    throw new Error(`the browser does not let an extension read ${tab.url || "that page"} — its own screens are kept from every add-on`);
}

async function inTab(tab, func, args) {
  assertReadable(tab);
  const [out] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  if (out?.error) throw new Error(String(out.error.message || out.error));
  if (!out?.result) throw new Error("that page gave back nothing to read");
  return out.result;
}

/* The badge is the only signal the user gets that something is happening in a tab
   they are not looking at, so it goes on for the actions that move the page. */
function flash(tabId) {
  chrome.action.setBadgeText({ text: "notal", tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#c2593a", tabId }).catch(() => {});
  setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }).catch(() => {}), 6000);
}

const aBeat = () => new Promise(r => setTimeout(r, 700));

/* A click can start a navigation, and the URL reported back should be the page
   the user ends up on rather than the one they left. */
function settled(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(watch);
      resolve();
    };
    const watch = (id, change) => { if (id === tabId && change.status === "complete") finish(); };
    chrome.tabs.onUpdated.addListener(watch);
    setTimeout(finish, NAVIGATE_MS);
  });
}

/* ---------- the functions that run inside the other page ----------
   Each is standalone, and each answers with what it found rather than what it was
   told to do, so a page that changed underneath the model surfaces as a refusal
   with the page's own words in it. */

function readPage(limit) {
  const text = (document.body?.innerText || "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { title: document.title, url: location.href, text: text.slice(0, limit) };
}

function labelFor(el) {
  return (el.getAttribute("aria-label") || el.title || el.placeholder ||
    (el.innerText || "").trim() || el.getAttribute("alt") || el.getAttribute("name") ||
    el.tagName.toLowerCase());
}

function mapPage(elementLimit, textLimit) {
  const selector = [
    "a[href]", "button", "input", "textarea", "select", "summary", "details",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]",
    "[role=textbox]", "[role=combobox]", "[role=menuitem]", "[role=switch]",
    "[contenteditable=true]", "[onclick]",
  ].join(",");
  const seen = new Set();
  const items = [];
  for (const el of document.querySelectorAll(selector)) {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (!box.width || !box.height) continue;
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (el.disabled) continue;
    const name = labelFor(el).replace(/\s+/g, " ").trim().slice(0, 80);
    /* the same control appears twice when it is wrapped — a link inside a card
       with its own click handler — and the user cannot tell those apart either */
    const key = `${el.tagName}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const index = items.length;
    el.setAttribute("data-notal-index", String(index));
    items.push({
      index,
      role: el.tagName.toLowerCase() + (el.type ? `:${el.type}` : "") +
        (el.getAttribute("role") ? `(${el.getAttribute("role")})` : ""),
      name,
      value: el.value != null && el.value !== "" ? String(el.value).slice(0, 40) : "",
      href: el.tagName === "A" && el.href ? el.href : "",
    });
    if (items.length >= elementLimit) break;
  }
  return {
    title: document.title,
    url: location.href,
    elements: items.length,
    items,
    text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, textLimit),
  };
}

function describe(el) {
  const kind = el.tagName.toLowerCase() === "input" ? `${el.type} field` : el.tagName.toLowerCase();
  return `${kind} "${labelFor(el).replace(/\s+/g, " ").trim().slice(0, 80)}"`;
}

function findThing(index, expect) {
  const wanted = String(expect || "").replace(/\s+/g, " ").trim().toLowerCase();
  /* matched by the attribute's own value: an index is a number the page was told,
     and a quoted selector built from model text is a way to break on a stray digit */
  const el = [...document.querySelectorAll("[data-notal-index]")]
    .find(node => node.getAttribute("data-notal-index") === String(index));
  if (!el) throw new Error(`nothing is numbered ${index} on this page — it was mapped before the last change, map it again`);
  const found = labelFor(el).replace(/\s+/g, " ").trim().toLowerCase();
  if (wanted && !found.includes(wanted) && !wanted.includes(found))
    throw new Error(`number ${index} is now ${describe(el)}, not "${expect}" — the page has changed, map it again before acting`);
  return el;
}

function pressThing(index, expect) {
  const el = findThing(index, expect);
  el.scrollIntoView({ block: "center", behavior: "instant" });
  const what = describe(el);
  el.click();
  return { describe: what };
}

function writeThing(index, text, submit) {
  const el = findThing(index, null);
  if (el.tagName === "INPUT" && el.type === "password")
    throw new Error("that is a password field — the companion will not type into one, and neither should you");
  const what = describe(el);
  el.focus();
  if (el.isContentEditable) el.textContent = text;
  else {
    /* the value has to arrive the way a keyboard puts it there, or a page built on
       React or Vue keeps its own old copy of the field and ignores the change */
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text); else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (submit) el.dispatchEvent(new KeyboardEvent("keydown",
    { key: "Enter", code: "Enter", bubbles: true }));
  return { describe: what };
}
