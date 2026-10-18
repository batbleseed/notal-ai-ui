/* ============ Notal AI workspace ============ */
const $ = (sel) => document.querySelector(sel);

const els = {
  sidebar: $("#sidebar"),
  sidebarClose: $("#sidebarClose"),
  sidebarOpen: $("#sidebarOpen"),
  newChat: $("#newChatBtn"),
  historyList: $("#historyList"),
  search: $("#searchChats"),
  chat: $("#chat"),
  greeting: $("#greeting"),
  greetingTitle: $("#greetingTitle"),
  suggestions: $("#suggestions"),
  messages: $("#messages"),
  composer: $("#composer"),
  input: $("#input"),
  sendBtn: $("#sendBtn"),
  modelPicker: $("#modelPicker"),
  modelMenu: $("#modelMenu"),
  modelName: $(".model-name"),
  modeSeg: $("#modeSeg"),
  main: $(".main"),
  topMark: $(".topbar .brand-logo"),
  shareBtn: $("#shareBtn"),
  fileInput: $("#fileInput"),
  attachTray: $("#attachTray"),
  micBtn: $("#micBtn"),
  toast: $("#toast"),
  lightbox: $("#lightbox"),
  lightboxImg: $("#lightboxImg"),
};

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2800);
}

/* ---------- motion ----------
   GSAP is vendored beside this file and loaded before it. The animations are
   decoration, so a missing GSAP must never take the chat down with it. */
const motion = (() => {
  if (typeof window.gsap !== "object") {
    return { reveal() {}, settle(el, done) { done?.(); } };
  }
  return {
    reveal(el) {
      gsap.fromTo(el, { opacity: 0, y: -6, scale: .98 },
        { opacity: 1, y: 0, scale: 1, duration: .34, ease: "back.out(2.4)" });
    },
    /* lets a panel drop away under its own weight, then restores it */
    settle(el, done) {
      gsap.to(el, {
        opacity: 0, y: 18, scale: .97,
        duration: .24, ease: "power2.in",
        onComplete: () => { gsap.set(el, { clearProps: "all" }); done?.(); },
      });
    },
  };
})();

const store = {
  load() {
    try { return JSON.parse(localStorage.getItem("notal.state")) ?? {}; }
    catch { return {}; }
  },
  save(state) {
    const write = () => localStorage.setItem("notal.state", JSON.stringify(state));
    try { write(); }
    catch {
      try {
        const light = JSON.parse(JSON.stringify(state));
        for (const c of light.conversations || [])
          for (const m of c.messages || [])
            for (const a of m.attachments || []) delete a.dataUrl;
        write();
      } catch { /* storage full or unavailable */ }
    }
  },
};

/* Firebase web config: public by design — access is enforced by
   auth provider settings + authorized domains in the Firebase console. */
const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyBLVOuRgiNaEwu-vEcRJPSeWxNtrWq3CyI",
  authDomain: "notal-ai-58caa.firebaseapp.com",
  projectId: "notal-ai-58caa",
  storageBucket: "notal-ai-58caa.firebasestorage.app",
  messagingSenderId: "202138488352",
  appId: "1:202138488352:web:d84f27b7c8009f60753645",
};

/* ---------- Supabase telemetry (`events` table) ----------
   Logs each completed AI reply to the Supabase `events` table
   (columns: type, model, tokens, latency_ms, device) in a fire-and-forget
   promise chain so it never blocks the chat UI. Works with the Supabase JS CDN
   (<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>)
   and automatically loads the CDN script if not already present in chat/index.html. */
const SUPABASE_URL = "https://YOUR_PROJECT_ID.supabase.co";
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";
const SUPABASE_CDN_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";

let supabaseClient = null;
let supabaseInitPromise = null;

function getSupabaseClient() {
  if (supabaseClient) return Promise.resolve(supabaseClient);
  if (
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY ||
    SUPABASE_URL.includes("YOUR_PROJECT_ID") ||
    SUPABASE_ANON_KEY.includes("YOUR_SUPABASE_ANON_KEY")
  ) {
    return Promise.resolve(null);
  }
  if (window.supabase && typeof window.supabase.createClient === "function") {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return Promise.resolve(supabaseClient);
  }
  if (!supabaseInitPromise) {
    supabaseInitPromise = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = SUPABASE_CDN_URL;
      s.async = true;
      s.onload = () => {
        if (window.supabase && typeof window.supabase.createClient === "function") {
          supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        }
        resolve(supabaseClient);
      };
      s.onerror = () => resolve(null);
      document.head.append(s);
    });
  }
  return supabaseInitPromise;
}

function detectNotalDevice() {
  if (typeof DESKTOP === "boolean" && DESKTOP) return "electron";
  if (window.notal && window.notal.desktop) return "electron";
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  if (/Electron/i.test(ua)) return "electron";
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return "mobile_web";
  return "web";
}

function estimateTokens(promptText = "", replyText = "") {
  const chars = String(promptText).length + String(replyText).length;
  return Math.max(1, Math.ceil(chars / 4));
}

function logNotalAiEvent({
  type = "ai_reply",
  model = "notal-generic",
  tokens = 0,
  latency_ms = 0,
  device = detectNotalDevice(),
} = {}) {
  const payload = {
    type: String(type),
    model: String(model),
    tokens: Number.isFinite(Number(tokens)) ? Math.round(Number(tokens)) : 0,
    latency_ms: Math.max(0, Math.round(Number(latency_ms) || 0)),
    device: String(device),
  };

  /* Fire-and-forget: detached promise chain so it never blocks UI rendering */
  getSupabaseClient()
    .then((client) => {
      if (!client) return null;
      return client.from("events").insert([payload]);
    })
    .then((res) => {
      if (res?.error) {
        console.warn("[Notal Telemetry] Supabase insert error:", res.error.message);
      }
    })
    .catch((err) => {
      console.warn("[Notal Telemetry] Failed to log event:", err?.message || err);
    });
}

/* Prompt add-ons the app ships with. Each one is a short instruction that
   rides in the system prompt while its switch is on; users write their own
   in Settings → Extensions. */
const BUILTIN_EXTENSIONS = [
  { id: "ext-terse", name: "Terse", desc: "Short answers, no filler.",
    prompt: "Answer in the fewest sentences that stay correct. No preamble, no sign-off, no restating the question." },
  { id: "ext-devil", name: "Devil's advocate", desc: "Challenge the idea before helping it.",
    prompt: "When the user proposes an idea, first make the strongest honest case against it, then help them build it anyway." },
  { id: "ext-teach", name: "Explain as you go", desc: "Every answer carries the why.",
    prompt: "After any code or plan, add a short 'Why' note covering the two or three decisions a reader would otherwise have to reverse-engineer." },
  { id: "ext-json", name: "Strict JSON", desc: "Replies parse with JSON.parse.",
    prompt: "Reply with a single valid JSON object and nothing else — no markdown fences, no prose outside the braces." },
  { id: "ext-dusk", name: "Sepia dusk", desc: "A warmer paper tone for the whole workspace.",
    prompt: "", builtin: true,
    ui: { css: ":root { --bg: #ece2cf; --surface: #f9f3e6; --surface-2: #e2d5bc; --border: #cfc0a4; }", html: "", js: "" } },
  { id: "ext-clock", name: "Status clock", desc: "A live clock at the end of the top bar.",
    prompt: "", builtin: true,
    ui: { css: "#ext-clock-time { margin-left: 12px; font-size: 12.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }",
      html: "",
      js: "const bar = document.querySelector('.topbar');\nif (bar && !document.getElementById('ext-clock-time')) {\n  const s = document.createElement('span');\n  s.id = 'ext-clock-time';\n  bar.append(s);\n  const tick = () => { s.textContent = new Date().toLocaleTimeString(); };\n  tick();\n  setInterval(tick, 1000);\n}" } },
  /* Not a look of its own: this one is the shelf the Theme maker writes its
     rules onto, so a theme has somewhere to live and something to publish. */
  { id: "ext-theme", name: "Theme", desc: "Colours and corners you picked right where you saw them.",
    prompt: "", builtin: true, themeMaker: true, theme: null,
    ui: { css: "", html: "", js: "" } },
];

/* What the Library group shows when the shared table can't be reached. */
const EXT_LIBRARY_SEED = [
  { libId: "lib-focus", name: "Focus frame", desc: "The sidebar dims until you reach for it.",
    prompt: "", ui: { css: ".sidebar { opacity: .72; transition: opacity .25s; }\n.sidebar:hover { opacity: 1; }", html: "", js: "" } },
  { libId: "lib-round", name: "Round everything", desc: "Softer corners across the workspace.",
    prompt: "", ui: { css: ":root { --radius: 22px; --radius-sm: 14px; --radius-xs: 10px; }", html: "", js: "" } },
  { libId: "lib-bigtype", name: "Big type", desc: "Larger, roomier message text.",
    prompt: "", ui: { css: ".msg-text { font-size: 17px; line-height: 1.75; }", html: "", js: "" } },
  { libId: "lib-serif", name: "Serif replies", desc: "Flowing prose, never bullet lists.",
    prompt: "Write replies in flowing prose with no bullet lists, headings or bold — the way a good essay reads.", ui: null },
  { libId: "lib-careful", name: "Careful answers", desc: "Names the assumption each answer rests on.",
    prompt: "Before answering, state the one assumption your answer depends on most; if it is wrong, say how the answer would change.", ui: null },
];

/* The shared library is one Supabase table reached over REST. This is the
   public anon key, and there is deliberately no settings field to type one in:
   the key is only ever as capable as the table lets it be, which is a read plus
   three guarded functions. */
const LIB_URL = "https://bgpptjdqosmzxbctclkv.supabase.co";
const LIB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJncHB0amRxb3NtenhiY3RjbGt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyNDM3NzYsImV4cCI6MjEwNzgxOTc3Nn0.evRfV8i4qYQ36Hfn23XkHLDoozq4wGgEOujThLDE0t8";

let state = Object.assign({
  conversations: [],
  activeId: null,
  theme: "light",
  displayName: "",
  models: [{ id: "notal-generic", name: "notal generic", provider: "Notal built-in" }],
  selectedModel: "notal-generic",
  providers: [],
  notifications: { enabled: false, sound: false },
  pinHash: null,
  idleLock: 0,
  projects: [],
  memories: [],
  skills: [],
  extensions: [],
  activeProject: null,
  relayUrl: "",
  showThinking: false,
  sidebarOpen: true,
  mode: "chat",
  relayVerified: null,
  advanced: {},
  /* the rows this browser published, and the one secret behind all of them —
     a card's creator is the signed-in account, never something typed */
  claims: {},
  makerSecret: "",
  /* the local model is a developer's feature: off until it is switched on in
     Settings, and the second flag only records that the weights are downloaded */
  localAI: false,
  localAIFiles: false,
}, store.load());

const GENERIC_MODEL = { id: "notal-generic", name: "notal generic", provider: "Notal built-in" };
if (!Array.isArray(state.models) || !state.models.length) state.models = [GENERIC_MODEL];
if (!state.models.some(m => m.id === "notal-generic")) state.models.unshift(GENERIC_MODEL);
if (!state.localAI) dropBrowserModel();
if (state.localAI && state.localAIFiles) addBrowserModel();
if (!state.models.some(m => m.id === state.selectedModel)) state.selectedModel = "notal-generic";
if (!Array.isArray(state.providers)) state.providers = [];
if (!state.firebaseConfig) state.firebaseConfig = DEFAULT_FIREBASE_CONFIG;
if (!state.notifications || typeof state.notifications !== "object")
  state.notifications = { enabled: false, sound: false };
if (typeof state.pinHash !== "string") state.pinHash = null;
if (typeof state.idleLock !== "number") state.idleLock = 0;
for (const k of ["projects", "memories", "skills"])
  if (!Array.isArray(state[k])) state[k] = [];
if (!Array.isArray(state.extensions)) state.extensions = [];
/* built-ins are seeded, not saved once: a future version can add one and it
   appears on the next load */
for (const b of BUILTIN_EXTENSIONS)
  if (!state.extensions.some(x => x.id === b.id))
    state.extensions.push({ ...b, builtin: true, enabled: false });
if (typeof state.makerSecret !== "string") state.makerSecret = "";
if (!state.claims || typeof state.claims !== "object") state.claims = {};
if (!state.projects.some(p => p.id === state.activeProject)) state.activeProject = null;
if (state.mode !== "chat" && state.mode !== "coding") state.mode = "chat";
if (!state.advanced || typeof state.advanced !== "object") state.advanced = {};
if (!state.relayVerified || typeof state.relayVerified !== "object") state.relayVerified = null;

function selectedModel() {
  return state.models.find(m => m.id === state.selectedModel) ?? state.models[0];
}

function save() { store.save(state); }

function activeConv() {
  return state.conversations.find(c => c.id === state.activeId) ?? null;
}

/* ---------- greeting ---------- */
function setGreeting() {
  const h = new Date().getHours();
  const part = h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  els.greetingTitle.textContent = `${part}, ${state.displayName || "there"}`;
}

/* ---------- conversations ---------- */
function newConversation() {
  const conv = { id: crypto.randomUUID(), title: "New chat", messages: [], createdAt: Date.now(),
    projectId: state.activeProject };
  state.conversations.unshift(conv);
  state.activeId = conv.id;
  save();
  setView("chats");
  renderHistory();
  renderMessages();
  els.input.focus();
}

function openConversation(id) {
  state.activeId = id;
  save();
  setView("chats");
  renderHistory();
  renderMessages();
}

function renderHistory(filter = "") {
  const q = filter.trim().toLowerCase();
  const items = state.conversations.filter(c =>
    (!state.activeProject || (c.projectId ?? null) === state.activeProject) &&
    (!q || c.title.toLowerCase().includes(q)));
  els.historyList.innerHTML = "";
  if (!items.length) {
    els.historyList.innerHTML = `<li class="history-empty">${q ? "No matching chats" : "No chats yet"}</li>`;
    return;
  }
  for (const c of items) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "history-item" + (c.id === state.activeId ? " active" : "");
    btn.innerHTML = `<span class="dot"></span>`;
    const span = document.createElement("span");
    span.textContent = c.title;
    span.style.overflow = "hidden";
    span.style.textOverflow = "ellipsis";
    btn.append(span);
    btn.addEventListener("click", () => openConversation(c.id));
    li.append(btn);
    els.historyList.append(li);
  }
}

/* ---------- messages ---------- */
function renderMessages() {
  const conv = activeConv();
  els.messages.innerHTML = "";
  /* the preview frames went away with the old nodes, so those cards are no
     longer anything to route messages to */
  liveCards.clear();
  const showGreeting = !conv || conv.messages.length === 0;
  els.greeting.hidden = !showGreeting;
  if (showGreeting) return;
  for (const m of conv.messages) appendMessage(m);
  scrollToBottom();
}

function fmtBytes(n) {
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n > 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

function renderAttachments(atts) {
  const tray = document.createElement("div");
  tray.className = "msg-attachments";
  for (const a of atts) {
    if (a.dataUrl && (a.type || "").startsWith("image/")) {
      const img = document.createElement("img");
      img.className = "att-img";
      img.src = a.dataUrl;
      img.alt = a.name;
      img.addEventListener("click", () => {
        els.lightboxImg.src = a.dataUrl;
        els.lightbox.hidden = false;
      });
      tray.append(img);
    } else {
      const chip = document.createElement("span");
      chip.className = "att-file";
      chip.textContent = `📄 ${a.name} · ${fmtBytes(a.size)}`;
      tray.append(chip);
    }
  }
  return tray;
}

/* ---------- markdown ----------
   Model output is untrusted text, so every node here is built with
   textContent — raw HTML in a reply can never become markup. */
const MD_BLOCK = /^ {0,3}(#{1,6}\s|>|```|([-*+]|\d+[.)])\s|(-{3,}|\*{3,})$)/;

function mdInline(str, into) {
  const re = /(\*\*|__)(?=\S)([\s\S]*?\S)\1|(\*|_)(?=\S)([\s\S]*?\S)\3|`([^`\n]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0, m;
  while ((m = re.exec(str))) {
    if (m.index > last) into.append(document.createTextNode(str.slice(last, m.index)));
    const node = document.createElement(
      m[2] !== undefined ? "strong" : m[4] !== undefined ? "em" : m[5] !== undefined ? "code" : "a");
    if (node.tagName === "A") {
      node.href = m[7];
      node.target = "_blank";
      node.rel = "noreferrer noopener";
      node.textContent = m[6];
    } else {
      node.textContent = m[2] ?? m[4] ?? m[5];
    }
    into.append(node);
    last = re.lastIndex;
  }
  if (last < str.length) into.append(document.createTextNode(str.slice(last)));
  return into;
}

function renderMarkdown(src, decorate) {
  const frag = document.createDocumentFragment();
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const block = (tag, text) => {
    const n = document.createElement(tag);
    if (text !== undefined) mdInline(text, n);
    return n;
  };
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (/^ {0,3}```/.test(line)) {
      const info = line.replace(/^ {0,3}```/, "").trim();
      const code = [];
      i++;
      while (i < lines.length && !/^ {0,3}```/.test(lines[i])) code.push(lines[i++]);
      i++;
      const text = code.join("\n");
      if (decorate) {
        frag.append(codeCard(text, info));
      } else {
        /* mid-stream the block is still growing, so it stays a plain <pre> —
           highlighting a half-typed line would flash the wrong colour */
        const pre = document.createElement("pre");
        pre.append(block("code", text));
        frag.append(pre);
      }
      continue;
    }

    const h = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      frag.append(block("h" + Math.min(6, h[1].length + 2), h[2]));
      i++;
      continue;
    }

    if (/^ {0,3}(-{3,}|\*{3,})\s*$/.test(line)) {
      frag.append(document.createElement("hr"));
      i++;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const q = document.createElement("blockquote");
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        q.append(block("p", lines[i].replace(/^ {0,3}>\s?/, "")));
        i++;
      }
      frag.append(q);
      continue;
    }

    const ul = /^ {0,3}[-*+]\s+(.*)$/, ol = /^ {0,3}(\d+)[.)]\s+(.*)$/;
    if (ul.test(line) || ol.test(line)) {
      const ordered = ol.test(line);
      const re = ordered ? ol : ul;
      const list = document.createElement(ordered ? "ol" : "ul");
      while (i < lines.length) {
        const mm = re.exec(lines[i]);
        if (!mm) break;
        list.append(block("li", mm[mm.length - 1]));
        i++;
      }
      frag.append(list);
      continue;
    }

    const p = document.createElement("p");
    let first = true;
    while (i < lines.length && lines[i].trim() && !MD_BLOCK.test(lines[i])) {
      if (!first) p.append(document.createElement("br"));
      mdInline(lines[i].trim(), p);
      first = false;
      i++;
    }
    frag.append(p);
  }
  return frag;
}

/* ---------- code cards ----------
   A fenced block in an answer is a thing you can act on, not text you select by
   hand: line numbers down the left, the language named, Copy / Download /
   Insert, and for HTML and JavaScript a Preview that really runs the code. */

/* Loaded before the model's code in every preview. It catches what that code
   throws and posts it back up, which is what makes Run & Debug a fact rather
   than a guess. `allow-modals` is deliberately absent: one alert() in generated
   code would freeze this tab.
   Built as one line on purpose: every line the app adds before the user's code
   would push the browser's line numbers away from the ones the gutter shows,
   and an error pointing at line 31 of a 15-line block helps nobody. */
const PREVIEW_HARNESS = "<script>" + [
  "(function(){",
  "var send=function(k,t){try{parent.postMessage({notalPreview:1,kind:k,text:String(t).slice(0,500)},'*')}catch(e){}};",
  "window.addEventListener('error',function(e){send('error',e.message+(e.lineno?' (line '+e.lineno+')':''));});",
  "window.addEventListener('unhandledrejection',function(e){var r=e.reason;send('error','Unhandled rejection: '+((r&&r.message)||r));});",
  "['error','warn','log'].forEach(function(m){var b=console[m];console[m]=function(){send(m==='error'?'error':'log',Array.prototype.join.call(arguments,' '));if(b)b.apply(console,arguments);};});",
  "window.addEventListener('load',function(){send('ready','');});",
  "})()",
].join("") + "</script>";

const liveCards = new Set();

function reportCard(card, d) {
  if (d.kind === "error") {
    if (card.errors.length < 8) card.errors.push(d.text);
    card.el.classList.add("has-error");
    card.status.hidden = false;
    card.status.textContent = card.errors.length > 1
      ? `${card.errors.length} errors — last: ${d.text}`
      : d.text;
    return;
  }
  if (d.kind === "log") { card.logs++; return; }
  if (d.kind === "ready" && card.status.hidden) {
    card.status.hidden = false;
    card.status.textContent = card.logs
      ? `Ran — ${card.logs} console line${card.logs > 1 ? "s" : ""}, nothing thrown.`
      : "Ran — nothing thrown.";
  }
}

window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.notalPreview !== 1) return;
  for (const card of liveCards) {
    if (card.frame && card.frame.contentWindow === e.source) { reportCard(card, d); return; }
  }
});

/* The harness has to sit after the doctype or the page renders in quirks mode,
   and it has to sit before the page's own scripts to catch their errors. */
function insertHarness(html) {
  const doctype = /^\s*<!DOCTYPE[^>]*>/i.exec(html);
  const at = doctype ? doctype.index + doctype[0].length : 0;
  return html.slice(0, at) + PREVIEW_HARNESS + html.slice(at);
}

function previewDocument(raw, mode) {
  if (mode === "document") return insertHarness(raw);
  /* a loose script needs a page to live in. </script> inside one of its strings
     would otherwise end the tag early, so it is broken apart first. */
  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + "<style>body{font-family:system-ui,sans-serif;margin:14px;color:#1f1e1d}</style>"
    + "</head><body>" + PREVIEW_HARNESS
    + "<script>" + raw.replace(/<\/script/gi, "<\\/script") + "</script>"
    + "</body></html>";
}

function runCard(card) {
  card.errors = [];
  card.logs = 0;
  card.loaded = true;
  card.runId++;
  card.el.classList.remove("has-error");
  card.status.hidden = true;
  /* the marker makes every run a real reload even when the code has not moved */
  card.frame.srcdoc = previewDocument(card.raw, card.mode) + `\n<!--run ${card.runId}-->`;
}

function showTab(card, which) {
  card.tab = which;
  for (const t of card.tabs.querySelectorAll(".cc-tab")) {
    const on = t.dataset.tab === which;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  }
  card.source.hidden = which !== "code";
  card.frame.hidden = which !== "preview";
  if (which === "preview") runCard(card);
}

/* The whole point of the loop: run it, take what actually broke, and hand that
   back to the model in the words a developer would type. */
async function debugCard(card) {
  if (turnController) { toast("Wait for the reply in flight to finish."); return; }
  if (card.tab !== "preview") showTab(card, "preview");
  else runCard(card);
  card.runBtn.disabled = true;
  card.status.hidden = false;
  card.status.textContent = "running…";
  await new Promise((done) => setTimeout(done, 1400));
  card.runBtn.disabled = false;
  if (!card.errors.length) {
    card.status.textContent = card.logs
      ? `Ran clean — ${card.logs} console line${card.logs > 1 ? "s" : ""}, nothing thrown.`
      : "Ran clean — nothing was thrown, so there is no error to send.";
    toast("No error came back from the preview.");
    return;
  }
  const joined = card.errors.slice(0, 3).join(" | ");
  card.status.textContent = joined;
  sendMessage("The code threw this error: " + joined
    + ". Fix it and rewrite the code block.");
}

function ccButton(cls, text, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cc-btn cc-" + cls;
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", () => onClick(b));
  return b;
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    /* a page opened from file://, or a browser that refuses the async API, still
       gets a copy rather than an error */
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
}

async function copyCode(card) {
  toast(await writeClipboard(card.raw) ? "Code copied." : "The browser would not take the clipboard.");
}

function downloadCode(card) {
  const ext = langExt(card.info);
  const name = "notal-code." + ext;
  const url = URL.createObjectURL(new Blob([card.raw], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast("Saved as " + name);
}

/* There is no file system behind a web page, so the code goes to the one place
   the user is definitely working in: the box they are typing into. */
function insertCode(card) {
  const current = els.input.value;
  els.input.value = current.trim() ? current.replace(/\s+$/, "") + "\n\n" + card.raw : card.raw;
  autoresize();
  els.input.focus();
  toast("Code put in the message box.");
}

function codeCard(raw, info) {
  const mode = previewMode(info);
  const card = { raw, info, mode, errors: [], logs: 0, runId: 0, loaded: false, tab: "code" };

  const el = document.createElement("div");
  el.className = "code-card";
  el.dataset.kind = langKind(info);
  card.el = el;

  const bar = document.createElement("div");
  bar.className = "cc-bar";
  const badge = document.createElement("span");
  badge.className = "cc-lang";
  badge.textContent = langLabel(info);
  bar.append(badge);

  if (mode) {
    const tabs = document.createElement("div");
    tabs.className = "cc-tabs";
    tabs.setAttribute("role", "tablist");
    for (const [key, label] of [["code", "Code"], ["preview", "Preview"]]) {
      const t = document.createElement("button");
      t.type = "button";
      t.className = "cc-tab" + (key === "code" ? " active" : "");
      t.dataset.tab = key;
      t.setAttribute("role", "tab");
      t.setAttribute("aria-selected", String(key === "code"));
      t.textContent = label;
      tabs.append(t);
    }
    tabs.addEventListener("click", (e) => {
      const t = e.target.closest(".cc-tab");
      if (t) showTab(card, t.dataset.tab);
    });
    card.tabs = tabs;
    bar.append(tabs);
  }

  const tools = document.createElement("div");
  tools.className = "cc-tools";
  tools.append(
    ccButton("copy", "Copy", "Copy this code to the clipboard", () => copyCode(card)),
    ccButton("save", "Download ." + langExt(info), "Save this code as a file", () => downloadCode(card)),
    ccButton("insert", "Insert", "Put this code in the message box", () => insertCode(card))
  );
  bar.append(tools);
  el.append(bar);

  const body = document.createElement("div");
  body.className = "cc-body";

  const source = document.createElement("div");
  source.className = "cc-source";
  const gutter = document.createElement("pre");
  gutter.className = "cc-gutter";
  gutter.setAttribute("aria-hidden", "true");
  gutter.textContent = Array.from({ length: raw.split("\n").length }, (_, n) => n + 1).join("\n");
  const main = document.createElement("pre");
  main.className = "cc-main";
  const codeEl = document.createElement("code");
  codeEl.className = "language-" + (langToken(info) || "plain");
  codeEl.append(...syntaxNodes(raw, info));
  main.append(codeEl);
  source.append(gutter, main);
  card.source = source;
  body.append(source);

  if (mode) {
    const frame = document.createElement("iframe");
    frame.className = "cc-preview";
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
    frame.setAttribute("title", "Preview of " + langLabel(info) + " code");
    frame.hidden = true;
    card.frame = frame;
    body.append(frame);

    const foot = document.createElement("div");
    foot.className = "cc-foot";
    card.runBtn = ccButton("run", "Run & Debug", "Run this and send any error back to Notal", () => debugCard(card));
    card.status = document.createElement("p");
    card.status.className = "cc-status";
    card.status.hidden = true;
    foot.append(card.runBtn, card.status);
    el.append(body, foot);
  } else {
    el.append(body);
  }

  liveCards.add(card);
  return el;
}

function renderText(el, text, asMarkdown, decorate) {
  if (asMarkdown) el.replaceChildren(renderMarkdown(text, decorate));
  else el.textContent = text || "";
}

/* More than one word, because a single word cannot make a wave. */
const THINK_WORDS = ["Thinking", "it", "through"];

function appendMessage(msg) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${msg.role}`;

  const body = document.createElement("div");
  body.className = "msg-body";
  if (msg.attachments?.length) body.append(renderAttachments(msg.attachments));

  const content = document.createElement("div");
  content.className = msg.role === "user" ? "msg-bubble" : "msg-text";
  renderText(content, msg.text, msg.role === "assistant", msg.role === "assistant");

  if (msg.role !== "assistant") {
    body.append(content);
    wrap.append(body);
    els.messages.append(wrap);
    return { wrap, textEl: content };
  }

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.innerHTML = `<span class="notal-mark" aria-hidden="true"></span>`;

  const roleName = document.createElement("div");
  roleName.className = "msg-role";
  const roleLabel = document.createElement("span");
  roleLabel.textContent = "Notal";
  /* The hopping words sit right beside the spinning mark, so the wait has a
     shape to it. Each word jumps and falls on its own delay — a wave that
     travels across the line, driven by the .thinking class alone. */
  const thinkWords = document.createElement("span");
  thinkWords.className = "think-words";
  for (const word of THINK_WORDS) {
    const w = document.createElement("span");
    w.className = "think-word";
    w.textContent = word;
    thinkWords.append(w);
  }
  roleName.append(roleLabel, thinkWords);

  const thinkBox = document.createElement("div");
  thinkBox.className = "msg-think";
  thinkBox.hidden = true;
  const thinkLabel = document.createElement("span");
  thinkLabel.className = "think-label";
  const thinkChevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  thinkChevron.setAttribute("class", "think-chevron");
  thinkChevron.setAttribute("viewBox", "0 0 24 24");
  thinkChevron.setAttribute("width", "13");
  thinkChevron.setAttribute("height", "13");
  thinkChevron.setAttribute("aria-hidden", "true");
  thinkChevron.innerHTML = `<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/>`;
  const thinkHead = document.createElement("button");
  thinkHead.type = "button";
  thinkHead.className = "think-head";
  thinkHead.setAttribute("aria-expanded", "false");
  thinkHead.append(thinkLabel, thinkChevron);
  const thinkText = document.createElement("div");
  thinkText.className = "think-text";
  thinkBox.append(thinkHead, thinkText);
  const setReasoningOpen = (open) => {
    thinkBox.classList.toggle("open", open);
    thinkHead.setAttribute("aria-expanded", String(open));
  };
  thinkHead.addEventListener("click", () => setReasoningOpen(!thinkBox.classList.contains("open")));

  body.append(roleName, thinkBox, content);
  wrap.append(avatar, body);
  els.messages.append(wrap);

  let reasoningOn = false;
  let reasoningStreamed = false;
  let reasoningStartedAt = 0;
  /* The trail is a list of steps in the order they happened, so a page read
     sits visibly between two pieces of reasoning. `notesEl` is the block the
     model's current thinking streams into; it resets whenever something else
     happens, so thinking after a browse starts a new block. */
  let notesEl = null;

  /* What the header says once the reply is whole. Only a model that measured
     something of its own sets this; everything else falls through to the
     generic line the trail can honestly claim. */
  let restingLine = null;

  const openBox = () => {
    if (thinkBox.hidden) {
      thinkBox.hidden = false;
      setReasoningOpen(true);
      motion.reveal(thinkBox);
    }
  };

  function notesBlock() {
    if (!notesEl) {
      notesEl = document.createElement("p");
      notesEl.className = "think-notes";
      thinkText.append(notesEl);
    }
    return notesEl;
  }

  return {
    wrap,
    textEl: content,
    thinkBox,
    thinkLabel,
    thinkText,
    startThinking() {
      wrap.classList.add("thinking");
      if (reasoningOn) return;
      reasoningOn = true;
      reasoningStartedAt = Date.now();
      if (!state.showThinking) return;
      thinkLabel.textContent = "Reasoning";
      thinkBox.classList.add("live");
      openBox();
    },
    addReasoning(chunk) {
      if (!state.showThinking) return;
      this.startThinking();
      reasoningStreamed = true;
      notesBlock().textContent += chunk;
      thinkText.scrollTop = thinkText.scrollHeight;
    },
    /* What the model wrote next to a [browse] tag is it still working, not an
       answer, so it goes into the trail and off the page. */
    addNote(text) {
      if (!text) return;
      openBox();
      const p = document.createElement("p");
      p.className = "think-notes";
      p.textContent = text;
      thinkText.append(p);
      notesEl = null;
    },
    settleNote(text) { restingLine = text; },
    /* Returns the callback that closes the step, so the caller keeps the pair
       together: start when the fetch begins, finish with what came back. */
    startBrowse(url) {
      openBox();
      thinkBox.classList.add("busy");
      thinkLabel.textContent = "Browsing " + shortUrl(url);
      const row = document.createElement("p");
      row.className = "think-browse";
      const parts = {
        kind: document.createElement("span"),
        where: document.createElement("span"),
        state: document.createElement("span"),
      };
      parts.kind.className = "tb-kind";
      parts.kind.textContent = "Browsing";
      parts.where.className = "tb-url";
      parts.where.textContent = shortUrl(url);
      parts.state.className = "tb-state";
      parts.state.textContent = "opening…";
      row.append(parts.kind, parts.where, parts.state);
      thinkText.append(row);
      notesEl = null;
      thinkText.scrollTop = thinkText.scrollHeight;
      return (result) => {
        thinkBox.classList.remove("busy");
        if (result.ok) {
          parts.state.textContent = result.title ? `read — ${result.title}` : "read";
        } else {
          parts.state.textContent = "did not open";
          row.classList.add("failed");
        }
        thinkLabel.textContent = "Reasoning";
        thinkText.scrollTop = thinkText.scrollHeight;
      };
    },
    stopThinking() {
      wrap.classList.remove("thinking");
      if (!thinkBox.hidden) {
        if (!thinkText.childElementCount) {
          thinkBox.hidden = true;
        } else {
          /* the thinking switch can be off while a page read still shows, so
             the resting line says what the trail actually holds */
          const browses = thinkText.querySelectorAll(".think-browse").length;
          const reads = thinkText.querySelectorAll(".think-browse:not(.failed)").length;
          if (restingLine) {
            thinkLabel.textContent = restingLine;
          } else if (reasoningStreamed) {
            thinkLabel.textContent = "Thought for " + elapsedWords(Date.now() - reasoningStartedAt);
          } else if (browses) {
            thinkLabel.textContent = reads
              ? (reads === browses
                ? `Read ${reads} page${reads > 1 ? "s" : ""}`
                : `Read ${reads} of ${browses} pages`)
              : "No page opened";
          } else {
            thinkLabel.textContent = "Reasoning";
          }
          setReasoningOpen(false);
        }
      }
      thinkBox.classList.remove("live");
      reasoningOn = false;
    },
  };
}

function elapsedWords(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function scrollToBottom() {
  els.chat.scrollTop = els.chat.scrollHeight;
}

/* A turn in flight, so the composer's round button can cancel it. */
let turnController = null;

function setStreaming(on) {
  els.sendBtn.classList.toggle("stop", on);
  els.sendBtn.title = on ? "Stop generating" : "Send";
  els.sendBtn.setAttribute("aria-label", els.sendBtn.title);
  els.input.disabled = on;
  /* the tray and Quick Chat show this, so a busy app looks busy from anywhere */
  if (DESKTOP) window.notal.engineBusy(on);
}

function stopTurn() {
  turnController?.abort();
}

async function sendMessage(text) {
  const trimmed = text.trim();
  if (!trimmed && !pendingAtts.length) return;
  if (!activeConv()) newConversation();
  const conv = activeConv();
  els.greeting.hidden = true;

  const userMsg = { role: "user", text: trimmed };
  if (pendingAtts.length) {
    userMsg.attachments = pendingAtts.map(a => ({ ...a }));
    pendingAtts = [];
    renderPending();
  }
  conv.messages.push(userMsg);
  if (conv.title === "New chat") {
    conv.title = trimmed
      ? (trimmed.length > 42 ? trimmed.slice(0, 42) + "…" : trimmed)
      : userMsg.attachments[0].name;
  }
  setView("chats");
  appendMessage(userMsg);
  scrollToBottom();
  save();
  renderHistory(els.search.value);

  els.input.value = "";
  autoresize();

  const turn = appendMessage({ role: "assistant", text: "" });
  turn.startThinking();
  scrollToBottom();
  const ac = new AbortController();
  turnController = ac;
  setStreaming(true);

  const model = selectedModel();
  /* captured before anything awaits, so a second question cannot steal the turn */
  const quick = quickJob;
  let answer = "";
  let frame = 0;
  const draw = (final) => {
    frame = 0;
    /* a [browse] tag streams in before the page does, so the markup must never
       reach the visible answer. Code only gets coloured once the reply is
       whole — a half-written line would flash the wrong token every frame. */
    renderText(turn.textEl, cleanAnswer(answer), true, !!final);
    scrollToBottom();
  };
  /* one re-render per animation frame keeps markdown cheap while tokens fly by.
     The arrow matters: rAF hands draw a timestamp, and a timestamp would read as
     "finished" and re-highlight the block on every frame. */
  const push = (chunk) => {
    answer += chunk;
    /* the Quick Chat overlay watches this same reply, so the tokens go to it as
       they arrive rather than only at the end */
    if (quick) window.notal.quickChunk(quick.id, chunk);
    if (!frame) frame = requestAnimationFrame(() => draw());
  };
  let replyTokens = 0;
  const onDelta = (delta) => {
    if (delta.reasoning) turn.addReasoning(delta.reasoning);
    if (delta.text) push(delta.text);
    if (delta.tokens) replyTokens = delta.tokens;
  };
  const finishQuick = (payload) => {
    if (quick && quickJobs.has(quick.id)) window.notal.quickDone(quick.id, payload);
  };

  const replyStartTime =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();

  try {
    if (model.providerId) {
      /* The desktop brief and the owner's skills.md live on disk, so they are
         read again per send — editing skills.md takes effect on the next
         message, not on the next restart. */
      if (DESKTOP) await refreshStudioBrief();
      /* Browsing is a loop, not a side quest: the model asks for one page, this
         tab reads it, the page text comes back as context for the next turn,
         and only the final tag-free reply lands on the page. The pages go into
         `context`, never into `conv.messages`, so a lookup does not live in the
         chat history forever. Attached documents join that same context. */
      let context = withDocuments(conv.messages);
      let hops = 0;
      /* An address the user typed themselves is read first, so a page lookup
         never depends on the model volunteering to ask for one. */
      const typed = findBrowseRequest(trimmed);
      if (typed) {
        context = await readIntoContext(turn, context, typed, ac.signal,
          "(The user gave me a page to read; the app fetched it.)");
        hops++;
      }
      for (;;) {
        const raw = await callProvider(model, context, onDelta, ac.signal);
        const url = hops < MAX_BROWSES ? findBrowseRequest(raw) : null;
        if (!url) { answer = raw; break; }
        const note = cleanAnswer(raw);
        turn.addNote(note);
        /* the words that came with the tag are now a step in the trail, so the
           answer body starts over — otherwise a stop during the fetch would
           leave the same paragraph twice in one message */
        answer = "";
        if (frame) cancelAnimationFrame(frame);
        draw();
        context = await readIntoContext(turn, context, url, ac.signal, note);
        hops++;
      }
      /* a finished reply is better evidence than any test button */
      recordProviderResult(model.providerId, true, "Answered a real message");
    } else if (model.browser) {
      /* the tokens arrive through the same push path, so `answer` is already
         whole by the time this returns */
      await streamBrowserModel(withDocuments(conv.messages), onDelta, ac.signal, turn);
    } else {
      await streamBuiltIn(craftReply(trimmed, conv.messages.length), push, ac.signal);
    }
    if (frame) cancelAnimationFrame(frame);
    draw(true);
    turn.stopThinking();
    const reply = cleanAnswer(answer);
    conv.messages.push({ role: "assistant", text: reply });
    save();
    notifyReply(reply);
    finishQuick({ text: reply });

    /* Fire-and-forget log to Supabase `events` table — never blocks the UI */
    const replyEndTime =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    const latencyMs = Math.max(0, Math.round(replyEndTime - replyStartTime));
    logNotalAiEvent({
      type: "ai_reply",
      model: model.name || model.id || "notal-generic",
      tokens: replyTokens || estimateTokens(trimmed, reply),
      latency_ms: latencyMs,
      device: detectNotalDevice(),
    });
  } catch (err) {
    if (frame) cancelAnimationFrame(frame);
    turn.stopThinking();
    if (ac.signal.aborted) {
      /* stopping is not a failure: keep whatever already arrived */
      draw(true);
      const partial = cleanAnswer(answer);
      if (partial) {
        conv.messages.push({ role: "assistant", text: partial });
        save();
      } else {
        turn.wrap.remove();
      }
      toast("Stopped.");
      finishQuick(partial ? { text: partial } : { error: "Stopped before anything arrived." });
      return;
    }
    if (model.providerId) {
      const p = state.providers.find(x => x.id === model.providerId);
      if (p) recordProviderResult(p.id, false, friendlyTestError(err, p));
    }
    turn.textEl.classList.add("msg-error");
    turn.textEl.textContent = "⚠ " + (err?.message || "Request failed");
    finishQuick({ error: err?.message || "Request failed" });
  } finally {
    turnController = null;
    setStreaming(false);
    els.input.focus();
  }
}

/* The built-in model has no server to stream from, so its reply is fed through
   the same token path at a readable pace. */
async function streamBuiltIn(fullText, push, signal) {
  await new Promise(r => setTimeout(r, 350));
  for (const chunk of fullText.match(/\S+\s*/g) ?? []) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    push(chunk);
    await new Promise(r => setTimeout(r, 26));
  }
}

/* ---------- the model that runs on this device ----------
   webmodel.js loads it and asks it. This is the part that fits the app's own
   context into a small model's memory and says what the wait is doing. */

/* The card holds 4096 tokens and spends them badly, so the whole exchange —
   instruction, memory and history together — is kept to about three thousand
   tokens and the rest is left for the answer. */
const BROWSER_PROMPT_CHARS = 9_000;

function browserSystemPrompt() {
  const facts = state.memories.filter(m => m.enabled).map(m => m.text);
  const proj = state.projects.find(p => p.id === state.activeProject);
  /* It is told what it actually is. A quarter-billion-parameter model asked to
     play a capable product assistant will invent names and numbers with total
     confidence; a short answer that admits the limit is the better failure. */
  let s = "You are a small language model (0.5B parameters) running on this device, "
    + "inside the Notal workspace. Answer briefly and plainly. "
    + "When you are unsure, say so in one line rather than guessing, and never invent "
    + "names, numbers, dates or quotes.";
  if (proj) s += ` The current project is "${proj.name}".`;
  if (facts.length) s += `\nThings the user wants you to remember:\n- ${facts.join("\n- ")}`;
  for (const x of state.extensions)
    if (x.enabled && x.prompt) s += `\nExtension "${x.name}": ${x.prompt}`;
  return s;
}

/* Newest first until the room runs out, because a small model that never sees
   the question answers about whatever came before it. */
function browserMessages(history) {
  const sys = { role: "system", content: browserSystemPrompt() };
  let used = sys.content.length;
  const kept = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const text = (m.text || "").trim()
      || (imageAtts(m).length ? "(an image was attached; this model cannot see pictures)" : "(an attachment)");
    if (kept.length && used + text.length > BROWSER_PROMPT_CHARS) break;
    used += text.length;
    kept.unshift({ role: m.role, content: text });
  }
  return [sys, ...kept];
}

function progressWords(label, pct) {
  const text = String(label || "").trim() || "Working";
  if (typeof pct !== "number" || pct < 0) return text + "…";
  const p = Math.round(pct * 100);
  /* Only the weights phase is a fraction of bytes, so only there is it honest to
     turn the number into megabytes. Other phases measure their own small job. */
  return /fetch|param|download/i.test(text)
    ? `${text} — ${p}% · about ${Math.round(pct * WEB_MODEL_MB)} of ${WEB_MODEL_MB} MB`
    : `${text} — ${p}%`;
}

/* A step the trail has no word for yet. The download and the first token both
   want a line of their own, and the thinking box already exists to hold one. */
function trailStep(turn, text) {
  turn.thinkBox.hidden = false;
  turn.thinkBox.classList.add("busy");
  /* the hopping "thinking it through" words are a stand-in for work whose shape
     nobody knows; here the shape is known, so the line says it instead */
  turn.wrap.classList.add("named-work");
  const p = document.createElement("p");
  p.className = "think-notes";
  p.textContent = text;
  turn.thinkText.append(p);
  turn.thinkText.scrollTop = turn.thinkText.scrollHeight;
  const stop = () => {
    turn.thinkBox.classList.remove("busy");
    turn.wrap.classList.remove("named-work");
  };
  return {
    set(next) { p.textContent = next; },
    /* keep the line: a collapsed box needs a header, and the header is only
       truthful if something behind it says what happened */
    finish(final) { p.textContent = final; stop(); },
    done() { p.remove(); stop(); },
  };
}

/* Every number here was observed — the clock, and the runtime's own count of
   the tokens it sampled. Nothing about a local reply is estimated. */
function localAnswerWords(got) {
  const secs = (got.elapsedMs / 1000).toFixed(1);
  const n = got.completionTokens;
  const parts = [`Ran on this device in ${secs} s`];
  if (n) parts.push(`${n} tokens`);
  if (n && got.elapsedMs > 500) parts.push(`${(n / (got.elapsedMs / 1000)).toFixed(1)} per second`);
  if (got.firstTokenMs !== null) parts.push(`first token after ${(got.firstTokenMs / 1000).toFixed(1)} s`);
  return {
    detail: parts.join(" · "),
    header: `Ran here in ${secs} s${n ? ` · ${n} tokens` : ""}`,
  };
}

async function streamBrowserModel(history, onDelta, signal, turn) {
  const step = trailStep(turn, "Getting the model ready");
  let wrote = false;
  try {
    let text = "";
    const got = await webModelAsk(browserMessages(history), (d) => {
      if (!wrote) { wrote = true; step.set("Writing the answer"); }
      text += d;
      onDelta({ text: d });
    }, {
      signal,
      onProgress: (label, pct) => { step.set(progressWords(label, pct)); },
    });
    if (signal?.aborted) {
      /* stopping is stopping, whether it landed mid-download or mid-sentence:
         the caller keeps the partial and says so */
      step.done();
      throw new DOMException("Aborted", "AbortError");
    }
    if (!got.text.trim()) {
      step.done();
      throw new Error("The browser model answered with nothing. Try again, or ask it something shorter.");
    }
    const words = localAnswerWords(got);
    step.finish(words.detail);
    turn.settleNote(words.header);
    return got.text;
  } catch (err) {
    step.done();
    if (err?.name === "AbortError") throw err;
    throw new Error(webModelError(err));
  }
}

/* ---------- canned replies ---------- */
function craftReply(prompt, depth) {
  const p = prompt.toLowerCase();
  const name = "Notal";

  if (/^(hi|hello|hey|yo|sup)\b/.test(p)) {
    return "Hello! I'm Notal, your workspace assistant. I can help you write, plan, research, think through problems, or organize your work. What's on your mind?";
  }
  if (p.includes("who are you")) {
    return "I'm Notal AI — a calm, capable assistant built into this workspace. I keep a memory of our chats in this browser, let you switch between models, and try to give thoughtful, well-structured answers.";
  }
  if (p.includes("thank")) {
    return "You're welcome — glad I could help. Anything else you'd like to work through?";
  }
  /* the built-in model has no system prompt to follow, so coding mode has to be
     handled here too or the switch would look dead on the default model */
  if (state.mode === "coding") {
    return `Here's how I'd work through "${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}":\n\n1. Reproduce — the smallest case that shows the problem.\n2. Cause — what the code assumes, and where that assumption breaks.\n3. Fix — the minimal change, not a rewrite.\n4. Guard — something that fails before the fix and passes after.\n\nPaste the code or the error and I'll take it line by line. This is the built-in model, so it is working from a template, and it cannot open web pages — add a provider in Settings for real code answers and browsing.`;
  }
  if (p.includes("write") || p.includes("draft") || p.includes("brief")) {
    return `Here's a strong starting point for "${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}":\n\n1. Purpose — open with one sentence that states what this is and why it matters.\n2. Context — two or three lines the reader needs before diving in.\n3. The ask — what you want to happen, by when, and who owns it.\n4. Details — the supporting points, ordered by importance.\n\nWant me to fill this in with real content, adjust the tone, or make it shorter?`;
  }
  if (p.includes("plan") || p.includes("trip") || p.includes("schedule")) {
    return "Let's structure that. Here's a planning frame I like:\n\n• Goal — what does success look like at the end?\n• Constraints — time, budget, energy, non-negotiables.\n• Blocks — break it into 2–4 larger chunks instead of a long to-do list.\n• Buffer — leave one slot empty for surprises.\n\nTell me your dates and priorities and I'll draft the actual plan.";
  }
  if (p.includes("explain") || p.includes("what is") || p.includes("difference")) {
    return "Happy to explain. The short version:\n\nThink of it like the difference between studying for an exam and retraining your brain. One approach adds reference material you can consult on the fly — flexible and updatable. The other bakes knowledge in through practice — faster at recall, but harder to change later.\n\nThe best choice depends on how often the information changes and how deep the understanding needs to be. Want me to go one level deeper on either side?";
  }
  if (p.includes("idea") || p.includes("review")) {
    return "Good seed. Here's my honest read:\n\nStrengths — it solves a pain people already feel, and the value is visible immediately.\nRisks — the magic moment depends entirely on extraction quality; if the output needs heavy editing, people revert to manual notes.\nFirst test — try it on ten real meetings before writing any code. Ask users: \"did this save you more time than it took to fix?\"\n\nWant me to sketch a one-page concept doc around this?";
  }
  const openers = [
    `That's a good question. Let me think it through with you.`,
    `Here's how I'd approach that.`,
    `Interesting — let's break it down.`,
  ];
  const opener = openers[depth % openers.length];
  return `${opener}\n\nAbout "${prompt.slice(0, 70)}${prompt.length > 70 ? "…" : ""}" — the key is to separate what you know from what you're assuming, then test the assumptions one at a time. Start with the smallest version that could still be useful, get a reaction from reality quickly, and let that shape the next step.\n\nIf you give me more context — your goal, constraints, and timeline — I can turn this into something concrete.`;
}

/* ---------- provider API calls ---------- */
const KIND_DEFAULTS = {
  openai: "",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  ollama: "http://localhost:11434",
};
/* Prompts live in prompts.js so they read as text, not as code. `typeof` keeps
   the app working if that file ever fails to load — coding mode falls back to
   the one-line brief rather to no system prompt at all. */
const SYSTEM_BY_MODE = {
  /* A page read is not a coding-only need — "what is the newest model" is a
     chat question — so both modes get the browse brief. Coding mode carries
     the owner's full core instruction doc, which already ends with it. */
  chat: (typeof CHAT_SYSTEM_PROMPT === "string"
    ? CHAT_SYSTEM_PROMPT
    : "You are Notal, a calm, clear assistant in the Notal AI workspace.")
    + (typeof BROWSE_INSTRUCTIONS === "string" ? BROWSE_INSTRUCTIONS : ""),
  coding: typeof CODING_SYSTEM_PROMPT === "string"
    ? CODING_SYSTEM_PROMPT
    : "You are Notal in coding mode: a precise engineering partner. Lead with working code, keep prose short, name the language and version you assumed, point out edge cases and failure modes, and say how to test the change. Prefer the minimal fix over a rewrite.",
};

function systemPrompt() {
  const facts = state.memories.filter(m => m.enabled).map(m => m.text);
  const proj = state.projects.find(p => p.id === state.activeProject);
  let s = SYSTEM_BY_MODE[state.mode] || SYSTEM_BY_MODE.chat;
  if (proj) s += ` The current project is "${proj.name}".`;
  if (facts.length) s += `\nThings the user wants you to remember:\n- ${facts.join("\n- ")}`;
  for (const x of state.extensions)
    if (x.enabled) s += `\nExtension "${x.name}": ${x.prompt}`;
  /* in the desktop app this carries the Studio brief and the owner's skills.md,
     both read from disk moments ago — see refreshStudioBrief() */
  if (studioBrief) s += studioBrief;
  return s;
}

function splitDataUrl(u) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(u) || [];
  return { mime: m[1] || "application/octet-stream", data: m[2] || "" };
}

function imageAtts(m) {
  return (m.attachments || []).filter(a => a.dataUrl && (a.type || "").startsWith("image/"));
}

function relayBase() {
  /* Inside Notal AI Studio the app has a relay of its own on this machine, and
     it wins over an address typed in Settings: keys never leave the computer, a
     streamed reply arrives token by token instead of all at once, a page can be
     read without a CORS header existing, and a local Ollama is reachable. In a
     browser tab window.notal is absent, so this changes nothing there. */
  if (DESKTOP) return window.notal.relayOrigin.replace(/\/+$/, "");
  return (state.relayUrl || "").trim().replace(/\/+$/, "");
}
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } }

/* ---------- Notal AI Studio (the Windows app) ----------
   Everything in this section is idle in a browser tab: window.notal only exists
   when the preload script of the desktop shell put it there. */
const DESKTOP = Boolean(window.notal && window.notal.desktop);
let studioBrief = "";

async function studioGet(pathname) {
  const res = await fetch(pathname, { signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined });
  if (!res.ok) throw new Error(`${pathname} answered ${res.status}`);
  return res.json();
}

/* skills.md and the desktop brief are read from disk by the app, so an edit to
   the file is in the next message without a restart. Fetched per send rather
   than once at boot for exactly that reason. */
async function refreshStudioBrief() {
  if (!DESKTOP) return false;
  try {
    const data = await studioGet("/studio/prompt");
    studioBrief = data.prompt || "";
    return true;
  } catch { return false; }
}

/* ---------- documents ----------
   An attached file only counts as read if the model is given its text. Images
   already travel to the provider as images; everything made of characters is
   now read into the message, which is what "analyse this file" has always meant. */
const DOC_LIMIT = 12_000;         // characters per file
const DOC_TOTAL_LIMIT = 30_000;    // characters per message, so a folder drop is not a flood
const DOC_TYPES = /^(text\/|application\/(json|x-sh|xml|yaml|x-yaml|toml|javascript|x-javascript))/i;
const DOC_EXT = /\.(md|markdown|txt|text|csv|tsv|json|jsonl|ndjson|ya?ml|toml|xml|html?|css|scss|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|sh|bat|ps1|sql|r|lua|pl|ini|cfg|conf|env|log|tex|srt|vtt|graphql)$/i;

function looksLikeText(file) {
  if ((file.type || "").startsWith("image/")) return false;
  if (DOC_TYPES.test(file.type || "")) return true;
  return DOC_EXT.test(file.name || "");
}

function docAtts(m) {
  return (m.attachments || []).filter(a => a.text);
}

function withDocuments(messages) {
  const last = messages[messages.length - 1];
  const docs = last && docAtts(last);
  if (!docs || !docs.length) return messages;
  let left = DOC_TOTAL_LIMIT;
  const blocks = docs.map(a => {
    const body = (a.text || "").slice(0, Math.max(0, left));
    left -= body.length;
    const cut = (a.text || "").length > body.length ? "\n…(the file is longer than the app will read)" : "";
    return `--- BEGIN FILE ${a.name} ---\n${body}${cut}\n--- END FILE ${a.name} ---`;
  });
  return [...messages.slice(0, -1), { ...last, text: `${last.text || ""}\n\nThe user attached these files.\n\n${blocks.join("\n\n")}` }];
}

/* ---------- export ----------
   The Share button used to print "Link copied" and copy nothing. In the desktop
   app it opens a real Save dialog; in a browser it puts the same Markdown on the
   clipboard, which is the honest version of the same promise. */
function conversationMarkdown(conv) {
  const proj = state.projects.find(p => p.id === conv.projectId);
  const lines = [`# ${conv.title || "Notal AI chat"}`, ""];
  if (proj) lines.push(`*Project: ${proj.name}*`, "");
  lines.push(`*Exported ${new Date().toLocaleString()} from Notal AI*`, "", "---");
  for (const m of conv.messages) {
    lines.push("", `## ${m.role === "user" ? "You" : "Notal"}`, "", m.text || "(no text)");
    for (const a of m.attachments || []) {
      lines.push(a.text || a.dataUrl
        ? `\n*Attached: ${a.name} — read into the message*`
        : `\n*Attached: ${a.name} (${Math.round((a.size || 0) / 1024)} KB — stored as a name only)*`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function conversationJson(conv) {
  return JSON.stringify({
    exportedAt: new Date().toISOString(), app: "notal-ai", version: 2,
    title: conv.title, mode: state.mode, messages: conv.messages,
  }, null, 2);
}

function safeFileName(s) {
  return (s || "notal-chat").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").slice(0, 60).trim() || "notal-chat";
}

async function exportConversation(conv, format = "markdown") {
  conv = conv || activeConv();
  if (!conv || !conv.messages.length) { toast("Start a chat first."); return false; }
  const json = format === "json";
  const text = json ? conversationJson(conv) : conversationMarkdown(conv);
  const name = safeFileName(conv.title) + (json ? ".json" : ".md");
  if (DESKTOP) {
    const out = await window.notal.saveFile({ suggestedName: name, text, format: json ? "json" : "md",
      title: "Save this chat" });
    if (out && out.saved) { toast("Saved to " + out.path); return true; }
    if (out && out.error) toast("Could not save: " + out.error);
    return false;
  }
  /* a tab has no Save dialog of its own, so the clipboard carries the text */
  if (await writeClipboard(text)) { toast(json ? "Chat copied as JSON." : "Chat copied as Markdown."); return true; }
  const url = URL.createObjectURL(new Blob([text], { type: json ? "application/json" : "text/markdown" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast("Saved as " + name);
  return true;
}

/* ---------- what the tray and the keyboard shortcuts ask for ---------- */
const quickJobs = new Map();   // id -> a question the overlay is waiting on
let quickJob = null;           // the one the current turn belongs to

function studioAction(name) {
  if (name === "new-chat") { newConversation(); els.input.focus(); return; }
  if (name === "toggle-theme") {
    state.theme = state.theme === "dark" ? "light" : "dark";
    applyTheme(); save(); return;
  }
  if (name === "export-request") {
    window.notal.sendExport({ text: conversationMarkdown(activeConv() || { messages: [] }),
      title: safeFileName((activeConv() || {}).title), format: "markdown" });
  }
}

function installStudioBridge() {
  if (!DESKTOP) return;
  const tab = document.getElementById("desktopTab");
  if (tab) tab.hidden = false;
  const note = document.getElementById("studioRelayNote");
  if (note) {
    note.textContent = "In this app that address is the one it runs for itself on "
      + window.notal.relayOrigin.replace(/^http:\/\//, "") + " — requests, page reads and local models all go "
      + "through it, and your keys never leave this machine.";
    note.hidden = false;
  }
  window.notal.onAction(studioAction);
  window.notal.onQuickRun((job) => {
    if (turnController) {
      window.notal.quickDone(job.id, { error: "Notal is still answering something else. Wait for it, then ask again." });
      return;
    }
    /* the overlay has no engine of its own — the question goes through exactly
       the same send path as if it had been typed in the composer, so the answer
       lands in history with the rest of the chat */
    quickJob = job;
    quickJobs.set(job.id, job);
    sendMessage(job.text).finally(() => {
      if (quickJob === job) quickJob = null;
      quickJobs.delete(job.id);
    });
  });
  window.notal.onQuickCancel(() => stopTurn());
  studioLine("studioQuickBtn")?.addEventListener("click", () => window.notal.openQuick());
  studioLine("studioSkillsBtn")?.addEventListener("click", () => {
    window.notal.skillsInfo().then(s => window.notal.openPath(s.path));
  });
  studioLine("studioUpdateBtn")?.addEventListener("click", studioCheckUpdates);
  studioLine("studioOllamaBtn")?.addEventListener("click", readOllama);
  window.notal.quickState().then((s) => { if (s && typeof s.busy === "boolean") window.notal.engineBusy(Boolean(turnController)); }).catch(() => {});
}
installStudioBridge();

/* The Desktop tab in Settings is where the shell's features live, the same way
   every other feature of this app is configured there. Each line reports what it
   actually found rather than what should be true, so a shortcut another program
   grabbed, or an Ollama that is not running, reads as a fact and not as a lie.
   These are function declarations on purpose: installStudioBridge() above runs
   at load and reaches them, and a const here would not exist yet. */
function studioLine(id) { return document.getElementById(id); }
function setLine(id, text) { const el = studioLine(id); if (el) el.textContent = text; }

async function renderStudioSettings() {
  if (!DESKTOP) return;
  try {
    const info = await window.notal.info();
    setLine("studioName", info.name);
    setLine("studioVersion", "v" + info.version);
    setLine("studioPaths", "Chats, models and keys are kept by this app alone, in " + info.userData);
  } catch { /* the lines below still answer on their own */ }

  try {
    const h = await studioGet("/studio/health");
    setLine("studioRelayLine", h.ok
      ? `Built into this app at ${window.notal.relayOrigin}. It forwards provider calls, reads web pages, and reaches a local Ollama — all on this machine, all streaming as it goes.`
      : "The app's own relay did not answer. Set a relay in the field above to route around it.");
  } catch (err) {
    setLine("studioRelayLine", "The app's own relay is not answering: " + (err?.message || err));
  }

  try {
    const list = await window.notal.hotkeys();
    setLine("studioHotkeys", list.map(h => `${h.accel} — ${h.label}: `
      + (h.ok ? "registered" : `not yours right now, because ${h.error}`)).join("   ·   "));
  } catch { setLine("studioHotkeys", "Could not read the shortcut list."); }

  try {
    const s = await window.notal.skillsInfo();
    const chars = (s.content || "").trim().length;
    setLine("studioSkills", chars
      ? `${chars.toLocaleString()} characters, read from ${s.path}. The next message already uses it.`
      : `Nothing in it yet. Write your instructions into ${s.path} and the next message uses them.`);
  } catch (err) { setLine("studioSkills", "Could not find skills.md: " + (err?.message || err)); }

  readOllama();
  setLine("studioUpdate", "Not checked yet.");
  try { showUpdate(await studioGet("/studio/health").then(h => h.update)); } catch { /* untouched */ }
}

function showUpdate(u) {
  if (!u) return;
  const current = u.current || "";
  if (u.error) setLine("studioUpdate", "Last check failed: " + u.error);
  else if (u.note) setLine("studioUpdate", "Nothing to check against yet — " + u.note + ".");
  else if (u.checkedAt) {
    const when = new Date(u.checkedAt).toLocaleString();
    setLine("studioUpdate", u.latest && u.latest !== current
      ? `v${u.latest} has been published; this app is v${current}. Check now opens the release.`
      : `Last checked ${when}. This is the newest build there is.`);
  }
}

async function studioCheckUpdates() {
  setLine("studioUpdate", "Asking GitHub…");
  try { showUpdate(await window.notal.checkUpdates()); }
  catch (err) { setLine("studioUpdate", "Could not ask the app: " + (err?.message || err)); }
}

async function readOllama() {
  const line = studioLine("studioOllama");
  if (!line) return;
  line.textContent = "Looking…";
  try {
    const r = await studioGet("/studio/ollama");
    line.textContent = r.running
      ? (r.models.length
        ? `Ollama is running with ${r.models.length} model${r.models.length === 1 ? "" : "s"}: ` + r.models.map(m => m.name).slice(0, 6).join(", ")
          + " — add one in Settings → Providers with the address http://localhost:11434."
        : "Ollama is running but has no models pulled yet. Run `ollama pull llama3.2` and look again.")
      : "Ollama is not answering on 127.0.0.1:11434. Start it, then look again.";
  } catch (err) { line.textContent = "Could not ask: " + (err?.message || err); }
}

/* ---------- provider transport ---------- */
// A remote relay cannot reach an Ollama on this machine, so local targets only
// go through the relay when the relay itself is local.
function routeFor(url, opts) {
  const relay = LOCAL_HOSTS.has(hostOf(url)) && !LOCAL_HOSTS.has(hostOf(relayBase()))
    ? "" : relayBase();
  if (!relay) return { target: url, init: opts, relay: "" };
  // the relay forwards on our behalf, so the browser never touches the
  // provider origin and CORS never applies
  return {
    target: `${relay}/relay`,
    relay,
    init: {
      method: "POST",
      signal: opts.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        method: opts.method || "POST",
        headers: opts.headers || {},
        body: opts.body ? JSON.parse(opts.body) : undefined,
      }),
    },
  };
}

async function openProviderCall(url, opts) {
  const { target, init, relay } = routeFor(url, opts);
  let res;
  try { res = await fetch(target, init); }
  catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new Error(relay
      ? `Could not reach the relay at ${relay} — check the URL in Settings → General.`
      : "Could not reach the API — check the base URL, your connection, and CORS.");
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j.error?.message || j.message || JSON.stringify(j).slice(0, 180);
    } catch {}
    throw new Error(`${res.status} ${res.statusText}${detail ? " — " + detail : ""}`);
  }
  return res;
}

async function httpJson(url, opts) {
  return (await openProviderCall(url, opts)).json();
}

const sseJson = (line) => {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try { return JSON.parse(payload); } catch { return null; }
};

// One line of a live stream in, the pieces of the reply it carried out.
const STREAM_LINES = {
  openai(line) {
    const j = sseJson(line);
    if (!j) return null;
    const d = j.choices?.[0]?.delta;
    const tokens = j.usage?.total_tokens || 0;
    if (!d && !tokens) return null;
    return {
      text: d?.content || "",
      reasoning: d?.reasoning_content || d?.reasoning || "",
      tokens,
    };
  },
  anthropic(line) {
    const j = sseJson(line);
    if (!j) return null;
    if (j.type === "error") throw new Error(j.error?.message || "The provider returned an error.");
    const u = j.usage || j.message?.usage;
    const tokens = u ? (u.input_tokens || 0) + (u.output_tokens || 0) : 0;
    const d = j.delta || {};
    if (d.type === "text_delta") return { text: d.text || "", reasoning: "", tokens };
    if (d.type === "thinking_delta") return { text: "", reasoning: d.thinking || "", tokens };
    return tokens ? { text: "", reasoning: "", tokens } : null;
  },
  gemini(line) {
    const j = sseJson(line);
    if (!j) return null;
    if (j.error?.message) throw new Error(j.error.message);
    const out = splitThoughts(j.candidates?.[0]?.content?.parts);
    out.tokens = j.usageMetadata?.totalTokenCount || 0;
    return out;
  },
  ollama(line) {
    if (!line.trim()) return null;
    let j;
    try { j = JSON.parse(line); } catch { return null; }
    if (j.error) throw new Error(String(j.error));
    const tokens = (j.prompt_eval_count || 0) + (j.eval_count || 0);
    return { text: j.message?.content || "", reasoning: j.message?.thinking || "", tokens };
  },
};

function splitThoughts(parts = []) {
  let text = "", reasoning = "";
  for (const part of parts) {
    if (part.thought) reasoning += part.text || "";
    else text += part.text || "";
  }
  return { text, reasoning };
}

// The same reply in its whole-response shape, for servers that ignore
// "stream" and answer with one JSON body anyway.
const WHOLE_REPLIES = {
  openai: (j) => ({
    text: j.choices?.[0]?.message?.content || "",
    reasoning: "",
    tokens: j.usage?.total_tokens || 0,
  }),
  anthropic: (j) => ({
    text: (j.content || []).filter(b => b.type === "text").map(b => b.text).join(""),
    reasoning: (j.content || []).filter(b => b.type === "thinking").map(b => b.thinking || "").join(""),
    tokens: (j.usage?.input_tokens || 0) + (j.usage?.output_tokens || 0),
  }),
  gemini: (j) => ({
    ...splitThoughts(j.candidates?.[0]?.content?.parts),
    tokens: j.usageMetadata?.totalTokenCount || 0,
  }),
  ollama: (j) => ({
    text: j.message?.content || "",
    reasoning: j.message?.thinking || "",
    tokens: (j.prompt_eval_count || 0) + (j.eval_count || 0),
  }),
};

async function streamProvider(url, opts, kind, onDelta) {
  const res = await openProviderCall(url, opts);
  if ((res.headers.get("content-type") || "").includes("application/json")) {
    const whole = WHOLE_REPLIES[kind]((await res.json()) || {});
    if (whole.text || whole.reasoning || whole.tokens) onDelta(whole);
    return;
  }
  if (!res.body) throw new Error("The provider sent no response body.");

  const parse = STREAM_LINES[kind];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const takeLine = (raw) => {
    const delta = parse(raw);
    if (delta && (delta.text || delta.reasoning || delta.tokens)) onDelta(delta);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n")) >= 0) {
      takeLine(buffer.slice(0, cut).replace(/\r$/, ""));
      buffer = buffer.slice(cut + 1);
    }
  }
  if (buffer.trim()) takeLine(buffer);
}

// How much room to ask Anthropic for its private reasoning. Only sent when the
// user turns the thinking switch on, because it bills extra tokens.
const THINKING_BUDGET = 1024;

/* ---------- browsing the web ----------
   In coding mode the model may ask for one page with
   [browse]https://example.com/page[/browse] and stop. This tab fetches the page
   for real, pulls the readable text out of it, and sends that back so the
   answer comes from what the page actually says rather than from memory. */
const BROWSE_RE = /\[browse\]\s*(https?:\/\/[^\s[]+)\s*\[\/browse\]/i;
const BROWSE_RE_ALL = /\[browse\]\s*(https?:\/\/[^\s[]+)\s*(?:\[\/browse\])?/gi;
/* Three lookups per question is enough for real research and still bounds a
   model that decides to keep browsing forever. */
const MAX_BROWSES = 3;
const PAGE_TEXT_LIMIT = 6000;

function findBrowseRequest(text) {
  BROWSE_RE_ALL.lastIndex = 0;
  const m = BROWSE_RE_ALL.exec(text || "");
  return m ? m[1] : null;
}

function withoutBrowseTags(text) {
  return (text || "").replace(BROWSE_RE_ALL, "");
}

/* A tag streams in piece by piece, so hide a half-arrived one too — otherwise
   the raw markup flashes in the answer before the page is even asked for. */
function hidePartialTag(text) {
  const lower = text.toLowerCase();
  for (let i = lower.lastIndexOf("["); i >= 0; i = lower.lastIndexOf("[", i - 1)) {
    const rest = lower.slice(i);
    if ("[browse]".startsWith(rest) || "[/browse]".startsWith(rest)) return text.slice(0, i);
  }
  return text;
}

function cleanAnswer(text) {
  return hidePartialTag(withoutBrowseTags(text)).trim();
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.hostname}${path}`.slice(0, 64);
  } catch { return url.slice(0, 64); }
}

/* Stripping the chrome off a page before it reaches the model: scripts and
   styles carry nothing useful and cost tokens. */
function readableText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript,template,svg,iframe,canvas").forEach(n => n.remove());
  const title = (doc.querySelector("title")?.textContent || "").trim();
  const main = doc.querySelector("main,article,[role=main]") || doc.body;
  const text = (main?.textContent || "")
    .replace(/\r/g, "")
    .split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  return { title, text: text.slice(0, PAGE_TEXT_LIMIT) };
}

async function fetchPage(url, signal) {
  const relay = relayBase();
  let html = "";
  if (relay) {
    let res;
    try { res = await fetch(`${relay}/browse`, {
      method: "POST", signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }); }
    catch (e) {
      if (e?.name === "AbortError") throw e;
      throw new Error(`The relay at ${relay} did not answer — check Settings → General.`);
    }
    const data = await res.json().catch(() => null);
    /* an older deployed Worker has no /browse route at all, and the relay's own
       errors arrive as {error:{message}} while browse sends a plain string */
    const detail = typeof data?.error === "string" ? data.error : data?.error?.message;
    if (res.status === 404 && !data?.ok)
      throw new Error("this relay predates browsing — redeploy the Worker to update it");
    if (!res.ok || !data?.ok) throw new Error(detail || `${res.status} ${res.statusText}`);
    html = data.html || "";
  } else {
    /* no relay: the tab asks the site itself, which most sites refuse */
    let res;
    try { res = await fetch(url, { signal, redirect: "follow" }); }
    catch (e) {
      if (e?.name === "AbortError") throw e;
      throw new Error("the site does not let a browser page read it — set a relay in Settings → General to browse");
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    html = await res.text();
  }
  const { title, text } = readableText(html);
  if (!text) throw new Error("the page had no readable text");
  return { title, text };
}

/* One lookup, shown as a step, and the page added to the context the model reads
   next. Used both for a tag the model emits and for an address the user types. */
async function readIntoContext(turn, context, url, signal, noteText) {
  const closeStep = turn.startBrowse(url);
  /* the page has to arrive as its own turn, and providers want the roles to
     alternate, so the lookup needs a bridge line before it */
  const bridge = { role: "assistant", text: noteText || "(Reading the page before answering.)" };
  try {
    const page = await fetchPage(url, signal);
    closeStep({ ok: true, title: page.title });
    return [...context, bridge,
      { role: "user", text: `[page contents] ${url}\n\n${page.text}` }];
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    closeStep({ ok: false });
    /* say so plainly — a model that does not know the lookup failed will ask for
       the same page again */
    return [...context, bridge,
      { role: "user", text: `[browse failed] ${url} — ${err?.message || "the page could not be read"}` }];
  }
}

async function callProvider(model, messages, onDelta, signal) {
  const p = state.providers.find(x => x.id === model.providerId);
  if (!p) throw new Error("Provider settings are missing — re-add the model in Settings → Providers.");
  const base = (p.baseUrl || KIND_DEFAULTS[p.kind] || "").replace(/\/+$/, "");
  if (!base) throw new Error("No base URL set — add it in Settings → Providers.");
  if (p.kind !== "ollama" && !p.apiKey) throw new Error("No API key saved — add it in Settings → Providers.");

  const history = messages.slice(-13);
  const wantThinking = !!state.showThinking;
  let text = "";
  const emit = (delta) => {
    if (delta.text) text += delta.text;
    onDelta?.(delta);
  };

  if (p.kind === "anthropic") {
    const msgs = history.map(m => {
      const blocks = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const a of imageAtts(m)) {
        const { mime, data } = splitDataUrl(a.dataUrl);
        blocks.push({ type: "image", source: { type: "base64", media_type: mime, data } });
      }
      return { role: m.role, content: blocks.length ? blocks : [{ type: "text", text: "(empty)" }] };
    });
    const body = {
      model: p.name,
      max_tokens: wantThinking ? 2048 + THINKING_BUDGET : 2048,
      system: systemPrompt(),
      messages: msgs,
      stream: true,
    };
    if (wantThinking) body.thinking = { type: "enabled", budget_tokens: THINKING_BUDGET };
    await streamProvider(`${base}/v1/messages`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": p.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    }, "anthropic", emit);
  } else if (p.kind === "gemini") {
    const contents = history.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [
        { text: m.text || "(see attachment)" },
        ...imageAtts(m).map(a => {
          const { mime, data } = splitDataUrl(a.dataUrl);
          return { inline_data: { mime_type: mime, data } };
        }),
      ],
    }));
    const body = { systemInstruction: { parts: [{ text: systemPrompt() }] }, contents };
    if (wantThinking) body.generationConfig = { thinkingConfig: { includeThoughts: true } };
    await streamProvider(
      `${base}/v1beta/models/${encodeURIComponent(p.name)}:streamGenerateContent?alt=sse`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-goog-api-key": p.apiKey },
      body: JSON.stringify(body),
    }, "gemini", emit);
  } else {
    const msgs = [{ role: "system", content: systemPrompt() }];
    for (const m of history) {
      const imgs = imageAtts(m);
      if (p.kind === "openai" && m.role === "user" && imgs.length) {
        msgs.push({
          role: "user",
          content: [
            { type: "text", text: m.text || "Describe this image." },
            ...imgs.map(a => ({ type: "image_url", image_url: { url: a.dataUrl } })),
          ],
        });
      } else {
        const entry = { role: m.role, content: m.text || "(see attachment)" };
        if (p.kind === "ollama" && imgs.length)
          entry.images = imgs.map(a => splitDataUrl(a.dataUrl).data);
        msgs.push(entry);
      }
    }

    if (p.kind === "ollama") {
      await streamProvider(`${base}/api/chat`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: p.name, messages: msgs, stream: true }),
      }, "ollama", emit);
    } else {
      await streamProvider(`${base}/chat/completions`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({ model: p.name, messages: msgs, max_tokens: 2048, stream: true }),
      }, "openai", emit);
    }
  }

  if (!text.trim()) throw new Error("The provider returned an empty response.");
  return text;
}

/* ---------- composer ---------- */
function autoresize() {
  const ta = els.input;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  $("#charCount").textContent = ta.value.length;
}

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  /* the same button is the stop control while a reply is coming in */
  if (turnController) { stopTurn(); return; }
  sendMessage(els.input.value);
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(els.input.value);
  }
});
els.input.addEventListener("input", autoresize);

/* ---------- attachments ---------- */
let pendingAtts = [];

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error(`Could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

els.fileInput.addEventListener("change", async () => {
  for (const f of els.fileInput.files) {
    if (f.size > 5 * 1024 * 1024) {
      toast(`"${f.name}" is over 5 MB — skipped`);
      continue;
    }
    const item = { name: f.name, type: f.type, size: f.size };
    if ((f.type || "").startsWith("image/")) {
      try { item.dataUrl = await readAsDataURL(f); }
      catch (err) { toast(err.message); continue; }
    } else if (looksLikeText(f)) {
      /* a file the model never sees is not an attachment, it is a filename. Read
         the characters in, and "analyse this" becomes something that happens. */
      try {
        item.text = (await readAsText(f)).replace(/\r\n/g, "\n").slice(0, DOC_LIMIT);
        if (item.text.trim()) item.kind = "text";
        else delete item.text;
      }
      catch (err) { toast(err.message); continue; }
    }
    pendingAtts.push(item);
  }
  els.fileInput.value = "";
  renderPending();
});

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error(`Could not read ${file.name} as text`));
    r.readAsText(file);
  });
}

function renderPending() {
  els.attachTray.innerHTML = "";
  els.attachTray.hidden = !pendingAtts.length;
  pendingAtts.forEach((a, i) => {
    const chip = document.createElement("span");
    chip.className = "pend-att";
    if (a.dataUrl) {
      const img = document.createElement("img");
      img.src = a.dataUrl;
      img.alt = a.name;
      chip.append(img);
    } else {
      const label = document.createElement("span");
      label.className = "pend-file";
      label.textContent = `📄 ${a.name}`;
      chip.append(label);
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "pend-x";
    x.textContent = "✕";
    x.setAttribute("aria-label", `Remove ${a.name}`);
    x.addEventListener("click", () => {
      pendingAtts.splice(i, 1);
      renderPending();
    });
    chip.append(x);
    els.attachTray.append(chip);
  });
}

els.lightbox.addEventListener("click", () => {
  els.lightbox.hidden = true;
  els.lightboxImg.src = "";
});

/* ---------- mic ----------
   In a browser tab, dictation is Chromium's own speech service. Inside the
   desktop app that service has no backend to talk to — it starts, then answers
   `error:network` — so Studio records the audio and has the model you already
   configured write it out. Gemini is the one provider kind that accepts an audio
   part, so the button says so when something else is selected. */
const SRClass = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recOn = false;

els.micBtn.addEventListener("click", () => {
  if (DESKTOP) { toggleDesktopDictation(); return; }
  if (!SRClass) {
    toast("Dictation needs Chrome or Edge.");
    return;
  }
  if (recOn) { rec?.stop(); return; }
  rec = new SRClass();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  rec.continuous = true;
  const base = els.input.value;
  rec.onresult = (e) => {
    let finalText = "", interim = "";
    for (const r of e.results) {
      if (r.isFinal) finalText += r[0].transcript + " ";
      else interim += r[0].transcript;
    }
    els.input.value = ((base ? base + " " : "") + finalText + interim).trimStart();
    autoresize();
  };
  rec.onend = () => {
    recOn = false;
    els.micBtn.classList.remove("recording");
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed")
      toast("Microphone permission denied.");
    else if (e.error === "network")
      toast("Dictation could not reach the speech service — try again, or type it.");
  };
  recOn = true;
  els.micBtn.classList.add("recording");
  rec.start();
});

/* The recording never leaves the machine until the transcribe request goes out,
   and that goes to the same provider every other message goes to. */
let dictation = null;
const DICTATION_CAP_MS = 90_000;

function toggleDesktopDictation() {
  if (dictation) { dictation.stop(); return; }

  const model = selectedModel();
  const provider = model && state.providers.find(x => x.id === model.providerId);
  if (!provider) {
    toast("Desktop dictation transcribes with your own model — add a provider in Settings, then pick it here.");
    return;
  }
  if (provider.kind !== "gemini") {
    toast(`${provider.name} takes text only. Pick a Gemini model to dictate with — it reads audio.`);
    return;
  }

  startDictation(provider).catch(err => {
    dictation = null;
    els.micBtn.classList.remove("recording");
    toast(err?.message || "The microphone could not be opened.");
  });
}

async function startDictation(provider) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };

  const session = { stream, recorder, stopped: false };
  session.stop = () => {
    if (session.stopped) return;
    session.stopped = true;
    clearTimeout(cap);
    dictation = null;
    els.micBtn.classList.remove("recording");
    if (recorder.state !== "inactive") recorder.stop();
  };
  dictation = session;
  const cap = setTimeout(session.stop, DICTATION_CAP_MS);

  els.micBtn.classList.add("recording");
  recorder.onstop = async () => {
    const mime = recorder.mimeType || "audio/webm";
    const blob = new Blob(chunks, { type: mime.split(";")[0] });
    for (const track of stream.getTracks()) track.stop();
    if (!blob.size) { toast("Nothing was recorded."); return; }
    await transcribe(provider, blob, mime.split(";")[0]);
  };
  recorder.start();
}

async function transcribe(provider, blob, mime) {
  toast("Transcribing the recording…");
  els.micBtn.disabled = true;
  try {
    const apiBase = (provider.baseUrl || KIND_DEFAULTS[provider.kind] || "").replace(/\/+$/, "");
    if (!apiBase) throw new Error("No base URL set — add it in Settings → Providers.");
    const data = await httpJson(
      `${apiBase}/v1beta/models/${encodeURIComponent(provider.name)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": provider.apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [
          { inline_data: { mime_type: mime, data: await blobToBase64(blob) } },
          { text: "Transcribe this recording exactly as spoken. Reply with the transcript only — no preamble, no commentary." },
        ] }],
        generationConfig: { temperature: 0, maxOutputTokens: 2048 },
      }),
    });
    const text = (data.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || "").join("").trim();
    if (!text) { toast("The model returned no transcript."); return; }
    const already = els.input.value.trim();
    els.input.value = (already ? already + " " : "") + text;
    autoresize();
    els.input.focus();
  } catch (err) {
    toast(err?.message || "Transcription failed.");
  } finally {
    els.micBtn.disabled = false;
  }
}

/* btoa over the whole file at once blows the argument limit on long recordings. */
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/* ---------- suggestions & mode ----------
   Four cards laid out wide / square / square / wide. Each mode has its own set
   and its own system prompt; the set follows the mode so the cards stay useful. */
const SUGGESTIONS = {
  chat: [
    { wide: true, icon: "✎", title: "Draft a brief",
      prompt: "Write a project brief for a weekly team newsletter" },
    { icon: "◎", title: "Explain a concept",
      prompt: "Explain the difference between RAG and fine-tuning, simply" },
    { icon: "☼", title: "Plan a trip",
      prompt: "Help me plan a 3-day trip to Kyoto in autumn" },
    { wide: true, icon: "✓", title: "Review an idea",
      prompt: "Review this idea: an app that turns meeting notes into tasks" },
  ],
  coding: [
    { wide: true, icon: "⌗", title: "Debug an error",
      prompt: "Here is a stack trace, walk me through what is breaking and how to fix it: [paste]" },
    { icon: "▸", title: "Write a test",
      prompt: "Write a test for this function, including the edge cases: [paste]" },
    { icon: "↺", title: "Refactor",
      prompt: "Refactor this for clarity without changing what it does: [paste]" },
    { wide: true, icon: "⌕", title: "Explain this code",
      prompt: "Explain what this code does line by line, then tell me what could go wrong with it: [paste]" },
  ],
};

/* The browse syntax is worth a hint where it is actually used, otherwise it is
   only knowable from the system prompt. */
const PLACEHOLDER_BY_MODE = {
  chat: "Message Notal AI… or hand me a page: [browse]https://…[/browse]",
  coding: "Let's code — paste a bug, or hand me a page: [browse]https://…[/browse]",
};

function renderSuggestions() {
  const cards = SUGGESTIONS[state.mode] || SUGGESTIONS.chat;
  els.suggestions.replaceChildren(...cards.map((c) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggestion" + (c.wide ? " wide" : "");
    btn.dataset.prompt = c.prompt;
    const icon = document.createElement("span");
    icon.className = "s-icon";
    icon.textContent = c.icon;
    const text = document.createElement("span");
    text.className = "s-text";
    const title = document.createElement("span");
    title.className = "s-title";
    title.textContent = c.title;
    text.append(title);
    /* the wide cards have room to show the actual prompt they send */
    if (c.wide) {
      const desc = document.createElement("span");
      desc.className = "s-desc";
      desc.textContent = c.prompt;
      text.append(desc);
    }
    btn.append(icon, text);
    return btn;
  }));
}

/* One turn of the topbar mark when the mode changes: the app switched minds and
   says so. The reflow read restarts the animation even when you flip Chat and
   Coding faster than a frame, and animationend — not a timer — clears the class,
   so a browser that dials motion back still gets its own longer spin. */
function spinMark() {
  const mark = els.topMark;
  if (!mark) return;
  mark.classList.remove("mark-spin");
  void mark.offsetWidth;
  mark.classList.add("mark-spin");
}
els.topMark?.addEventListener("animationend", () => els.topMark.classList.remove("mark-spin"));

function setMode(mode) {
  if (!SUGGESTIONS[mode]) return;
  const changed = state.mode !== mode;
  state.mode = mode;
  save();
  els.modeSeg.querySelectorAll(".mode-btn").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  els.input.placeholder = PLACEHOLDER_BY_MODE[mode];
  /* the rainbow edge belongs to the whole main column, so coding reads as a
     different room and not just a different prompt */
  if (els.main) els.main.dataset.mode = mode;
  renderSuggestions();
  if (changed) spinMark();
}

els.modeSeg.addEventListener("click", (e) => {
  const btn = e.target.closest(".mode-btn");
  if (btn) setMode(btn.dataset.mode);
});

els.suggestions.addEventListener("click", (e) => {
  const btn = e.target.closest(".suggestion");
  if (!btn) return;
  /* fills the box for editing — the card is a starting point, not a send */
  els.input.value = btn.dataset.prompt;
  autoresize();
  els.input.focus();
});

/* ---------- sidebar ---------- */
function setSidebar(open) {
  els.sidebar.classList.toggle("collapsed", !open);
  els.sidebarClose.title = open ? "Collapse sidebar" : "Show sidebar";
  els.sidebarClose.setAttribute("aria-label", els.sidebarClose.title);
  state.sidebarOpen = open;
  save();
}
els.sidebarClose.addEventListener("click", () => setSidebar(els.sidebar.classList.contains("collapsed")));
els.sidebarOpen.addEventListener("click", () => setSidebar(true));

document.querySelectorAll(".nav-item").forEach(btn => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

els.newChat.addEventListener("click", newConversation);
els.search.addEventListener("input", () => renderHistory(els.search.value));

/* ---------- model picker ---------- */
function setModelMenu(open) {
  els.modelMenu.hidden = !open;
  els.modelPicker.classList.toggle("open", open);
}

function renderModelMenu() {
  els.modelMenu.innerHTML = "";
  for (const m of state.models) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "model-option" + (m.id === state.selectedModel ? " selected" : "");
    b.dataset.modelId = m.id;
    const name = document.createElement("span");
    name.textContent = m.name;
    const prov = document.createElement("small");
    prov.textContent = m.provider;
    b.append(name, prov);
    els.modelMenu.append(b);
  }
  const divider = document.createElement("div");
  divider.className = "menu-divider";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "model-option menu-add";
  const addLabel = document.createElement("span");
  addLabel.textContent = "＋  Add models in Settings";
  add.append(addLabel);
  els.modelMenu.append(divider, add);
}

els.modelPicker.addEventListener("click", (e) => {
  e.stopPropagation();
  if (e.target.closest(".model-option")) return;
  setModelMenu(els.modelMenu.hidden);
});

els.modelMenu.addEventListener("click", (e) => {
  if (e.target.closest(".menu-add")) {
    setModelMenu(false);
    openSettings("providers");
    return;
  }
  const opt = e.target.closest(".model-option");
  if (!opt?.dataset.modelId) return;
  state.selectedModel = opt.dataset.modelId;
  els.modelName.textContent = selectedModel().name;
  save();
  renderModelMenu();
  setModelMenu(false);
});

/* ---------- settings modal ---------- */
els.overlay = $("#settingsOverlay");
els.settingsModal = document.querySelector("#settingsOverlay .modal");
els.settingsClose = $("#settingsClose");
els.gearBtn = $("#gearBtn");

let settingsOpen = false;
function openSettings(tab = "general") {
  settingsOpen = true;
  /* these readouts are snapshots of what just happened — a chat turn can change
     a provider's status, so they are refreshed on every open, not at load */
  renderProviders();
  renderRelayUI();
  renderDiagnostics();
  renderBrowserModel();
  els.overlay.hidden = false;
  motion.reveal(els.settingsModal);
  switchTab(tab);
}
function closeSettings() {
  if (!settingsOpen) return;
  settingsOpen = false;
  /* a reopen during the drop-in cancels the hide */
  motion.settle(els.settingsModal, () => { if (!settingsOpen) els.overlay.hidden = true; });
}

els.gearBtn.addEventListener("click", () => openSettings());
els.settingsClose.addEventListener("click", closeSettings);
els.overlay.addEventListener("click", (e) => {
  if (e.target === els.overlay) closeSettings();
});
els.signinBtn = $("#signinBtn");
els.accountMenu = $("#accountMenu");
els.amAvatar = $("#amAvatar");
els.amName = $("#amName");
els.amSub = $("#amSub");
els.amSettingsBtn = $("#amSettingsBtn");
els.amSignInBtn = $("#amSignInBtn");
els.amSignOutBtn = $("#amSignOutBtn");
els.amSwitchBtn = $("#amSwitchBtn");

function setAccountMenu(open) {
  els.accountMenu.hidden = !open;
  els.signinBtn.setAttribute("aria-expanded", String(open));
  els.signinBtn.classList.toggle("open", open);
}

els.signinBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setAccountMenu(els.accountMenu.hidden);
});
els.accountMenu.addEventListener("click", (e) => e.stopPropagation());
els.amSettingsBtn.addEventListener("click", () => { setAccountMenu(false); openSettings(); });
els.amSignInBtn.addEventListener("click", () => { setAccountMenu(false); els.googleSignInBtn.click(); });
els.amSignOutBtn.addEventListener("click", () => { setAccountMenu(false); els.googleSignOutBtn.click(); });
els.amSwitchBtn.addEventListener("click", async () => {
  setAccountMenu(false);
  els.amSwitchBtn.disabled = true;
  try {
    const { auth, mods } = await ensureAuth();
    await mods.signOut(auth);
    const provider = new mods.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await mods.signInWithPopup(auth, provider);
    toast("Switched account.");
  } catch (err) {
    const cancelled = String(err?.code || "").includes("popup-closed-by-user")
      || String(err?.code || "").includes("cancelled");
    toast(cancelled ? "Sign-in cancelled — you are signed out."
      : "Could not switch account: " + String(err?.message || err).slice(0, 120));
  } finally {
    els.amSwitchBtn.disabled = false;
  }
});

document.querySelectorAll(".settings-tab").forEach(tab => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});
function switchTab(name) {
  document.querySelectorAll(".settings-tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".settings-panel").forEach(p =>
    p.hidden = p.id !== `panel-${name}`);
  if (name === "desktop" && DESKTOP) renderStudioSettings();
}

/* ---------- general ---------- */
const THEME_SEGS = document.querySelectorAll("[data-theme-seg]");
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLORS[state.theme] || THEME_COLORS.light;
  THEME_SEGS.forEach(seg => seg.querySelectorAll("button").forEach(b =>
    b.classList.toggle("active", b.dataset.themeVal === state.theme)));
}
THEME_SEGS.forEach(seg => seg.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-theme-val]");
  if (!btn) return;
  state.theme = btn.dataset.themeVal;
  applyTheme();
  save();
}));

$("#clearChatsBtn").addEventListener("click", () => {
  if (!state.conversations.length) return;
  if (!confirm("Delete all conversations? This cannot be undone.")) return;
  state.conversations = [];
  state.activeId = null;
  save();
  renderHistory(els.search.value);
  renderMessages();
});

/* ---------- model reasoning switch ---------- */
els.thinkingToggle = $("#thinkingToggle");
els.thinkingToggle.checked = !!state.showThinking;
els.thinkingToggle.addEventListener("change", () => {
  state.showThinking = els.thinkingToggle.checked;
  save();
  renderDiagnostics();
  toast(state.showThinking
    ? "Reasoning on — supported models think in the box beside their reply."
    : "Reasoning off.");
});

/* ---------- provider relay ----------
   The label has to describe what is actually true: a URL that was typed in is
   not the same as a relay that answered. Verification is stored against the
   exact URL it was earned on, so a new address never inherits an old tick. */
els.relayUrlInput = $("#relayUrlInput");
els.relayStatus = $("#relayStatus");
els.relayTestBtn = $("#relayTestBtn");

function relayVerifiedInfo() {
  const v = state.relayVerified;
  return v && v.url === relayBase() ? v : null;
}

function agoText(at) {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} h ago` : `${Math.round(hrs / 24)} days ago`;
}

function renderRelayUI(msg) {
  els.relayUrlInput.value = state.relayUrl || "";
  if (msg) { els.relayStatus.textContent = msg; return; }
  if (!relayBase()) {
    els.relayStatus.textContent = "Not set — requests leave this browser tab and go straight to the provider";
    return;
  }
  const v = relayVerifiedInfo();
  els.relayStatus.textContent = v
    ? `Working — verified ${agoText(v.at)}. Requests go through it, not directly from this tab`
    : "Set, but never verified — requests are being routed through it now, and nothing has confirmed it answers. Press Test.";
}

els.relayUrlInput.addEventListener("change", () => {
  let v = els.relayUrlInput.value.trim().replace(/\/+$/, "");
  if (v && !/^https?:\/\//i.test(v)) v = "https://" + v;
  state.relayUrl = v;
  state.relayVerified = null;
  save();
  renderRelayUI(v ? "Checking…" : null);
  renderDiagnostics();
  if (v) els.relayTestBtn.click();
});

els.relayTestBtn.addEventListener("click", async () => {
  const base = relayBase();
  if (!base) { renderRelayUI("Nothing to test — add the relay URL first."); return; }
  renderRelayUI("Testing…");
  els.relayTestBtn.disabled = true;
  try {
    const res = await fetch(`${base}/health`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    state.relayVerified = { url: base, at: Date.now(), hosts: data.hosts ?? null };
    save();
    renderRelayUI(`Working — verified just now. Allow-listed ${data.hosts ?? "?"} provider hosts`);
  } catch (err) {
    state.relayVerified = null;
    save();
    renderRelayUI("Not reachable: " + String(err?.message || err).slice(0, 90)
      + " — every provider call fails until this is fixed or the URL is cleared.");
  } finally {
    els.relayTestBtn.disabled = false;
    renderDiagnostics();
  }
});

/* ---------- account ---------- */
els.displayNameInput = $("#displayNameInput");
els.displayNameInput.value = state.displayName;
els.displayNameInput.addEventListener("input", () => {
  state.displayName = els.displayNameInput.value.trim();
  save();
  setGreeting();
  if (!currentUser) renderAuthUI();
});

/* ---------- provider setup ----------
   A short guided path instead of four jargon fields at once. Each entry says, in
   plain words, whether a key is needed, where that key comes from, and where the
   text is going. The fields are all on screen together — nothing is hidden behind
   a wizard step — so an experienced user can fill it in top to bottom in seconds. */
const PROVIDER_GUIDE = [
  {
    id: "anthropic", kind: "anthropic", label: "Anthropic", blurb: "Claude",
    needsKey: true, keyFrom: "console.anthropic.com, under API keys",
    baseUrl: "https://api.anthropic.com", example: "claude-sonnet-4-5",
    where: "Your text goes from this browser tab straight to api.anthropic.com.",
  },
  {
    id: "openai", kind: "openai", label: "OpenAI", blurb: "GPT",
    needsKey: true, keyFrom: "platform.openai.com, under API keys",
    baseUrl: "https://api.openai.com/v1", example: "gpt-4o-mini",
    where: "Your text goes from this browser tab straight to api.openai.com.",
  },
  {
    id: "gemini", kind: "gemini", label: "Google Gemini", blurb: "Gemini",
    needsKey: true, keyFrom: "aistudio.google.com, Get API key",
    baseUrl: "https://generativelanguage.googleapis.com", example: "gemini-3.8-flash",
    where: "Your text goes from this browser tab straight to Google's generative language API.",
  },
  {
    id: "ollama", kind: "ollama", label: "Ollama, here", blurb: "local, free",
    needsKey: false, keyFrom: "",
    baseUrl: "http://localhost:11434", example: "llama3.1:8b",
    where: "Nothing leaves this computer — the tab talks to Ollama running on it.",
  },
  {
    id: "custom", kind: "openai", label: "Something else", blurb: "OpenAI-shaped API",
    needsKey: true, keyFrom: "that service's own dashboard",
    baseUrl: "", example: "the exact model ID they list",
    where: "Goes to whichever address you set in Advanced below.",
  },
];

els.providerList = $("#providerList");
els.providerForm = $("#providerForm");
els.provCards = $("#provCards");
els.pfNeed = $("#pfNeed");
els.pfName = $("#pfName");
els.pfKey = $("#pfKey");
els.pfKeyWrap = $("#pfKeyWrap");
els.pfUrl = $("#pfUrl");

let guidePick = null;

function renderProvCards() {
  els.provCards.replaceChildren(...PROVIDER_GUIDE.map((g) => {
    const b = document.createElement("button");
    /* inside a form, so it has to say it is not the submit control */
    b.type = "button";
    b.className = "prov-card";
    b.dataset.guide = g.id;
    b.setAttribute("aria-pressed", "false");
    const name = document.createElement("span");
    name.className = "pc-name";
    name.textContent = g.label;
    const blurb = document.createElement("small");
    blurb.textContent = g.needsKey ? `${g.blurb} · needs a key` : `${g.blurb} · no key`;
    b.append(name, blurb);
    b.addEventListener("click", () => { guidePick = g; applyGuide(); });
    return b;
  }));
}

function applyGuide() {
  els.provCards.querySelectorAll(".prov-card").forEach((b) => {
    const on = b.dataset.guide === guidePick.id;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  const g = guidePick;
  els.pfName.placeholder = `e.g. ${g.example}`;
  els.pfNeed.textContent = g.needsKey
    ? `${g.label} needs an API key — you get one from ${g.keyFrom}. ${g.where}`
    : `${g.label} needs no key. ${g.where}`;
  els.pfKeyWrap.hidden = !g.needsKey;
  if (!g.needsKey) els.pfKey.value = "";
  /* an unlisted service is exactly the case the base URL field exists for */
  if (g.id === "custom") setAdv("providers", true);
}

function providerAddress(p) {
  return (p.baseUrl || KIND_DEFAULTS[p.kind] || "").replace(/\/+$/, "") || "no address set";
}

function providerStatus(p) {
  if (!p.baseUrl && !KIND_DEFAULTS[p.kind]) return { label: "Needs a base URL", tone: "warn" };
  if (p.kind !== "ollama" && !p.apiKey) return { label: "Needs an API key", tone: "warn" };
  if (!p.test) return { label: "Not tested yet", tone: "idle" };
  return p.test.ok
    ? { label: "Works", tone: "ok" }
    : { label: "Not working", tone: "bad" };
}

function renderProviders() {
  els.providerList.innerHTML = "";
  if (!state.providers.length) {
    els.providerList.innerHTML = `<li class="history-empty">No models added yet — the built-in one still answers.</li>`;
    return;
  }
  for (const p of state.providers) {
    const li = document.createElement("li");
    li.className = "provider-item";

    const meta = document.createElement("div");
    meta.className = "pi-meta";
    const name = document.createElement("span");
    name.textContent = p.name;
    const detail = document.createElement("small");
    detail.textContent = `${p.provider} · ${providerAddress(p)}`;
    const note = document.createElement("small");
    note.className = "pi-note";
    const st = providerStatus(p);
    note.textContent = st.tone === "bad" || st.tone === "ok"
      ? `${p.test.msg} · ${agoText(p.test.at)}`
      : st.label === "Not tested yet"
        ? "Press Test to send one short message and check the key and model ID."
        : "Fill this in and it will not answer yet.";
    meta.append(name, detail, note);

    const badge = document.createElement("span");
    badge.className = "status " + st.tone;
    badge.textContent = st.label;

    const test = document.createElement("button");
    test.type = "button";
    test.className = "ghost-btn";
    test.textContent = "Test";
    test.title = `Send one short message to ${p.provider} to check this model`;
    test.addEventListener("click", () => testProvider(p.id, test));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn pi-del";
    del.setAttribute("aria-label", `Remove ${p.name}`);
    del.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
    del.addEventListener("click", () => removeProvider(p.id));

    li.append(meta, badge, test, del);
    els.providerList.append(li);
  }
}

function removeProvider(id) {
  state.providers = state.providers.filter(p => p.id !== id);
  state.models = state.models.filter(m => m.providerId !== id);
  if (!state.models.some(m => m.id === state.selectedModel)) state.selectedModel = "notal-generic";
  save();
  renderProviders();
  renderModelMenu();
  els.modelName.textContent = selectedModel().name;
}

/* ---------- local AI, the developer's switch ----------
   Off until someone asks for it: what it saves — a key, a server, a request
   leaving the tab — costs a 290 MB wait and a browser that can do WebGPU. Two
   facts are kept apart, whether the switch is on and whether the weights are
   actually on this device. */
const wmEls = {
  box: $("#wmBox"), body: $("#wmBody"), status: $("#wmStatus"), bar: $("#wmBar"),
  getBtn: $("#wmGet"), offBtn: $("#wmOff"), switchBox: $("#wmSwitch"),
};

function browserModelEntry() {
  return {
    id: WEB_MODEL_ID, name: WEB_MODEL_NAME, provider: "Runs on this device",
    browser: true, card: WEB_MODEL_CARD,
  };
}

/* Idempotent: the boot path and a finished download both call this. */
function addBrowserModel() {
  if (!state.models.some(m => m.id === WEB_MODEL_ID)) state.models.push(browserModelEntry());
}

function dropBrowserModel() {
  state.models = state.models.filter(m => m.id !== WEB_MODEL_ID);
  if (state.selectedModel === WEB_MODEL_ID) state.selectedModel = "notal-generic";
}

/* The picker follows both flags, never one of them: a model that is on disk but
   switched off has no business being offered, and vice versa. */
function syncLocalAIModel() {
  if (state.localAI && state.localAIFiles) addBrowserModel(); else dropBrowserModel();
  save();
  renderModelMenu();
  els.modelName.textContent = selectedModel().name;
}

function wmProgress(text, pct) {
  /* WebLLM weighs its download fraction by the bytes of each shard, so the size
     the card advertises is a fair thing to multiply it by. Other phases report
     a fraction of their own small job, which is not a share of the download. */
  if (typeof pct !== "number" || pct < 0) { wmEls.status.textContent = progressWords(text, pct); return; }
  wmEls.bar.value = Math.round(pct * 100);
  wmEls.status.textContent = progressWords(text, pct);
}

/* Three different no's, each with its own fixing, and all three say the same
   thing about the model menu: nothing is offered until there is a device to run
   it on. The commonest one on Linux Chrome is a browser that has WebGPU and uses
   ANGLE's OpenGL backend, where the only adapter Dawn can name is one it keeps
   to itself — the same machine's Vulkan driver is often perfectly usable. */
function localAINoWords(reason) {
  const menu = ` So "${WEB_MODEL_NAME}" stays out of the model menu until it can actually run.`;
  if (reason === "no-api")
    return "This browser has no WebGPU at all. Open Notal in a recent Chrome, Edge or Safari." + menu;
  if (reason === "stalled")
    return "The browser's graphics process never answered, which says nothing about the model. "
      + "Reload the page; if it stays silent, Chrome has a wedged GPU process." + menu;
  return "This browser speaks WebGPU but its graphics process handed out no adapter, so there is "
    + "nothing here to run a model on — that is the graphics driver, not Notal. On Linux Chrome the "
    + "usual cause is ANGLE sitting on OpenGL instead of Vulkan: quit Chrome completely and reopen "
    + "it with --use-angle=vulkan." + menu;
}

async function renderBrowserModel() {
  if (!wmEls.box) return;
  wmEls.switchBox.checked = !!state.localAI;
  wmEls.body.hidden = !state.localAI;
  if (!state.localAI) return;

  const support = await webModelSupport();
  /* The cache is the evidence, and it is only trusted to *find* files this
     browser forgot it had. Deciding they are gone costs someone a 290 MB
     re-download, so that is the Remove button's job alone. */
  const filesThere = support.ok ? await webModelOnDevice().catch(() => state.localAIFiles) : state.localAIFiles;
  if (filesThere && !state.localAIFiles) {
    state.localAIFiles = true;
    syncLocalAIModel();
  }
  const mb = filesThere ? await webModelBytes() : null;
  wmEls.bar.hidden = true;
  wmEls.getBtn.disabled = false;
  wmEls.getBtn.hidden = true;
  wmEls.offBtn.hidden = true;

  if (!support.ok) {
    wmEls.status.textContent = localAINoWords(support.reason);
    return;
  }
  if (state.localAIFiles && !filesThere) {
    wmEls.getBtn.hidden = false;
    wmEls.getBtn.textContent = `Download again (${WEB_MODEL_MB} MB)`;
    wmEls.status.textContent = "The weights are no longer in this browser's storage — something cleared "
      + "it. Until they come back this model will not answer.";
    return;
  }
  if (filesThere) {
    wmEls.offBtn.hidden = false;
    wmEls.status.textContent = `On this device — ${mb ? `${mb} MB` : `about ${WEB_MODEL_MB} MB`} of model files, kept by this browser. `
      + `It is in the model menu as "${WEB_MODEL_NAME}"; nothing about a reply leaves the tab.`;
    return;
  }
  wmEls.getBtn.hidden = false;
  wmEls.getBtn.textContent = `Download (${WEB_MODEL_MB} MB, once)`;
  wmEls.status.textContent = "Fetched once from Hugging Face, then never again. After that the graphics "
    + "card does the work and no request leaves this tab.";
}

async function downloadBrowserModel() {
  wmEls.getBtn.disabled = true;
  wmEls.bar.hidden = false;
  wmEls.bar.value = 0;
  wmEls.status.textContent = "Fetching the model library…";
  try {
    await webModelEngine(wmProgress);
    state.localAIFiles = true;
    syncLocalAIModel();
    wmProgress("Ready", 1);
    toast("local ai is on this device. Pick it in the model menu.");
    renderBrowserModel();
  } catch (err) {
    wmEls.getBtn.disabled = false;
    wmEls.bar.hidden = true;
    wmEls.status.textContent = "⚠ " + webModelError(err);
  }
}

if (wmEls.switchBox) wmEls.switchBox.addEventListener("change", () => {
  state.localAI = wmEls.switchBox.checked;
  save();
  syncLocalAIModel();
  renderBrowserModel();
});
if (wmEls.getBtn) wmEls.getBtn.addEventListener("click", downloadBrowserModel);
if (wmEls.offBtn) wmEls.offBtn.addEventListener("click", async () => {
  wmEls.offBtn.disabled = true;
  wmEls.status.textContent = "Deleting the model files…";
  try { await webModelForget(); } catch { /* the files are gone either way */ }
  state.localAIFiles = false;
  syncLocalAIModel();
  wmEls.offBtn.disabled = false;
  toast("Freed the space. The switch stays on if you want it again.");
  renderBrowserModel();
});

/* Turns a raw failure into something a person can act on. The distinction that
   matters most: a connection that never arrived says nothing about the key. */
function friendlyTestError(err, p) {
  const m = String(err?.message || err);
  if (err?.name === "AbortError") return "Gave up after 30 seconds with no answer. The provider never replied.";
  if (/failed to fetch|load failed|network|cors|could not reach/i.test(m)) {
    return p.kind === "ollama"
      ? `Nothing answered on ${providerAddress(p)}. Is Ollama running, and have you pulled that model? (ollama pull ${p.name})`
      : `Nothing answered at ${providerAddress(p)} at all. The address is wrong, the service is down, or it refuses calls from a web page — a relay in Advanced gets around that last one. This is not about your key: a key is only checked once the connection exists.`;
  }
  if (/\b401\b|invalid api key|incorrect api key|unauthorized/i.test(m))
    return "The key was refused (401). Paste it again in full, and check it is a key for this provider.";
  if (/\b403\b|forbidden|permission/i.test(m))
    return "Your key is not allowed to use this model or API (403).";
  if (/\b404\b|not found|unknown model|invalid model|does not exist/i.test(m))
    return `Nothing at that address answers as "${p.name}" (404). Model IDs are the usual cause — copy the exact one the provider lists.`;
  if (/\b429\b|rate|quota|insufficient|credit|billing/i.test(m))
    return "Rate limited, or the account has no credit left (429). Check the billing page on that provider.";
  if (/\b5\d\d\b|overloaded|server error/i.test(m))
    return "The provider itself is failing right now. Try again in a minute.";
  return m.slice(0, 180);
}

/* Both the test button and a real chat turn write through here, so the status
   label always comes from something that actually happened. */
function recordProviderResult(id, ok, msg) {
  const p = state.providers.find(x => x.id === id);
  if (!p) return;
  p.test = { ok, at: Date.now(), msg };
  save();
}

/* One real round trip through the same path a chat message uses, so a pass
   means the chat will work and a fail names the actual problem. */
async function testProvider(id, btn) {
  const p = state.providers.find(x => x.id === id);
  if (!p) return;
  btn.disabled = true;
  btn.textContent = "Testing…";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const reply = await callProvider(
      { id: p.id, providerId: p.id, name: p.name },
      [{ role: "user", text: "Reply with exactly one word: ok" }],
      () => {}, ac.signal);
    p.test = { ok: true, at: Date.now(), msg: `Answered “${reply.trim().slice(0, 40)}”` };
    toast(`"${p.name}" is working.`);
  } catch (err) {
    p.test = { ok: false, at: Date.now(), msg: friendlyTestError(err, p) };
    toast(`Test failed: ${p.test.msg}`);
  } finally {
    clearTimeout(timer);
    btn.disabled = false;
    btn.textContent = "Test";
    save();
    renderProviders();
    renderDiagnostics();
  }
}

els.providerForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!guidePick) { toast("Step 1 first — choose who answers."); els.provCards.querySelector(".prov-card")?.focus(); return; }
  const name = els.pfName.value.trim();
  if (!name) return;
  const base = els.pfUrl.value.trim() || guidePick.baseUrl;
  if (!base) { setAdv("providers", true); toast("That provider has no built-in address — set the base URL in Advanced."); return; }
  const provider = {
    id: crypto.randomUUID(),
    kind: guidePick.kind,
    provider: guidePick.label,
    name,
    baseUrl: base,
    apiKey: guidePick.needsKey ? els.pfKey.value.trim() : "",
    test: null,
  };
  state.providers.push(provider);
  state.models.push({ id: provider.id, name, provider: provider.provider, providerId: provider.id });
  els.providerForm.reset();
  save();
  renderProviders();
  renderModelMenu();
  renderDiagnostics();
  toast(provider.apiKey || provider.kind === "ollama"
    ? `Model "${name}" added — press Test on its row to check it with one tiny message.`
    : `Model "${name}" added, but it has no API key yet — it will not answer until you add one.`);
});

/* ---------- diagnostics ----------
   Everything here is read back from your own settings; nothing is sent anywhere
   to produce it. */
els.diagOut = $("#diagOut");

function diagnosticsText() {
  const model = selectedModel();
  const p = state.providers.find(x => x.id === model.providerId);
  const relay = relayBase();
  const verified = relayVerifiedInfo();
  const keys = state.providers.filter(x => x.apiKey).map(x => x.name);
  const bytes = new Blob([JSON.stringify(state)]).size;
  const chats = state.conversations.length;
  const msgs = state.conversations.reduce((n, c) => n + c.messages.length, 0);
  const lines = [
    `Model in use: ${model.name}${model.provider ? ` (${model.provider})` : ""}`,
    p
      ? `Requests to: ${providerAddress(p)} · ${relay
        ? `routed through the relay${verified ? " (verified " + agoText(verified.at) + ")" : " (NOT verified)"}`
        : "direct from this browser tab"}`
      : "Requests to: nowhere — the built-in model answers, your text leaves this device",
    `Relay: ${relay ? (verified ? `${relay} · allow-listed ${verified.hosts ?? "?"} hosts · verified ${agoText(verified.at)}` : `${relay} · never verified`) : "not configured"}`,
    `Providers: ${state.providers.length ? state.providers.map(x => `${x.name} [${providerStatus(x).label}]`).join(", ") : "none"}`,
    `API keys held here: ${keys.length ? keys.join(", ") : "none"}`,
    `History: ${chats} chat${chats === 1 ? "" : "s"}, ${msgs} message${msgs === 1 ? "" : "s"} · about ${(bytes / 1024).toFixed(0)} KB, in this browser only`,
    `Reasoning display: ${state.showThinking ? "on (uses extra tokens)" : "off"}`,
    `Network: ${navigator.onLine ? "online" : "offline"}`,
  ];
  return lines.join("\n");
}

function renderDiagnostics() {
  if (!els.diagOut) return;
  els.diagOut.textContent = diagnosticsText();
}

$("#diagRefreshBtn").addEventListener("click", () => { renderDiagnostics(); toast("Refreshed from your settings."); });
$("#diagCopyBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(diagnosticsText());
    toast("Diagnostics copied — no keys in it.");
  } catch {
    toast("Your browser would not let the page use the clipboard.");
  }
});

/* ---------- advanced sections ----------
   Open or shut is a preference, so it is remembered: an experienced user opens
   them once and every visit after that is the direct route. */
function setAdv(name, open) {
  const d = document.querySelector(`.adv[data-adv="${name}"]`);
  if (d) d.open = open;
}
document.querySelectorAll(".adv[data-adv]").forEach(d => {
  d.open = !!state.advanced[d.dataset.adv];
  d.addEventListener("toggle", () => {
    state.advanced[d.dataset.adv] = d.open;
    if (d.dataset.adv === "general") renderDiagnostics();
    save();
  });
});

/* ---------- share / export ----------
   This used to write "Link copied ✓" on a button that copied nothing, which is
   the worst kind of UI: a lie with good timing. One click now produces the chat
   itself — a Save dialog in the desktop app, the Markdown on the clipboard in a
   browser tab, where there is no dialog to open. */
els.shareBtn.addEventListener("click", () => {
  const conv = activeConv();
  const label = els.shareBtn.querySelector("span");
  if (!conv || !conv.messages.length) {
    label.textContent = "Start a chat first";
  } else {
    label.textContent = "Saving…";
    /* the reset waits for the answer, not the clock — in the desktop app a Save
       dialog can stay open far longer than any timeout would be sane */
    exportConversation(conv, "markdown")
      .then((done) => { label.textContent = done ? "Saved ✓" : "Nothing saved"; })
      .catch(() => { label.textContent = "Could not save"; })
      .finally(() => setTimeout(() => { label.textContent = "Share"; }, 1800));
  }
});

/* ---------- firebase google sign-in ---------- */
els.authStatus = $("#authStatus");
els.googleSignInBtn = $("#googleSignInBtn");
els.googleSignOutBtn = $("#googleSignOutBtn");

let fbAuth = null, fbMods = null, currentUser = null;

async function ensureAuth() {
  if (fbAuth) return { auth: fbAuth, mods: fbMods };
  const appMod = await import("https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js");
  const authMod = await import("https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js");
  const app = appMod.initializeApp(state.firebaseConfig);
  fbAuth = authMod.getAuth(app);
  fbMods = authMod;
  authMod.onAuthStateChanged(fbAuth, (u) => {
    currentUser = u;
    if (u?.displayName) {
      state.displayName = u.displayName;
      els.displayNameInput.value = u.displayName;
      save();
      setGreeting();
    }
    renderAuthUI();
    renderMessages();
  });
  return { auth: fbAuth, mods: authMod };
}

els.googleSignInBtn.addEventListener("click", async () => {
  els.googleSignInBtn.disabled = true;
  try {
    const { auth, mods } = await ensureAuth();
    await mods.signInWithPopup(auth, new mods.GoogleAuthProvider());
  } catch (err) {
    toast("Sign-in failed: " + String(err?.message || err).slice(0, 140));
  } finally {
    els.googleSignInBtn.disabled = false;
  }
});

els.googleSignOutBtn.addEventListener("click", async () => {
  if (fbAuth && fbMods) await fbMods.signOut(fbAuth);
});

function renderAuthUI() {
  els.googleSignInBtn.hidden = !!currentUser;
  els.googleSignOutBtn.hidden = !currentUser;
  els.amSignInBtn.hidden = !!currentUser;
  els.amSignOutBtn.hidden = !currentUser;
  els.amSwitchBtn.hidden = !currentUser;
  els.authStatus.textContent = currentUser
    ? `${currentUser.displayName || currentUser.email} — signed in with Google`
    : "Configured — click Sign in with Google";
  const label = els.signinBtn.querySelector("span");
  let photo = els.signinBtn.querySelector("img");

  els.amSub.textContent = currentUser
    ? (currentUser.email || "Signed in with Google")
    : "Not signed in";
  els.amName.textContent = currentUser
    ? (currentUser.displayName || currentUser.email || "Account")
    : (state.displayName || "Guest");
  els.amAvatar.innerHTML = "";
  if (currentUser?.photoURL) {
    const img = document.createElement("img");
    img.src = currentUser.photoURL;
    img.alt = "";
    els.amAvatar.append(img);
  } else {
    els.amAvatar.textContent = (currentUser?.displayName || state.displayName || "G").slice(0, 1).toUpperCase();
  }

  if (currentUser) {
    label.textContent = (currentUser.displayName || currentUser.email || "Account").split(" ")[0];
    els.signinBtn.classList.add("signed-in");
    if (currentUser.photoURL) {
      if (!photo) {
        photo = document.createElement("img");
        photo.className = "user-photo";
        photo.alt = "";
        els.signinBtn.prepend(photo);
      }
      photo.src = currentUser.photoURL;
    } else if (photo) photo.remove();
  } else {
    label.textContent = "Sign in";
    els.signinBtn.classList.remove("signed-in");
    if (photo) photo.remove();
  }
}

/* ---------- notifications ---------- */
els.notifToggle = $("#notifToggle");
els.soundToggle = $("#soundToggle");
els.notifStatus = $("#notifStatus");

function renderNotifUI() {
  els.notifToggle.checked = !!state.notifications.enabled;
  els.soundToggle.checked = !!state.notifications.sound;
  if (!("Notification" in window)) {
    els.notifStatus.textContent = "This browser has no notification support";
    els.notifToggle.disabled = true;
    return;
  }
  const perm = Notification.permission;
  els.notifStatus.textContent = perm === "granted" ? "Browser permission: allowed"
    : perm === "denied" ? "Browser permission: blocked — allow it in site settings"
    : "Browser permission: not requested";
  if (perm !== "granted") state.notifications.enabled = false;
  els.notifToggle.checked = !!state.notifications.enabled;
}

els.notifToggle.addEventListener("change", async () => {
  if (!("Notification" in window)) return;
  if (els.notifToggle.checked) {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      toast("Notifications are blocked in your browser settings.");
      renderNotifUI();
      return;
    }
  }
  state.notifications.enabled = els.notifToggle.checked;
  save();
  renderNotifUI();
  toast(state.notifications.enabled ? "You'll be notified when a reply finishes." : "Desktop notifications off.");
});

els.soundToggle.addEventListener("change", () => {
  state.notifications.sound = els.soundToggle.checked;
  save();
  if (els.soundToggle.checked) chime();
});

$("#notifTestBtn").addEventListener("click", async () => {
  if (!("Notification" in window)) return;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("Permission denied."); renderNotifUI(); return; }
  new Notification("Notal AI", { body: "Test notification — replies will appear like this." });
  state.notifications.enabled = true;
  save();
  renderNotifUI();
});

let audioCtx;
function chime() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [["G4", 392], ["C5", 523.25]].forEach(([_, f], i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = f;
      o.connect(g); g.connect(audioCtx.destination);
      const start = t + i * 0.12;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(0.07, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      o.start(start); o.stop(start + 0.4);
    });
  } catch { /* audio unavailable */ }
}

function notifyReply(text) {
  if (!state.notifications.enabled) return;
  if (DESKTOP) {
    /* Windows owns the notification centre here, and the main process can say
       whether the window is actually in front — document.hidden lies for an
       Electron window that is hidden to the tray but still "visible". */
    if (document.hasFocus()) return;
    window.notal.notify("Notal AI", (text || "").slice(0, 120) || "Reply ready");
    if (state.notifications.sound) chime();
    return;
  }
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (!document.hidden) return;
  new Notification("Notal AI", { body: text.slice(0, 120) || "Reply ready" });
  if (state.notifications.sound) chime();
}

/* ---------- security (local PIN lock) ---------- */
els.lockScreen = $("#lockScreen");
els.lockForm = $("#lockForm");
els.pinInput = $("#pinInput");
els.lockError = $("#lockError");
els.setPinBtn = $("#setPinBtn");
els.clearPinBtn = $("#clearPinBtn");
els.lockNowBtn = $("#lockNowBtn");
els.idleLockSel = $("#idleLockSel");
els.pinStatus = $("#pinStatus");
els.keyCount = $("#keyCount");

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function renderSecurityUI() {
  els.pinStatus.textContent = state.pinHash ? "PIN set — app locks on open" : "Not set";
  els.setPinBtn.textContent = state.pinHash ? "Change PIN" : "Set PIN";
  els.clearPinBtn.hidden = !state.pinHash;
  els.lockNowBtn.disabled = !state.pinHash;
  els.idleLockSel.value = String(state.idleLock);
  const withKeys = state.providers.filter(p => p.apiKey);
  els.keyCount.textContent = withKeys.length
    ? `${withKeys.length} provider key${withKeys.length > 1 ? "s" : ""} stored in this browser`
    : "No provider keys stored";
}

els.setPinBtn.addEventListener("click", async () => {
  if (state.pinHash) {
    const old = prompt("Enter your current PIN:");
    if (old === null) return;
    if (await sha256(old) !== state.pinHash) { toast("Wrong PIN."); return; }
  }
  const pin = prompt(state.pinHash ? "New PIN (4–8 digits):" : "Choose a PIN (4–8 digits):");
  if (pin === null) return;
  if (!/^\d{4,8}$/.test(pin.trim())) { toast("PIN must be 4–8 digits."); return; }
  state.pinHash = await sha256(pin.trim());
  save();
  renderSecurityUI();
  resetIdleTimer();
  toast("PIN saved. It unlocks this app only.");
});

els.clearPinBtn.addEventListener("click", async () => {
  const old = prompt("Enter your current PIN to remove it:");
  if (old === null) return;
  if (await sha256(old) !== state.pinHash) { toast("Wrong PIN."); return; }
  state.pinHash = null;
  state.idleLock = 0;
  save();
  renderSecurityUI();
  resetIdleTimer();
  toast("PIN removed.");
});

els.idleLockSel.addEventListener("change", () => {
  state.idleLock = Number(els.idleLockSel.value) || 0;
  save();
  resetIdleTimer();
});

$("#clearKeysBtn").addEventListener("click", () => {
  const withKeys = state.providers.filter(p => p.apiKey);
  if (!withKeys.length) { toast("No keys to clear."); return; }
  if (!confirm(`Remove the saved API key from ${withKeys.length} provider(s)? The models stay, you'd just re-enter keys later.`)) return;
  for (const p of state.providers) p.apiKey = "";
  save();
  renderProviders();
  renderSecurityUI();
  toast("All API keys cleared.");
});

function lockApp() {
  if (!state.pinHash) return;
  els.lockScreen.hidden = false;
  els.pinInput.value = "";
  els.lockError.hidden = true;
  setTimeout(() => els.pinInput.focus(), 30);
}

els.lockForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const ok = await sha256(els.pinInput.value.trim()) === state.pinHash;
  if (ok) {
    els.lockScreen.hidden = true;
    resetIdleTimer();
  } else {
    els.lockError.hidden = false;
    els.pinInput.select();
  }
});

let idleTimer;
function resetIdleTimer() {
  clearTimeout(idleTimer);
  if (!state.idleLock || !state.pinHash || !els.lockScreen.hidden) return;
  idleTimer = setTimeout(lockApp, state.idleLock * 1000);
}
["pointerdown", "keydown", "pointermove"].forEach(ev =>
  window.addEventListener(ev, () => resetIdleTimer(), { passive: true }));

/* ---------- keyboard shortcuts ---------- */
function shortcutOpenSettings() {
  lockScreenSafe(() => openSettings());
}
function lockScreenSafe(fn) { if (!els.lockScreen.hidden) return; fn(); }

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!els.lockScreen.hidden) return;
    setModelMenu(false);
    setAccountMenu(false);
    if (!els.overlay.hidden) closeSettings();
    else if (!nameDialog.hidden) { closeNameDialog(); discardEditorMode(); }
    else if (!makerPick.hidden) makerPick.hidden = true;
    else if (editing) exitEditorMode();
    else if (panelOpen || els.main.classList.contains("ext-open")) setView("chats");
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "k") { e.preventDefault(); lockScreenSafe(newConversation); }
  else if (k === "i") { e.preventDefault(); lockScreenSafe(() => els.input.focus()); }
  else if (k === "b") { e.preventDefault(); lockScreenSafe(() => els.sidebarClose.click()); }
  else if (k === ",") { e.preventDefault(); shortcutOpenSettings(); }
  else if (k === "l" && e.shiftKey) { e.preventDefault(); lockApp(); }
  else if (k === "f" && e.shiftKey) { e.preventDefault(); lockScreenSafe(() => els.search.focus()); }
});

/* ---------- projects / memory / skills panels ----------
   These three open on top of the chat instead of swapping it out, so the chat
   stays the main event and whatever you were typing is still there when the
   panel closes. The sidebar nav is the quick access to each one.
   Extensions is different: it takes over the main column as its own view. */
els.chatTitle = $(".chat-title");
els.main = $(".main");
els.extView = $("#extView");
const PANELS = ["projects", "memory", "skills"];
let panelOpen = null;

function renderPanel(name) {
  if (name === "projects") renderProjects();
  else if (name === "memory") renderMemory();
  else renderSkills();
}

/* hidden synchronously: an overlay that fades out but never finishes would
   sit invisible on top of the chat and swallow every click */
function closePanel(name) {
  $(`#view-${name}`).hidden = true;
}

function openPanel(name) {
  const overlay = $(`#view-${name}`);
  overlay.hidden = false;
  renderPanel(name);
  motion.reveal(overlay.querySelector(".panel-modal"));
}

function setView(name) {
  const panel = PANELS.includes(name) ? name : null;
  const ext = name === "extensions";
  if (panel !== panelOpen) {
    if (panelOpen) closePanel(panelOpen);
    panelOpen = panel;
    if (panel) openPanel(panel);
  } else if (panel) {
    renderPanel(panel);
  }
  const wasExt = els.main.classList.contains("ext-open");
  els.main.classList.toggle("ext-open", ext);
  /* the view stays in the DOM, so it only needs filling and animating on the
     way in — Chats and Esc just hide it again */
  if (ext && !wasExt) {
    renderExtensions();
    motion.reveal(els.extView);
  }
  document.querySelectorAll(".nav-item").forEach(b =>
    b.classList.toggle("active", b.dataset.view === (panel ?? (ext ? "extensions" : "chats"))));
  els.chatTitle.textContent = ext ? "Extensions"
    : activeConv()?.title
    || (state.activeProject ? projectName(state.activeProject) : "Notal AI");
}

for (const p of PANELS) {
  $(`#view-${p}`).addEventListener("click", (e) => {
    if (e.target === $(`#view-${p}`)) setView("chats");
  });
}
document.querySelectorAll("[data-panel-close]").forEach(b =>
  b.addEventListener("click", () => setView("chats")));

function projectName(id) {
  return state.projects.find(p => p.id === id)?.name || "Notal AI";
}

/* ----- projects ----- */
els.projectGrid = $("#projectGrid");

function projectChats(id) {
  return state.conversations.filter(c => (c.projectId ?? null) === id);
}
function projectMemos(id) {
  return state.memories.filter(m => m.projectId === id);
}

function renderProjects() {
  els.projectGrid.innerHTML = "";
  if (!state.projects.length) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.textContent = "No projects yet — create one above to group chats and memory.";
    els.projectGrid.append(li);
    return;
  }
  for (const p of state.projects) {
    const li = document.createElement("li");
    li.className = "card" + (p.id === state.activeProject ? " active" : "");

    const h = document.createElement("h3");
    h.textContent = p.name;
    const meta = document.createElement("small");
    meta.textContent = `${projectChats(p.id).length} chats · ${projectMemos(p.id).length} memories`;

    const open = document.createElement("button");
    open.type = "button"; open.className = "ghost-btn";
    open.textContent = p.id === state.activeProject ? "Active" : "Open";
    open.addEventListener("click", () => {
      state.activeProject = p.id;
      save();
      renderProjects();
      renderMemory();
      setView("chats");
      renderHistory(els.search.value);
      renderMessages();
      toast(`Now working in "${p.name}" — new chats belong to it.`);
    });

    const mem = document.createElement("button");
    mem.type = "button"; mem.className = "ghost-btn";
    mem.textContent = "Memory";
    mem.addEventListener("click", () => {
      state.activeProject = p.id;
      save();
      setView("memory");
      renderMemory();
    });

    const del = document.createElement("button");
    del.type = "button"; del.className = "icon-btn pi-del";
    del.setAttribute("aria-label", `Delete ${p.name}`);
    del.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
    del.addEventListener("click", () => {
      if (!confirm(`Delete "${p.name}"? Its chats stay but return to no project.`)) return;
      state.projects = state.projects.filter(x => x.id !== p.id);
      for (const c of state.conversations)
        if (c.projectId === p.id) c.projectId = null;
      for (const m of state.memories)
        if (m.projectId === p.id) m.projectId = null;
      if (state.activeProject === p.id) state.activeProject = null;
      save();
      renderProjects();
      renderHistory(els.search.value);
    });

    li.append(h, meta, open, mem, del);
    els.projectGrid.append(li);
  }
}

$("#projectForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#projNameInput").value.trim();
  if (!name) return;
  state.projects.push({ id: crypto.randomUUID(), name, createdAt: Date.now() });
  $("#projNameInput").value = "";
  save();
  renderProjects();
  renderMemory();
});

/* ----- memory ----- */
els.memoryList = $("#memoryList");
els.memProjectSel = $("#memProjectSel");

function renderMemory() {
  els.memProjectSel.innerHTML = "";
  const general = document.createElement("option");
  general.value = ""; general.textContent = "General (all chats)";
  els.memProjectSel.append(general);
  for (const p of state.projects) {
    const o = document.createElement("option");
    o.value = p.id; o.textContent = p.name;
    els.memProjectSel.append(o);
  }
  if (state.activeProject && state.projects.some(p => p.id === state.activeProject))
    els.memProjectSel.value = state.activeProject;

  els.memoryList.innerHTML = "";
  if (!state.memories.length) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.textContent = "Nothing remembered yet. Add a fact above — it goes into the prompt for every real model call.";
    els.memoryList.append(li);
    return;
  }
  for (const m of state.memories) {
    const li = document.createElement("li");
    li.className = "mem-item" + (m.enabled ? "" : " off");

    const label = document.createElement("label");
    label.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = m.enabled;
    cb.addEventListener("change", () => {
      m.enabled = cb.checked;
      save();
      renderMemory();
    });
    const sl = document.createElement("span");
    sl.className = "sl track";
    label.append(cb, sl);

    const body = document.createElement("div");
    body.className = "mem-body";
    const text = document.createElement("span");
    text.textContent = m.text;
    const scope = document.createElement("small");
    scope.textContent = m.projectId ? projectName(m.projectId) : "General";
    body.append(text, document.createElement("br"), scope);

    const del = document.createElement("button");
    del.type = "button"; del.className = "icon-btn pi-del";
    del.setAttribute("aria-label", "Forget this");
    del.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
    del.addEventListener("click", () => {
      state.memories = state.memories.filter(x => x.id !== m.id);
      save();
      renderMemory();
      toast("Forgotten.");
    });

    li.append(label, body, del);
    els.memoryList.append(li);
  }
}

$("#memoryForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#memInput").value.trim();
  if (!text) return;
  state.memories.unshift({
    id: crypto.randomUUID(), text,
    projectId: els.memProjectSel.value || null,
    enabled: true, createdAt: Date.now(),
  });
  $("#memInput").value = "";
  save();
  renderMemory();
  toast("Saved to memory.");
});

/* ----- skills ----- */
els.skillGrid = $("#skillGrid");

function renderSkills() {
  els.skillGrid.innerHTML = "";
  if (!state.skills.length) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.textContent = "No skills yet — add a reusable prompt above.";
    els.skillGrid.append(li);
    return;
  }
  for (const s of state.skills) {
    const li = document.createElement("li");
    li.className = "card";
    const h = document.createElement("h3");
    h.textContent = s.name;
    const p = document.createElement("p");
    p.className = "card-desc";
    p.textContent = s.prompt;

    const use = document.createElement("button");
    use.type = "button"; use.className = "ghost-btn";
    use.textContent = "Use";
    use.addEventListener("click", () => {
      setView("chats");
      els.input.value = s.prompt;
      autoresize();
      sendMessage(s.prompt);
    });

    const edit = document.createElement("button");
    edit.type = "button"; edit.className = "ghost-btn";
    edit.textContent = "Insert";
    edit.title = "Put the prompt in the message box without sending";
    edit.addEventListener("click", () => {
      setView("chats");
      els.input.value = s.prompt;
      autoresize();
      els.input.focus();
      els.input.setSelectionRange(els.input.value.length, els.input.value.length);
    });

    const del = document.createElement("button");
    del.type = "button"; del.className = "icon-btn pi-del";
    del.setAttribute("aria-label", `Delete ${s.name}`);
    del.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
    del.addEventListener("click", () => {
      state.skills = state.skills.filter(x => x.id !== s.id);
      save();
      renderSkills();
    });

    li.append(h, p, use, edit, del);
    els.skillGrid.append(li);
  }
}

$("#skillForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#skillNameInput").value.trim();
  const prompt = $("#skillPromptInput").value.trim();
  if (!name || !prompt) return;
  state.skills.push({ id: crypto.randomUUID(), name, prompt });
  $("#skillNameInput").value = "";
  $("#skillPromptInput").value = "";
  save();
  renderSkills();
  toast(`Skill "${name}" added.`);
});

/* ----- extensions ----- */
els.extBuiltinList = $("#extBuiltinList");
els.extCustomList = $("#extCustomList");
els.extLibraryList = $("#extLibraryList");
els.libStatus = $("#libStatus");

/* The real library is a Supabase table read over REST — GET only, the anon
   key needs no write policy. Until one is connected, the curated seed shows. */
let libResult = null; // { entries, source, count? } — filled by loadLibrary()

async function loadLibrary() {
  try {
    /* `claim` is deliberately not selected: the read is open to anyone, and a
       row stays writable only by whoever still holds its secret. */
    const res = await fetch(
      `${LIB_URL}/rest/v1/extensions?select=id,name,descr,prompt,ui,created_at,creator,screenshot&order=created_at.desc`,
      { headers: { apikey: LIB_KEY, Authorization: `Bearer ${LIB_KEY}` } },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    const live = new Set(rows.map(r => r.id));
    /* a row removed elsewhere must not keep costing one of your ten slots */
    let pruned = false;
    for (const id of Object.keys(state.claims)) {
      if (!live.has(id)) { delete state.claims[id]; pruned = true; }
    }
    if (pruned) save();
    return {
      source: "supabase", count: rows.length, mine: Object.keys(state.claims).length,
      entries: rows.map(r => ({
        libId: `db:${r.id}`,
        rowId: r.id,
        name: r.name, desc: r.descr || "", prompt: r.prompt || "", ui: r.ui || null,
        creator: r.creator || "", screenshot: r.screenshot || "",
        mine: !!state.claims[r.id],
      })),
    };
  } catch (err) {
    console.warn("Extension library unreachable:", err);
    return { entries: EXT_LIBRARY_SEED, source: "offline" };
  }
}

function renderLibrary() {
  els.extLibraryList.innerHTML = "";
  if (!libResult) {
    els.libStatus.textContent = "Loading the library…";
    loadLibrary().then(r => { libResult = r; renderLibrary(); });
    return;
  }
  els.libStatus.textContent = libResult.source === "supabase"
    ? libResult.count
      ? `${libResult.count} ${libResult.count === 1 ? "entry" : "entries"} in the library — ${myPublications()} of ${LIB_LIMIT} yours.`
      : "Connected to the library — it is empty. Publish something from Extension Maker."
    : "Could not reach the library — showing the built-in demo set.";
  const installed = new Set(state.extensions.map(x => x.libId).filter(Boolean));
  for (const e of libResult.entries) {
    const li = document.createElement("li");
    li.className = "lib-card";

    li.append(extPreview(e.ui, e.screenshot));

    const h = document.createElement("strong");
    h.className = "lib-name";
    h.textContent = e.name;
    if (e.ui && (e.ui.css || e.ui.html || e.ui.js)) {
      const badge = document.createElement("span");
      badge.className = "ext-badge";
      badge.textContent = "UI";
      h.append(" ", badge);
    }
    li.append(h);

    const p = document.createElement("small");
    p.className = "lib-desc";
    p.textContent = e.desc
      || (e.ui && (e.ui.css || e.ui.html || e.ui.js) ? "A UI extension." : "A prompt add-on.");
    li.append(p);

    if (e.creator || e.mine) {
      const by = document.createElement("small");
      by.className = "lib-by";
      by.textContent = e.creator ? `by ${e.creator}` : "by you";
      li.append(by);
    }

    const foot = document.createElement("div");
    foot.className = "lib-foot";

    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "ghost-btn";
    if (installed.has(e.libId)) {
      btn.textContent = "Installed"; btn.disabled = true;
    } else {
      btn.textContent = "Install";
      btn.addEventListener("click", () => {
        state.extensions.push({
          id: crypto.randomUUID(), libId: e.libId, name: e.name,
          desc: p.textContent, prompt: e.prompt || "",
          ui: e.ui || undefined, builtin: false, enabled: false,
        });
        save();
        renderExtensions();
        toast(`"${e.name}" installed — switch it on above.`);
      });
    }
    foot.append(btn);

    /* only the install that holds a row's secret offers to change it, and the
       code editor is the door for UI rows — a feature has no UI to edit */
    if (e.mine && e.ui) {
      const edit = document.createElement("button");
      edit.type = "button"; edit.className = "ghost-btn";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => editLibraryEntry(e));
      foot.append(edit);
    }
    if (e.mine) {
      const del = document.createElement("button");
      del.type = "button"; del.className = "ghost-btn danger";
      del.textContent = "Delete";
      del.addEventListener("click", () => deleteLibraryRow(e));
      foot.append(del);
    }

    li.append(foot);
    els.extLibraryList.append(li);
  }
}

/* Editing something you already published opens your installed copy of it and
   remembers the row, so the next Publish updates that row instead of shipping
   a second entry under the same name. */
function editLibraryEntry(e) {
  let x = state.extensions.find(y => y.libId === e.libId);
  if (!x) {
    x = {
      id: crypto.randomUUID(), libId: e.libId, name: e.name, desc: e.desc,
      prompt: e.prompt || "", ui: e.ui || undefined, builtin: false, enabled: false,
    };
    state.extensions.push(x);
  }
  x.pubId = e.rowId;
  x.screenshot = e.screenshot || "";
  save();
  openExtEditor(x);
}

/* Switched-on UI extensions write into one style tag and one mount point, so
   turning any of them off takes its share back on the next apply. Scripts run
   once per apply and are expected to be idempotent — check before you build,
   as the built-in clock does. */
function applyUiExtensions() {
  const on = state.extensions.filter(x => x.enabled && x.ui);
  let style = document.getElementById("extStyles");
  if (!style) {
    style = document.createElement("style");
    style.id = "extStyles";
    document.head.append(style);
  }
  style.textContent = on.map(x => `/* ${x.name} */\n${x.ui.css || ""}`).join("\n");
  const mount = document.getElementById("extMount");
  mount.textContent = "";
  for (const x of on) {
    if (!x.ui.html) continue;
    const holder = document.createElement("div");
    holder.innerHTML = x.ui.html;
    mount.append(...holder.childNodes);
  }
  for (const x of on) {
    if (!x.ui.js) continue;
    try { new Function(x.ui.js)(); }
    catch (err) { console.warn(`Extension "${x.name}" script failed:`, err); }
  }
}

/* Which theme cards have their "Make a theme" button showing — a view state,
   so it is deliberately not saved with the extension. */
const makeThemeOpen = new Set();

function extRow(x, deletable) {
  const li = document.createElement("li");
  li.className = "lib-card" + (x.enabled ? "" : " off");

  const shot = extPreview(x.ui, x.screenshot);
  li.append(shot);

  const h = document.createElement("strong");
  h.className = "lib-name";
  h.textContent = x.name;
  if (x.ui && !x.themeMaker) {
    const badge = document.createElement("span");
    badge.className = "ext-badge";
    badge.textContent = "UI";
    h.append(" ", badge);
  }
  li.append(h);

  const p = document.createElement("small");
  p.className = "lib-desc";
  p.textContent = x.desc || (x.ui ? "A UI extension." : "A prompt add-on.");
  li.append(p);

  /* the theme maker is entered from its own card: click the picture and the way
     in appears underneath the description */
  if (x.themeMaker) {
    shot.classList.add("is-button");
    shot.title = "Make a theme";
    shot.tabIndex = 0;
    const toggle = () => {
      if (makeThemeOpen.has(x.id)) makeThemeOpen.delete(x.id);
      else makeThemeOpen.add(x.id);
      renderExtensions();
    };
    shot.addEventListener("click", toggle);
    shot.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
    if (makeThemeOpen.has(x.id)) {
      const make = document.createElement("button");
      make.type = "button";
      make.className = "ghost-btn ext-make-theme";
      make.textContent = "Make a theme";
      make.addEventListener("click", startThemeMode);
      li.append(make);
    }
  }

  const foot = document.createElement("div");
  foot.className = "lib-foot";

  const label = document.createElement("label");
  label.className = "switch";
  const cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = x.enabled;
  cb.setAttribute("aria-label", `${x.enabled ? "Turn off" : "Turn on"} ${x.name}`);
  cb.addEventListener("change", () => {
    x.enabled = cb.checked;
    save();
    applyUiExtensions();
    renderExtensions();
    toast(x.enabled ? `"${x.name}" is on.` : `"${x.name}" turned off.`);
  });
  const sl = document.createElement("span");
  sl.className = "sl track";
  label.append(cb, sl);
  foot.append(label);

  if (x.ui) {
    const edit = document.createElement("button");
    edit.type = "button"; edit.className = "ghost-btn";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openExtEditor(x));
    foot.append(edit);
  }

  /* publishing is a decision you take about something that already exists, so
     the door to the library sits on the card rather than on the create form */
  if (!x.builtin) {
    const pub = document.createElement("button");
    pub.type = "button"; pub.className = "ghost-btn";
    pub.textContent = x.pubId ? "Update" : "Publish";
    pub.addEventListener("click", () => openPublishDialog(x));
    foot.append(pub);
  }

  if (deletable) {
    const del = document.createElement("button");
    del.type = "button"; del.className = "icon-btn pi-del";
    del.setAttribute("aria-label", `Delete ${x.name}`);
    del.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
    del.addEventListener("click", () => {
      state.extensions = state.extensions.filter(y => y.id !== x.id);
      save();
      applyUiExtensions();
      renderExtensions();
    });
    foot.append(del);
  }

  li.append(foot);
  return li;
}

function renderExtensions() {
  renderLibrary();
  els.extBuiltinList.innerHTML = "";
  els.extCustomList.innerHTML = "";
  for (const x of state.extensions.filter(y => y.builtin))
    els.extBuiltinList.append(extRow(x, false));
  const custom = state.extensions.filter(y => !y.builtin);
  if (!custom.length) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.textContent = "Nothing of your own yet — press Extension Maker above.";
    els.extCustomList.append(li);
  }
  for (const x of custom) els.extCustomList.append(extRow(x, true));
}

/* ----- the UI-extension editor ----- */
const edBuffers = { css: "", html: "", js: "" };
let edLang = "css";
let edTarget = null; // the extension being edited, null while composing a new one

function edHighlight() {
  $("#edHl").replaceChildren(...syntaxNodes(edBuffers[edLang] + "\n", edLang));
}

function edShow(lang) {
  /* the input listener keeps edBuffers current, so switching tabs only reads
     the new pane back out — never write the old textarea into the target */
  edLang = lang;
  document.querySelectorAll(".ed-tab").forEach(t => {
    const active = t.dataset.ed === lang;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
  });
  $("#edInput").value = edBuffers[lang];
  $("#edHint").textContent = ED_HINTS[lang];
  edHighlight();
  $("#edInput").scrollTop = $("#edHl").scrollTop = 0;
}

function openExtEditor(x) {
  edTarget = x || null;
  $("#extEditorTitle").textContent = x ? `Edit — ${x.name}` : "New UI extension";
  $("#edName").value = x?.name || "";
  $("#edDesc").value = x?.desc || "";
  edBuffers.css = x?.ui?.css || "";
  edBuffers.html = x?.ui?.html || "";
  edBuffers.js = x?.ui?.js || "";
  edApplySize();
  edShow("css");
  $("#extEditor").hidden = false;
  $("#edInput").focus();
}

function closeExtEditor() { $("#extEditor").hidden = true; }

$("#extEditorClose").addEventListener("click", closeExtEditor);
$("#extEditor").addEventListener("click", (e) => { if (e.target === $("#extEditor")) closeExtEditor(); });
document.querySelectorAll(".ed-tab").forEach(t =>
  t.addEventListener("click", () => edShow(t.dataset.ed)));
$("#edInput").addEventListener("input", () => { edBuffers[edLang] = $("#edInput").value; edHighlight(); });
$("#edInput").addEventListener("scroll", () => { $("#edHl").scrollTop = $("#edInput").scrollTop; $("#edHl").scrollLeft = $("#edInput").scrollLeft; });

/* Tab inside a code box should indent, not throw the caret out of the editor. */
$("#edInput").addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const el = e.target;
  el.setRangeText("  ", el.selectionStart, el.selectionEnd, "end");
  edBuffers[edLang] = el.value;
  edHighlight();
});

/* Working examples, so the first thing a new user reads is code that runs.
   A starter only fills the panes it ships with — it never erases what you
   have already written in another language. */
const ED_STARTERS = {
  theme: {
    name: "Night colours", desc: "A dark, blue-tinted take on the page.",
    css: `/* Your CSS loads after the theme, so these win.
   Change a colour and press Save to see it land. */
:root {
  --bg: #101418;
  --surface: #171d23;
  --text: #e8ecf0;
  --accent: #58a6ff;
}`,
  },
  type: {
    name: "Comfy reading", desc: "Larger type and a wider chat column.",
    css: `/* :root font-size scales the whole interface. */
:root { font-size: 18px; }
.chat { max-width: 860px; margin: 0 auto; width: 100%; }`,
  },
  clock: {
    name: "Corner clock", desc: "A live clock pinned to the bottom right.",
    html: `<!-- HTML adds this to the page. CSS dresses it, JS fills it. -->
<div id="extClock"></div>`,
    css: `#extClock {
  position: fixed; right: 18px; bottom: 16px; z-index: 60;
  padding: 7px 13px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface);
  font: 600 13px/1 var(--sans); color: var(--text-soft);
}`,
    js: `// JS runs every time the switch goes on, so this clears
// its own old timer before starting a new one.
clearInterval(window.__extClockTimer);
function extClockTick() {
  const el = document.getElementById("extClock");
  if (el) el.textContent = new Date().toLocaleTimeString();
}
extClockTick();
window.__extClockTimer = setInterval(extClockTick, 1000);`,
  },
  blank: { name: "", desc: "" },
};

const ED_HINTS = {
  css: "CSS changes how the page looks. Anything you write here loads last, so it wins over the built-in theme.",
  html: "HTML is added to the page on top of everything else. Give your element an id here, then style it in the CSS tab.",
  js: "JavaScript runs each time the extension is switched on, and can read or change anything on the page. It should not add the same thing twice.",
};

function edApplyStarter(key) {
  const s = ED_STARTERS[key];
  if (!s) return;
  if (key === "blank") edBuffers.css = edBuffers.html = edBuffers.js = "";
  else for (const lang of ["css", "html", "js"]) if (s[lang]) edBuffers[lang] = s[lang];
  if (s.name && !$("#edName").value.trim()) $("#edName").value = s.name;
  if (s.desc && !$("#edDesc").value.trim()) $("#edDesc").value = s.desc;
  edShow(s.html ? "html" : "css");
  $("#edInput").focus();
}

document.querySelectorAll("[data-starter]").forEach(b =>
  b.addEventListener("click", () => edApplyStarter(b.dataset.starter)));

/* ----- resizing the editor -----
   Three grips: the right edge, the bottom edge, and the corner. The size you
   drag to is remembered, because a code editor you have to re-open at arm's
   length every session is a bad one. */
const ED_MIN = { w: 520, h: 340 };
const edModal = $("#extEditor .ext-editor");

function edApplySize() {
  const s = state.advanced.edSize;
  if (s && Number.isFinite(s.w) && Number.isFinite(s.h)) {
    edModal.style.width = s.w + "px";
    edModal.style.height = s.h + "px";
  } else {
    edModal.style.width = edModal.style.height = "";
  }
}

let edDrag = null;
for (const grip of document.querySelectorAll(".ed-grip")) {
  grip.addEventListener("pointerdown", (e) => {
    const r = edModal.getBoundingClientRect();
    edDrag = { axes: grip.dataset.grip, x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("on");
    e.preventDefault();
  });
  grip.addEventListener("pointermove", (e) => {
    if (!edDrag) return;
    const maxW = innerWidth - 40, maxH = innerHeight - 40;
    if (edDrag.axes !== "s")
      edModal.style.width = Math.min(maxW, Math.max(ED_MIN.w, edDrag.w + e.clientX - edDrag.x)) + "px";
    if (edDrag.axes !== "e")
      edModal.style.height = Math.min(maxH, Math.max(ED_MIN.h, edDrag.h + e.clientY - edDrag.y)) + "px";
  });
  const end = (e) => {
    if (!edDrag) return;
    edDrag = null;
    grip.classList.remove("on");
    if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    const r = edModal.getBoundingClientRect();
    state.advanced.edSize = { w: Math.round(r.width), h: Math.round(r.height) };
    save();
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  grip.addEventListener("dblclick", () => {
    state.advanced.edSize = null;
    save();
    edApplySize();
  });
}

function edCollect() {
  edBuffers[edLang] = $("#edInput").value;
  return {
    name: $("#edName").value.trim() || "Untitled extension",
    desc: $("#edDesc").value.trim() || "Your own UI extension.",
    ui: { css: edBuffers.css, html: edBuffers.html, js: edBuffers.js },
  };
}

$("#edSave").addEventListener("click", () => {
  const { name, desc, ui } = edCollect();
  if (edTarget) {
    Object.assign(edTarget, { name, desc, ui });
  } else {
    state.extensions.push({ id: crypto.randomUUID(), name, desc, prompt: "", builtin: false, enabled: true, ui });
  }
  save();
  applyUiExtensions();
  renderExtensions();
  closeExtEditor();
  toast(`"${name}" saved.`);
});

$("#edDownload").addEventListener("click", () => {
  const { name, desc, ui } = edCollect();
  const blob = new Blob(
    [JSON.stringify({ kind: "notal-ui-extension", name, desc, ui }, null, 2)],
    { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".notal-extension.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

/* A maker's identity is one secret per browser, written into every row this
   browser publishes and never read back through the open select. Updates and
   deletions hand it to Postgres again, and the guarded functions refuse any
   call that does not match — so "only the maker can change it", and "ten
   extensions to a name", are rules in the database rather than buttons we
   chose to hide. Losing this browser's storage means losing the right to
   change what you published; that is the trade for the rule meaning something. */
const LIB_LIMIT = 10;

async function libraryRpc(call, args) {
  const res = await fetch(`${LIB_URL}/rest/v1/rpc/${call}`, {
    method: "POST",
    headers: {
      apikey: LIB_KEY,
      Authorization: `Bearer ${LIB_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403)
      throw new Error("this key is not allowed to write to the library");
    const m = /"message"\s*:\s*"([^"]+)"/.exec(detail) || /ERROR:\s+(.+)/.exec(detail);
    throw new Error(m ? m[1].trim() : `HTTP ${res.status}`);
  }
  return res.text();
}

function myPublications() {
  return Object.keys(state.claims).length;
}

/* One uuid, minted the first time this browser publishes and reused for every
   row after it, so the database counts a maker rather than a row when it holds
   them to ten. */
function makerSecret() {
  if (!state.makerSecret) { state.makerSecret = crypto.randomUUID(); save(); }
  return state.makerSecret;
}

/* The creator on a card is the account, never a field someone types: two
   browsers signed in as the same person publish as the same name. */
function makerName() {
  return currentUser?.displayName || currentUser?.email || "";
}

let publishing = false;
async function publishToLibrary(d, onDone) {
  if (publishing) return;
  const creator = makerName();
  if (!creator) {
    toast("Publishing puts your Google account name on the card — sign in first.");
    return;
  }
  const updating = !!d.rowId;
  if (updating && !state.claims[d.rowId]) {
    toast("Only the maker can change that one — it was published from another browser.");
    return;
  }
  if (!updating && myPublications() >= LIB_LIMIT) {
    toast(`Ten published extensions is the limit for one maker — withdraw one first.`);
    return;
  }
  const rowId = updating ? d.rowId : crypto.randomUUID();
  const secret = makerSecret();
  publishing = true;
  document.querySelectorAll("#pubGo").forEach(b => { b.disabled = true; });
  try {
    await libraryRpc(updating ? "revise_extension" : "publish_extension", {
      which_row: rowId,
      ext_name: d.name,
      ext_descr: d.desc,
      ext_prompt: d.prompt || "",
      ext_ui: d.ui || null,
      ext_creator: creator,
      ext_shot: d.screenshot || "",
      the_secret: secret,
    });
    state.claims[rowId] = true;
    save();
    libResult = null; // the next library read shows the new row
    renderExtensions();
    onDone?.(rowId);
    toast(updating
      ? `"${d.name}" updated in the library.`
      : `"${d.name}" is published — ${myPublications()} of ${LIB_LIMIT}.`);
  } catch (err) {
    console.warn("Publish failed:", err);
    toast(`Could not publish — ${err.message}`);
  } finally {
    publishing = false;
    document.querySelectorAll("#pubGo").forEach(b => { b.disabled = false; });
  }
}

async function deleteLibraryRow(entry) {
  if (!state.claims[entry.rowId]) {
    toast("Only the maker can withdraw that one.");
    return;
  }
  if (!confirm(`Remove "${entry.name}" from the library? Anyone who already installed it keeps their copy.`)) return;
  try {
    await libraryRpc("withdraw_extension", { which_row: entry.rowId, the_secret: makerSecret() });
    delete state.claims[entry.rowId];
    save();
    libResult = null;
    renderExtensions();
    toast(`"${entry.name}" is out of the library.`);
  } catch (err) {
    console.warn("Withdraw failed:", err);
    toast(`Could not withdraw — ${err.message}`);
  }
}

/* ---------- publishing, from a card you already made ----------
   Creating an extension and sending it to the library are two decisions, so
   they are two dialogs: this one carries only the card's photo, and the name it
   cannot change because it comes from the account. */
let pubTarget = null;
let pubShot = "";

function pubShotNote() {
  $("#pubShotNote").textContent = pubShot
    ? "Using your image. Clear the field to go back to the live preview."
    : SHOT_NOTE;
}

function pubPreview() {
  $("#pubPreview").replaceChildren(extPreview(pubTarget?.ui || null, pubShot));
}

function openPublishDialog(x) {
  pubTarget = x;
  pubShot = x.screenshot || "";
  $("#pubShot").value = "";
  $("#pubTitle").textContent = x.pubId ? `Update “${x.name}”` : `Publish “${x.name}”`;
  $("#pubSub").textContent = x.pubId
    ? "The library already carries this one, so publishing replaces it."
    : "Anyone who opens the library will find it in their list.";
  $("#pubAs").textContent = makerName()
    ? `The card will read “by ${makerName()}”.`
    : "Sign in with Google first — the card carries your account name, and nothing else can.";
  pubShotNote();
  pubPreview();
  $("#extPublishDialog").hidden = false;
  motion.reveal($("#extPublishDialog").querySelector(".modal"));
}

$("#pubShot").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) { pubShot = ""; pubShotNote(); pubPreview(); return; }
  try {
    pubShot = await shotFromFile(file);
    pubShotNote();
    pubPreview();
  } catch (err) {
    console.warn("Card photo rejected:", err);
    toast("That image could not be read — try a PNG or JPG.");
  }
});

function closePublishDialog() { $("#extPublishDialog").hidden = true; pubTarget = null; }
$("#pubClose").addEventListener("click", closePublishDialog);
$("#pubCancel").addEventListener("click", closePublishDialog);
$("#extPublishDialog").addEventListener("click", e => {
  if (e.target === $("#extPublishDialog")) closePublishDialog();
});

$("#pubGo").addEventListener("click", () => {
  const x = pubTarget;
  if (!x) return;
  publishToLibrary({
    name: x.name, desc: x.desc, prompt: x.prompt || "", ui: x.ui || null,
    rowId: x.pubId, screenshot: pubShot,
  }, (rowId) => {
    x.pubId = rowId;
    x.libId = `db:${rowId}`;
    x.screenshot = pubShot;
    save();
    closePublishDialog();
  });
});

/* ----- the extension preview -----
   A library card is a real rendering of the extension rather than a stored
   image: a small mock of the page carrying the same class names as the app,
   with the extension's own CSS, HTML and JS applied inside a sandboxed frame.
   Nothing to upload, and it can never drift from what the extension does. */
const SHOT_BASE = `
:root{--bg:#f5f1ea;--surface:#fffdfa;--surface-2:#efe9df;--text:#1f1e1d;--text-soft:#5c5750;
  --text-faint:#8b847b;--border:#e0d8cb;--accent:#d97757;--accent-soft:#f6dccd;
  --radius:14px;--radius-sm:9px;--serif:Georgia,serif;--sans:system-ui,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{width:640px;height:400px;overflow:hidden;background:var(--bg);color:var(--text);
  font:13px/1.55 var(--sans)}
.page{display:flex;height:400px}
.sidebar{width:168px;flex:none;padding:16px 14px;background:var(--surface-2);
  border-right:1px solid var(--border)}
.nav-item{display:block;height:30px;border-radius:9px;background:rgba(31,30,29,.07);margin-bottom:10px}
.nav-item.on{background:var(--accent)}
.main{flex:1;min-width:0;display:flex;flex-direction:column;padding:16px 20px}
.topbar{margin-bottom:18px;font-family:var(--serif);font-size:15px;font-weight:600}
.chat{flex:1}
.greeting{margin-bottom:14px;font-family:var(--serif);font-size:24px}
.msg{max-width:76%;margin-bottom:10px;padding:10px 14px;border-radius:13px;
  border:1px solid var(--border);background:var(--surface);font-size:12.5px;color:var(--text-soft)}
.msg.me{margin-left:auto;border-color:var(--text);background:var(--text);color:var(--bg)}
.composer{margin-top:14px;padding:12px 14px;border-radius:14px;border:1px solid var(--border);
  background:var(--surface);font-size:12.5px;color:var(--text-faint)}
`;
const SHOT_PAGE = `
<div class="page">
  <div class="sidebar"><i class="nav-item on"></i><i class="nav-item"></i><i class="nav-item"></i><i class="nav-item"></i></div>
  <div class="main">
    <div class="topbar">Notal AI</div>
    <div class="chat">
      <div class="greeting">Welcome back</div>
      <p class="msg me">Review this idea: an app that turns meeting notes into tasks</p>
      <p class="msg">Good seed. Strengths — it solves a pain people already feel. Risks — the magic moment depends on extraction quality.</p>
    </div>
    <div class="composer">Message Notal AI…</div>
  </div>
</div>`;

/* One observer for every card: the mock is authored at 640x400, so the width a
   card actually got decides how far down it scales. */
const shotScale = new ResizeObserver(entries => {
  for (const en of entries)
    en.target.style.setProperty("--shot-scale", String(Math.min(1, en.contentRect.width / 640)));
});

function extPreview(ui, shot) {
  const wrap = document.createElement("div");
  wrap.className = "ext-shot";
  if (shot) {
    /* a photo the publisher brought, trusted as an image and nothing else */
    const img = document.createElement("img");
    img.alt = ""; img.decoding = "async"; img.src = shot;
    wrap.append(img);
    return wrap;
  }
  const f = document.createElement("iframe");
  f.setAttribute("sandbox", "allow-scripts");
  f.setAttribute("title", "Extension preview");
  f.setAttribute("loading", "lazy");
  f.srcdoc = `<!doctype html><html><head><meta charset="utf-8">`
    + `<style>${SHOT_BASE}${ui?.css || ""}</style></head><body>${SHOT_PAGE}${ui?.html || ""}`
    + `<script>try{${ui?.js || ""}}catch(e){}<\/script></body></html>`;
  wrap.append(f);
  shotScale.observe(wrap);
  return wrap;
}

/* A pasted or chosen image becomes a card photo: drawn down to the card's own
   width on a canvas, so a phone screenshot arrives as tens of kilobytes
   instead of megabytes, and the library stays a table rather than a bucket. */
async function shotFromFile(file) {
  const bmp = await createImageBitmap(file);
  const w = Math.min(640, bmp.width);
  const h = Math.round(bmp.height * (w / bmp.width));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.82);
}

/* ---------- Extension Maker: two doors ---------- */
const makerPick = $("#extMakerPick");
const nameDialog = $("#extNameDialog");
let nameKind = "feature"; // "feature" is a prompt add-on, "ui" comes from editor mode
let pendingUi = null;     // the CSS editor mode just produced
const SHOT_NOTE = "Optional. Without one the card draws a live preview of the extension itself.";

function openNameDialog(kind, ui) {
  nameKind = kind;
  pendingUi = ui || null;
  $("#featureTitle").textContent = kind === "feature" ? "New feature" : "New UI extension";
  $("#featureSub").textContent = kind === "feature"
    ? "Say what it should do. While its switch is on, those words ride along with every message you send."
    : "Name what you dragged together. The card shows the page with your changes applied.";
  $("#ftPromptWrap").hidden = kind !== "feature";
  $("#ftName").value = "";
  $("#ftDesc").value = "";
  $("#ftPrompt").value = "";
  showNameShot();
  nameDialog.hidden = false;
  motion.reveal(nameDialog.querySelector(".modal"));
  $("#ftName").focus();
}

function showNameShot() {
  $("#ftPreview").replaceChildren(extPreview(nameKind === "feature" ? null : pendingUi));
}

function closeNameDialog() { nameDialog.hidden = true; }

$("#extMakerBtn").addEventListener("click", () => {
  makerPick.hidden = false;
  motion.reveal(makerPick.querySelector(".modal"));
});
$("#pickClose").addEventListener("click", () => { makerPick.hidden = true; });
makerPick.addEventListener("click", e => { if (e.target === makerPick) makerPick.hidden = true; });
document.querySelectorAll("[data-pick]").forEach(b => b.addEventListener("click", () => {
  makerPick.hidden = true;
  if (b.dataset.pick === "feature") openNameDialog("feature", null);
  else startEditorMode();
}));
$("#featureClose").addEventListener("click", () => { closeNameDialog(); discardEditorMode(); });
nameDialog.addEventListener("click", e => {
  if (e.target === nameDialog) { closeNameDialog(); discardEditorMode(); }
});

function nameCollect() {
  const name = $("#ftName").value.trim();
  if (!name) {
    toast("Give it a name first.");
    $("#ftName").focus();
    return null;
  }
  if (nameKind === "feature" && !$("#ftPrompt").value.trim()) {
    toast("Say what the feature should do.");
    $("#ftPrompt").focus();
    return null;
  }
  return {
    name,
    desc: $("#ftDesc").value.trim()
      || (nameKind === "feature" ? "Your own feature." : "Your own UI extension."),
    prompt: nameKind === "feature" ? $("#ftPrompt").value.trim() : "",
    ui: nameKind === "feature" ? null : pendingUi,
  };
}

function nameFinish() {
  closeNameDialog();
  exitEditorMode();
  applyUiExtensions();
  renderExtensions();
}

$("#ftSave").addEventListener("click", () => {
  const d = nameCollect();
  if (!d) return;
  state.extensions.push({ id: crypto.randomUUID(), ...d, builtin: false, enabled: true });
  save();
  nameFinish();
  toast(`"${d.name}" saved and switched on — publish it from its card when you want others to have it.`);
});

/* ---------- editor mode ----------
   The UI maker puts the real page under your hands: hover a part of it, drag
   to move, pull the corner to resize. Every change is recorded against a
   selector rather than left on the element, because what you make has to be
   CSS that works on someone else's screen. */
const EDIT_TARGETS = [
  [".composer", "Message box"],
  [".greeting", "Greeting"],
  [".msg", "Messages"],
  [".chat", "Chat column"],
  [".topbar", "Top bar"],
  [".sidebar", "Sidebar"],
];
const EDIT_MIN = 48;
const edBox = $("#edBox");
let editing = false;
let edits = {};      // selector -> { left, top, width, height }
let edHover = null;  // { sel, label, el }
let editDrag = null;

function editTarget(node) {
  if (!node || !node.closest) return null;
  for (const [sel, label] of EDIT_TARGETS) {
    const el = node.closest(sel);
    if (el) return { sel, label, el };
  }
  return null;
}

function applyEdit(sel) {
  const e = edits[sel] || {};
  for (const el of document.querySelectorAll(sel)) {
    el.style.position = e.left || e.top ? "relative" : "";
    el.style.left = e.left ? `${e.left}px` : "";
    el.style.top = e.top ? `${e.top}px` : "";
    /* several parts are capped by their own max-width, so a drag you can see
       on the box produced no change on the page at all */
    el.style.maxWidth = e.width ? "none" : "";
    el.style.width = e.width ? `${e.width}px` : "";
    /* a flex child is stretched by its container and pays no attention to a
       height you dragged, so take it out of the stretch first */
    el.style.flex = e.height ? "0 0 auto" : "";
    el.style.height = e.height ? `${e.height}px` : "";
  }
}

/* The box follows the element, but the grab handle lives at its bottom-right
   corner — so a full-height part like the sidebar parked the handle below the
   window edge, where it could be neither seen nor pressed. The drawn box is
   clamped to what is actually on screen; the drag still measures the element's
   true size, so the CSS keeps the part you cannot see. */
const ED_GUTTER = 10;
function moveEdBox() {
  if (!editing || !edHover || !edHover.el.isConnected) { edBox.hidden = true; return; }
  const r = edHover.el.getBoundingClientRect();
  if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) {
    edBox.hidden = true; // off screen entirely, like a closed sidebar
    return;
  }
  const left = Math.min(Math.max(r.left, 1), innerWidth - ED_GUTTER * 2);
  const top = Math.min(Math.max(r.top, 1), innerHeight - ED_GUTTER * 2);
  const right = Math.max(left + 1, Math.min(r.right, innerWidth - ED_GUTTER));
  const bottom = Math.max(top + 1, Math.min(r.bottom, innerHeight - ED_GUTTER));
  edBox.hidden = false;
  edBox.style.cssText = `left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px`;
  const label = edBox.querySelector(".ed-box-label");
  label.textContent = edHover.label;
  label.classList.toggle("inverted", top < 26);
}

function startEditorMode() {
  if (theming) stopThemeMode(true);
  setView("chats");
  editing = true;
  edits = {};
  document.body.classList.add("editing");
  $("#editorBar").hidden = false;
  toast("Editor mode — drag a part of the page, or pull its corner.");
}

function exitEditorMode() {
  if (!editing) return;
  editing = false;
  editDrag = null;
  edHover = null;
  for (const sel of Object.keys(edits)) { edits[sel] = {}; applyEdit(sel); }
  edits = {};
  document.body.classList.remove("editing");
  $("#editorBar").hidden = true;
  edBox.hidden = true;
}

function discardEditorMode() { exitEditorMode(); }

function resetEdits() {
  for (const sel of Object.keys(edits)) { edits[sel] = {}; applyEdit(sel); }
  edits = {};
  moveEdBox();
}

function editorCss() {
  const blocks = [];
  for (const [sel, e] of Object.entries(edits)) {
    const rules = [];
    if (e.left || e.top) rules.push("position: relative");
    if (e.left) rules.push(`left: ${e.left}px`);
    if (e.top) rules.push(`top: ${e.top}px`);
    if (e.width) rules.push("max-width: none", `width: ${e.width}px`);
    if (e.height) rules.push("flex: 0 0 auto", `height: ${e.height}px`);
    if (rules.length) blocks.push(`${sel} {\n  ${rules.join(";\n  ")};\n}`);
  }
  return blocks.join("\n\n");
}

document.addEventListener("pointermove", (e) => {
  if (!editing || editDrag) return;
  edHover = editTarget(e.target);
  moveEdBox();
}, true);

document.addEventListener("pointerdown", (e) => {
  if (!editing) return;
  if (e.target.closest("#editorBar")) return;
  if (editDrag) return;
  if (e.target.classList.contains("ed-handle")) {
    beginEditDrag(e, "resize");
    return;
  }
  const t = editTarget(e.target);
  if (!t) return;
  edHover = t;
  moveEdBox();
  beginEditDrag(e, "move");
}, true);

function beginEditDrag(e, mode) {
  if (!edHover) return;
  const cur = edits[edHover.sel] || {};
  const r = edHover.el.getBoundingClientRect();
  editDrag = {
    mode, sel: edHover.sel, x: e.clientX, y: e.clientY,
    left: cur.left || 0, top: cur.top || 0,
    w: Math.round(r.width), h: Math.round(r.height),
  };
  window.addEventListener("pointermove", stepEditDrag, true);
  window.addEventListener("pointerup", endEditDrag, true);
  e.preventDefault();
}

function stepEditDrag(e) {
  if (!editDrag) return;
  const dx = e.clientX - editDrag.x, dy = e.clientY - editDrag.y;
  const cur = edits[editDrag.sel] || (edits[editDrag.sel] = {});
  if (editDrag.mode === "move") {
    cur.left = Math.round(editDrag.left + dx);
    cur.top = Math.round(editDrag.top + dy);
  } else {
    cur.width = Math.max(EDIT_MIN, Math.round(editDrag.w + dx));
    cur.height = Math.max(EDIT_MIN, Math.round(editDrag.h + dy));
  }
  applyEdit(editDrag.sel);
  moveEdBox();
}

function endEditDrag() {
  editDrag = null;
  window.removeEventListener("pointermove", stepEditDrag, true);
  window.removeEventListener("pointerup", endEditDrag, true);
}

$("#ebClose").addEventListener("click", exitEditorMode);
$("#ebReset").addEventListener("click", resetEdits);
$("#ebSave").addEventListener("click", () => {
  const css = editorCss();
  if (!css) { toast("Nothing moved yet — drag a part of the page first."); return; }
  const ui = { css, html: "", js: "" };
  exitEditorMode();
  openNameDialog("ui", ui);
  /* a layout maker has no colours of its own — those live in Theme — so say so
     once, rather than let the result look like the drag did nothing */
  if (!themeExtension()?.enabled)
    toast("Colours and corners come from the Theme extension. Switch it on to see them over your layout.");
});

/* ---------- the right-click menu ----------
   The browser's menu had nothing this page cares about, so the page answers the
   right-click itself: what you can do with the words you selected, and what you
   can make of the part sitting under the cursor. */
const ctxMenu = $("#ctxMenu");
const ctxTheme = $("#ctxTheme");
let ctxPart = null; // the part under the cursor, when there was one

function closeCtx() {
  ctxMenu.hidden = true;
  ctxTheme.hidden = true;
  ctxPart = null;
}

function placeCtx(menu, x, y) {
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
}

function ctxText() {
  const sel = String(getSelection() || "").trim();
  if (sel) return sel;
  const el = editTarget(document.activeElement)?.el || ctxPart?.el;
  return el ? (el.innerText || "").trim().slice(0, 4000) : "";
}

document.addEventListener("contextmenu", (e) => {
  if (e.target.closest(".ctx-menu")) return; // the colour pickers keep their own menus
  e.preventDefault();
  const wasOpen = !ctxMenu.hidden || !ctxTheme.hidden;
  closeCtx();
  if (wasOpen) return; // a second right-click closes it, like any menu
  ctxPart = editTarget(e.target);
  if (theming) {
    if (ctxPart) openThemeControls(ctxPart, e.clientX, e.clientY);
    else toast("Right-click one of the page's parts — the message box, sidebar, top bar.");
    return;
  }
  const text = ctxText();
  ctxMenu.querySelector('[data-ctx="copy"]').disabled = !text;
  ctxMenu.querySelector('[data-ctx="ask"]').disabled = !text;
  ctxMenu.querySelector('[data-ctx="theme-part"]').hidden = !ctxPart;
  placeCtx(ctxMenu, e.clientX, e.clientY);
});

ctxMenu.addEventListener("click", async (e) => {
  const item = e.target.closest("[data-ctx]");
  if (!item || item.disabled) return;
  /* this same click is still on its way to the document-wide dismiss, which
     would shut the theme panel this handler has just opened */
  e.stopPropagation();
  const act = item.dataset.ctx;
  const text = ctxText();
  const part = ctxPart;
  closeCtx();
  if (act === "copy") {
    try { await navigator.clipboard.writeText(text); toast("Copied."); }
    catch { toast("The browser would not hand over the clipboard."); }
  } else if (act === "paste") {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip) { toast("The clipboard is empty."); return; }
      const box = document.activeElement?.matches?.("input, textarea")
        ? document.activeElement : els.input;
      box.value = box.value.trim() ? `${box.value.replace(/\s+$/, "")}\n\n${clip}` : clip;
      box.focus();
      box.dispatchEvent(new Event("input", { bubbles: true }));
    } catch { toast("Nothing to paste — the browser blocked the clipboard."); }
  } else if (act === "ask") {
    setView("chats");
    els.input.value = `About this:\n\n${text}\n\n`;
    els.input.focus();
    els.input.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (act === "make-feature") openNameDialog("feature", null);
  else if (act === "make-ui") startEditorMode();
  else if (act === "theme-part") {
    startThemeMode();
    if (part) openThemeControls(part, 120, 120);
  }
});

/* Clicking anything else closes the menu; clicking inside the theme panel is
   someone still setting a colour, so that must not count as going away. */
document.addEventListener("click", e => {
  if (!e.target.closest(".ctx-menu")) closeCtx();
});
window.addEventListener("resize", closeCtx);
window.addEventListener("scroll", closeCtx, true);

/* ---------- theme mode ----------
   A theme is a colour pair and a corner radius per part, recorded against the
   same selectors the UI maker uses so the rules hold up on someone else's
   screen. They live on the Theme extension, which is what makes a theme
   something you can switch off — or publish — like anything else. */
let theming = false;
let themeEdits = {};      // selector -> { bg, fg, radius }
let themeTarget = null;   // the Theme extension being written into
let themeWas = null;      // its contents on the way in, for a walk-back

function themeExtension() {
  return state.extensions.find(x => x.themeMaker) || null;
}

function themeCss(ed) {
  return Object.entries(ed)
    .filter(([, v]) => v && (v.bg || v.fg || v.radius))
    .map(([sel, v]) => `${sel} {\n`
      + [v.bg && `  background: ${v.bg};`, v.fg && `  color: ${v.fg};`,
         v.radius && `  border-radius: ${v.radius}px;`].filter(Boolean).join("\n")
      + "\n}")
    .join("\n");
}

function applyThemeEdits() {
  if (!themeTarget) return;
  themeTarget.theme = themeEdits;
  themeTarget.ui.css = themeCss(themeEdits);
  save();
  applyUiExtensions();
}

function startThemeMode() {
  const x = themeExtension();
  if (!x) { toast("The Theme extension is not here to write into."); return; }
  /* the two makers each own the top-right corner, and one page cannot be under
     both kinds of edit at once */
  if (editing) exitEditorMode();
  setView("chats");
  themeTarget = x;
  themeWas = { theme: x.theme ? JSON.parse(JSON.stringify(x.theme)) : {}, css: x.ui?.css || "" };
  themeEdits = x.theme ? JSON.parse(JSON.stringify(x.theme)) : {};
  if (!x.ui) x.ui = { css: "", html: "", js: "" };
  /* a theme you cannot see is not worth picking, so the extension switches
     itself on the moment its maker opens */
  const wasOff = !x.enabled;
  x.enabled = true;
  theming = true;
  document.body.classList.add("theming");
  $("#themeBar").hidden = false;
  applyThemeEdits();
  renderExtensions();
  toast(wasOff
    ? "Theme switched on. Right-click a part of the page to recolour it."
    : "Theme mode — right-click a part of the page to recolour it.");
}

function stopThemeMode(revert) {
  if (!theming) return;
  theming = false;
  document.body.classList.remove("theming");
  $("#themeBar").hidden = true;
  ctxTheme.hidden = true;
  if (revert && themeTarget && themeWas) {
    themeTarget.theme = themeWas.theme;
    themeTarget.ui.css = themeWas.css;
  }
  save();
  applyUiExtensions();
  themeTarget = null;
  themeWas = null;
  renderExtensions();
}

function openThemeControls(part, x, y) {
  const cur = themeEdits[part.sel] || {};
  const cs = getComputedStyle(part.el);
  $("#ctLabel").textContent = part.label;
  $("#ctBg").value = cur.bg || readableBg(part.el);
  $("#ctFg").value = cur.fg || rgbToHex(cs.color);
  $("#ctRadius").value = cur.radius ?? 0;
  $("#ctRadiusOut").textContent = `${$("#ctRadius").value}px`;
  ctxTheme.dataset.part = part.sel;
  placeCtx(ctxTheme, x, y);
}

/* the page speaks rgb()/rgba() and the pickers speak #rrggbb */
function rgbToHex(rgb) {
  const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(rgb || "");
  if (!m) return "#ffffff";
  return `#${m.slice(1, 4).map(n => (+n).toString(16).padStart(2, "0")).join("")}`;
}

/* A see-through part reports rgba(0,0,0,0), which a picker would show as black,
   so the swatch asks the nearest ancestor that actually paints something. */
function readableBg(el) {
  for (let n = el; n; n = n.parentElement) {
    const v = getComputedStyle(n).backgroundColor || "";
    const m = /rgba?\(([^)]+)\)/.exec(v);
    if (!m) continue;
    const parts = m[1].split(/[\s,/]+/).filter(s => s !== "");
    if (parts.length >= 4 && parseFloat(parts[3]) === 0) continue;
    return rgbToHex(v);
  }
  return "#ffffff";
}

function stepTheme() {
  const sel = ctxTheme.dataset.part;
  if (!sel) return;
  const radius = +$("#ctRadius").value;
  themeEdits[sel] = { bg: $("#ctBg").value, fg: $("#ctFg").value, radius };
  $("#ctRadiusOut").textContent = `${radius}px`;
  applyThemeEdits();
}
["ctBg", "ctFg", "ctRadius"].forEach(id => $(`#${id}`).addEventListener("input", stepTheme));

$("#tbSave").addEventListener("click", () => {
  const named = Object.keys(themeEdits).length;
  stopThemeMode(false);
  toast(named
    ? `Theme saved across ${named} ${named === 1 ? "part" : "parts"} — publish the Theme card to share it.`
    : "Theme saved.");
});
$("#tbClose").addEventListener("click", () => stopThemeMode(true));
$("#tbReset").addEventListener("click", () => { themeEdits = {}; applyThemeEdits(); toast("Cleared every part."); });

ctxTheme.querySelector('[data-ctx="theme-clear"]').addEventListener("click", () => {
  const sel = ctxTheme.dataset.part;
  if (!sel) return;
  delete themeEdits[sel];
  applyThemeEdits();
  ctxTheme.hidden = true;
  toast("That part is back to the page's own colours.");
});

/* An imported script runs here the moment its switch goes on, so the import
   asks first when the file carries any JavaScript. */
$("#extImportBtn").addEventListener("click", () => $("#extImportInput").click());
$("#extImportInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.name !== "string" || !data.ui || typeof data.ui !== "object")
      throw new Error("not a notal-ui-extension file");
    if (data.ui.js && !confirm(`"${data.name}" carries JavaScript that will run in this page when you switch it on. Import anyway?`)) return;
    state.extensions.push({
      id: crypto.randomUUID(), name: data.name,
      desc: data.desc || "Imported extension.", prompt: "",
      builtin: false, enabled: false,
      ui: { css: data.ui.css || "", html: data.ui.html || "", js: data.ui.js || "" },
    });
    save();
    renderExtensions();
    toast(`"${data.name}" imported — switch it on in the Built-in/Yours lists.`);
  } catch (err) {
    toast("Could not import that file: " + err.message);
  }
});

$("#extForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#extNameInput").value.trim();
  const desc = $("#extDescInput").value.trim();
  const prompt = $("#extPromptInput").value.trim();
  if (!name || !prompt) return;
  state.extensions.push({
    id: crypto.randomUUID(), name,
    desc: desc || "Your own extension.",
    prompt, builtin: false, enabled: true,
  });
  e.target.reset();
  save();
  renderExtensions();
  toast(`Extension "${name}" added and switched on.`);
});

/* ---------- global dismiss ---------- */
document.addEventListener("click", () => { setModelMenu(false); setAccountMenu(false); });

/* ---------- chat logo ---------- */
/* The triangle in the Notal mark spins while a reply is in flight; see
   .msg.thinking in styles.css. */

/* ---------- progressive web app ---------- */
const THEME_COLORS = { light: "#f5f1ea", dark: "#262624" };
els.amInstallBtn = $("#amInstallBtn");
let installPrompt = null;
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

if ("serviceWorker" in navigator) {
  if (DESKTOP) {
    /* The files are already on this disk and nothing else lives on this origin,
       so a cache here can only do one thing: keep serving the previous version
       of itself after an update. Unregister whatever an earlier launch left. */
    navigator.serviceWorker.getRegistrations()
      .then(list => list.forEach(r => r.unregister()))
      .catch(() => {});
  } else {
    // The worker stays at the site root so one registration covers both the
    // landing page and /chat/; its default scope is its own folder.
    navigator.serviceWorker.register("../sw.js")
      .catch(err => console.warn("Offline support did not start:", err?.message));
  }
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  if (!isStandalone) els.amInstallBtn.hidden = false;
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  els.amInstallBtn.hidden = true;
  toast("Notal AI installed. Find it on your home screen or apps list.");
});
els.amInstallBtn.addEventListener("click", async () => {
  setAccountMenu(false);
  if (!installPrompt) { toast("Your browser will offer the install option again shortly."); return; }
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice.catch(() => ({ outcome: "failed" }));
  if (outcome === "accepted") toast("Installing Notal AI…");
  installPrompt = null;
  els.amInstallBtn.hidden = true;
});

/* ---------- init ---------- */
/* Narrow screens always start on the drawer; desktop keeps whichever width
   you left the sidebar at. */
setSidebar(window.innerWidth < 860 ? false : state.sidebarOpen !== false);
applyTheme();
els.modelName.textContent = selectedModel().name;
renderModelMenu();
renderProvCards();
renderProviders();
renderAuthUI();
renderNotifUI();
renderSecurityUI();
renderRelayUI();
if (state.pinHash) lockApp(); else resetIdleTimer();
setView("chats");
setGreeting();
setMode(state.mode);
renderHistory();
renderMessages();
applyUiExtensions();
ensureAuth().catch(() => {});

/* The boot splash holds for a full two seconds, then the mark swells bigger
   and bigger until the whole chat is revealed behind it. */
const bootSplash = document.getElementById("bootSplash");
if (bootSplash) {
  setTimeout(() => {
    bootSplash.classList.add("zoom");
    const mark = bootSplash.querySelector(".boot-mark");
    mark.addEventListener("animationend", () => {
      bootSplash.classList.add("closing");
      bootSplash.addEventListener("transitionend", () => bootSplash.remove(), { once: true });
    }, { once: true });
  }, Math.max(0, 2000 - performance.now()));
}

