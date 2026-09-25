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

let state = Object.assign({
  conversations: [],
  activeId: null,
  theme: "light",
  displayName: "batbleseed",
  models: [{ id: "notal-generic", name: "notal generic", provider: "Notal built-in" }],
  selectedModel: "notal-generic",
  providers: [],
  notifications: { enabled: false, sound: false },
  pinHash: null,
  idleLock: 0,
}, store.load());

const GENERIC_MODEL = { id: "notal-generic", name: "notal generic", provider: "Notal built-in" };
if (!Array.isArray(state.models) || !state.models.length) state.models = [GENERIC_MODEL];
if (!state.models.some(m => m.id === "notal-generic")) state.models.unshift(GENERIC_MODEL);
if (!state.models.some(m => m.id === state.selectedModel)) state.selectedModel = "notal-generic";
if (!Array.isArray(state.providers)) state.providers = [];
if (!state.firebaseConfig) state.firebaseConfig = DEFAULT_FIREBASE_CONFIG;
if (!state.notifications || typeof state.notifications !== "object")
  state.notifications = { enabled: false, sound: false };
if (typeof state.pinHash !== "string") state.pinHash = null;
if (typeof state.idleLock !== "number") state.idleLock = 0;

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
  els.greetingTitle.textContent = `${part}, ${state.displayName}`;
}

/* ---------- conversations ---------- */
function newConversation() {
  const conv = { id: crypto.randomUUID(), title: "New chat", messages: [], createdAt: Date.now() };
  state.conversations.unshift(conv);
  state.activeId = conv.id;
  save();
  renderHistory();
  renderMessages();
  els.input.focus();
}

function openConversation(id) {
  state.activeId = id;
  save();
  renderHistory();
  renderMessages();
}

function renderHistory(filter = "") {
  const q = filter.trim().toLowerCase();
  const items = state.conversations.filter(c => !q || c.title.toLowerCase().includes(q));
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

function appendMessage(msg) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${msg.role}`;

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  if (msg.role === "user" && currentUser?.photoURL) {
    const img = document.createElement("img");
    img.src = currentUser.photoURL;
    img.alt = "";
    avatar.append(img);
  } else if (msg.role === "assistant") {
    avatar.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M5 7h14l-7 10.5z"/></svg>`;
  } else {
    avatar.textContent = "B";
  }

  const body = document.createElement("div");
  body.className = "msg-body";

  const roleName = document.createElement("div");
  roleName.className = "msg-role";
  roleName.textContent = msg.role === "user" ? "You" : "Notal";

  if (msg.attachments?.length) body.append(renderAttachments(msg.attachments));

  const content = document.createElement("div");
  content.className = msg.role === "user" ? "msg-bubble" : "msg-text";
  content.textContent = msg.text || "";
  body.append(roleName, content);

  wrap.append(avatar, body);
  els.messages.append(wrap);
  return content;
}

function scrollToBottom() {
  els.chat.scrollTop = els.chat.scrollHeight;
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
  appendMessage(userMsg);
  scrollToBottom();
  save();
  renderHistory(els.search.value);

  els.input.value = "";
  autoresize();

  const typingEl = appendMessage({ role: "assistant", text: "" });
  typingEl.innerHTML = `<span class="typing"><i></i><i></i><i></i></span>`;
  scrollToBottom();
  els.sendBtn.disabled = true;
  els.input.disabled = true;

  const model = selectedModel();
  try {
    let reply;
    if (model.providerId) {
      reply = await callProvider(model, conv.messages);
    } else {
      await new Promise(r => setTimeout(r, 600 + Math.random() * 700));
      reply = craftReply(trimmed, conv.messages.length);
    }
    conv.messages.push({ role: "assistant", text: reply });
    save();
    typewrite(typingEl, reply, () => notifyReply(reply));
  } catch (err) {
    typingEl.classList.add("msg-error");
    typingEl.textContent = "⚠ " + (err?.message || "Request failed");
  } finally {
    els.sendBtn.disabled = false;
    els.input.disabled = false;
    els.input.focus();
  }
}

function typewrite(el, text, done) {
  let i = 0;
  const step = Math.max(2, Math.round(text.length / 160));
  const tick = () => {
    i = Math.min(text.length, i + step * 3);
    el.textContent = text.slice(0, i);
    scrollToBottom();
    if (i < text.length) requestAnimationFrame(tick);
    else done?.();
  };
  tick();
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
  if (p.includes("thank")) {
    return "You're welcome — glad I could help. Anything else you'd like to work through?";
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
const SYSTEM_PROMPT = "You are Notal, a calm, clear assistant in the Notal AI workspace.";

function splitDataUrl(u) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(u) || [];
  return { mime: m[1] || "application/octet-stream", data: m[2] || "" };
}

function imageAtts(m) {
  return (m.attachments || []).filter(a => a.dataUrl && (a.type || "").startsWith("image/"));
}

async function httpJson(url, opts) {
  let res;
  try { res = await fetch(url, opts); }
  catch { throw new Error("Could not reach the API — check the base URL, your connection, and CORS."); }
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j.error?.message || j.message || JSON.stringify(j).slice(0, 180);
    } catch {}
    throw new Error(`${res.status} ${res.statusText}${detail ? " — " + detail : ""}`);
  }
  return res.json();
}

async function callProvider(model, messages) {
  const p = state.providers.find(x => x.id === model.providerId);
  if (!p) throw new Error("Provider settings are missing — re-add the model in Settings → Providers.");
  const base = (p.baseUrl || KIND_DEFAULTS[p.kind] || "").replace(/\/+$/, "");
  if (!base) throw new Error("No base URL set — add it in Settings → Providers.");
  if (p.kind !== "ollama" && !p.apiKey) throw new Error("No API key saved — add it in Settings → Providers.");

  const history = messages.slice(-13);

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
    const data = await httpJson(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": p.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: p.name, max_tokens: 2048, system: SYSTEM_PROMPT, messages: msgs }),
    });
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    if (!text) throw new Error("The provider returned an empty response.");
    return text;
  }

  if (p.kind === "gemini") {
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
    const data = await httpJson(
      `${base}/v1beta/models/${encodeURIComponent(p.name)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": p.apiKey },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents }),
    });
    if (data.error?.message) throw new Error(data.error.message);
    const text = (data.candidates?.[0]?.content?.parts || []).map(x => x.text || "").join("");
    if (!text) throw new Error("The provider returned an empty response.");
    return text;
  }

  const msgs = [{ role: "system", content: SYSTEM_PROMPT }];
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
    const data = await httpJson(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: p.name, messages: msgs, stream: false }),
    });
    const text = data.message?.content;
    if (!text) throw new Error("Ollama returned an empty response — is the model pulled?");
    return text;
  }

  const data = await httpJson(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
    body: JSON.stringify({ model: p.name, messages: msgs, max_tokens: 2048 }),
  });
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(data.error?.message || "The provider returned an empty response.");
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
    }
    pendingAtts.push(item);
  }
  els.fileInput.value = "";
  renderPending();
});

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

/* ---------- mic (Web Speech API) ---------- */
const SRClass = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recOn = false;

els.micBtn.addEventListener("click", () => {
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
  };
  recOn = true;
  els.micBtn.classList.add("recording");
  rec.start();
});

/* ---------- suggestions ---------- */
els.suggestions.addEventListener("click", (e) => {
  const btn = e.target.closest(".suggestion");
  if (!btn) return;
  els.input.value = btn.dataset.prompt;
  sendMessage(btn.dataset.prompt);
});

/* ---------- sidebar ---------- */
els.sidebarClose.addEventListener("click", () => {
  els.sidebar.classList.toggle("collapsed");
  document.body.classList.toggle("sidebar-hidden", els.sidebar.classList.contains("collapsed"));
});
els.sidebarOpen.addEventListener("click", () => {
  els.sidebar.classList.remove("collapsed");
  document.body.classList.remove("sidebar-hidden");
});

document.querySelectorAll(".nav-item").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
  });
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
els.settingsClose = $("#settingsClose");
els.gearBtn = $("#gearBtn");

function openSettings(tab = "general") {
  els.overlay.hidden = false;
  switchTab(tab);
}
function closeSettings() {
  els.overlay.hidden = true;
}

els.gearBtn.addEventListener("click", () => openSettings());
els.settingsClose.addEventListener("click", closeSettings);
els.overlay.addEventListener("click", (e) => {
  if (e.target === els.overlay) closeSettings();
});
els.signinBtn = $("#signinBtn");
els.signinBtn.addEventListener("click", () => openSettings("account"));

document.querySelectorAll(".settings-tab").forEach(tab => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});
function switchTab(name) {
  document.querySelectorAll(".settings-tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".settings-panel").forEach(p =>
    p.hidden = p.id !== `panel-${name}`);
}

/* ---------- general ---------- */
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  document.querySelectorAll("#themeSeg button").forEach(b =>
    b.classList.toggle("active", b.dataset.themeVal === state.theme));
}
$("#themeSeg").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-theme-val]");
  if (!btn) return;
  state.theme = btn.dataset.themeVal;
  applyTheme();
  save();
});

$("#clearChatsBtn").addEventListener("click", () => {
  if (!state.conversations.length) return;
  if (!confirm("Delete all conversations? This cannot be undone.")) return;
  state.conversations = [];
  state.activeId = null;
  save();
  renderHistory(els.search.value);
  renderMessages();
});

/* ---------- account ---------- */
els.displayNameInput = $("#displayNameInput");
els.displayNameInput.value = state.displayName;
els.displayNameInput.addEventListener("input", () => {
  state.displayName = els.displayNameInput.value.trim() || "there";
  save();
  setGreeting();
});

/* ---------- providers ---------- */
els.providerList = $("#providerList");
els.providerForm = $("#providerForm");

function renderProviders() {
  els.providerList.innerHTML = "";
  if (!state.providers.length) {
    els.providerList.innerHTML = `<li class="history-empty">No providers configured yet</li>`;
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
    detail.textContent = [p.provider, p.baseUrl, p.apiKey ? "key set" : "no key"].filter(Boolean).join(" · ");
    meta.append(name, detail);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn pi-del";
    del.setAttribute("aria-label", `Remove ${p.name}`);
    del.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
    del.addEventListener("click", () => removeProvider(p.id));

    li.append(meta, del);
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

const KIND_BY_LABEL = {
  "OpenAI-compatible": "openai",
  "Anthropic": "anthropic",
  "Google Gemini": "gemini",
  "Ollama (local)": "ollama",
  "Custom": "openai",
};

els.providerForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#pfName").value.trim();
  if (!name) return;
  const label = $("#pfProvider").value;
  const provider = {
    id: crypto.randomUUID(),
    kind: KIND_BY_LABEL[label] || "openai",
    provider: label,
    name,
    baseUrl: $("#pfUrl").value.trim(),
    apiKey: $("#pfKey").value.trim(),
  };
  state.providers.push(provider);
  state.models.push({ id: provider.id, name, provider: label, providerId: provider.id });
  els.providerForm.reset();
  save();
  renderProviders();
  renderModelMenu();
  toast(`Model "${name}" added — pick it in the model menu.`);
});

/* ---------- share ---------- */
els.shareBtn.addEventListener("click", () => {
  const conv = activeConv();
  els.shareBtn.querySelector("span").textContent =
    conv ? "Link copied ✓" : "Start a chat first";
  setTimeout(() => els.shareBtn.querySelector("span").textContent = "Share", 1600);
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
  els.authStatus.textContent = currentUser
    ? `${currentUser.displayName || currentUser.email} — signed in with Google`
    : "Configured — click Sign in with Google";
  const label = els.signinBtn.querySelector("span");
  let photo = els.signinBtn.querySelector("img");
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
  if (!state.notifications.enabled || !("Notification" in window)) return;
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
    if (!els.overlay.hidden) closeSettings();
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

/* ---------- global dismiss ---------- */
document.addEventListener("click", () => setModelMenu(false));

/* ---------- init ---------- */
if (window.innerWidth < 860) els.sidebar.classList.add("collapsed");
applyTheme();
els.modelName.textContent = selectedModel().name;
renderModelMenu();
renderProviders();
renderAuthUI();
renderNotifUI();
renderSecurityUI();
if (state.pinHash) lockApp(); else resetIdleTimer();
setGreeting();
renderHistory();
renderMessages();
ensureAuth().catch(() => {});
