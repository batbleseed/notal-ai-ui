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
  activeProject: null,
  relayUrl: "",
  showThinking: false,
  sidebarOpen: true,
  mode: "chat",
  relayVerified: null,
  advanced: {},
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
for (const k of ["projects", "memories", "skills"])
  if (!Array.isArray(state[k])) state[k] = [];
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

function renderMarkdown(src) {
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
      const code = [];
      i++;
      while (i < lines.length && !/^ {0,3}```/.test(lines[i])) code.push(lines[i++]);
      i++;
      const pre = document.createElement("pre");
      pre.append(block("code", code.join("\n")));
      frag.append(pre);
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

function renderText(el, text, asMarkdown) {
  if (asMarkdown) el.replaceChildren(renderMarkdown(text));
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
  renderText(content, msg.text, msg.role === "assistant");

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
          if (reasoningStreamed) {
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
  let answer = "";
  let frame = 0;
  const draw = () => {
    frame = 0;
    /* a [browse] tag streams in before the page does, so the markup must never
       reach the visible answer */
    renderText(turn.textEl, cleanAnswer(answer), true);
    scrollToBottom();
  };
  /* one re-render per animation frame keeps markdown cheap while tokens fly by */
  const push = (chunk) => {
    answer += chunk;
    if (!frame) frame = requestAnimationFrame(draw);
  };
  const onDelta = (delta) => {
    if (delta.reasoning) turn.addReasoning(delta.reasoning);
    if (delta.text) push(delta.text);
  };

  try {
    if (model.providerId) {
      /* Browsing is a loop, not a side quest: the model asks for one page, this
         tab reads it, the page text comes back as context for the next turn,
         and only the final tag-free reply lands on the page. The pages go into
         `context`, never into `conv.messages`, so a lookup does not live in the
         chat history forever. */
      let context = conv.messages;
      let hops = 0;
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
        const closeStep = turn.startBrowse(url);
        const question = {
          role: "assistant",
          text: note || "(I need to check something before answering.)",
        };
        try {
          const page = await fetchPage(url, ac.signal);
          closeStep({ ok: true, title: page.title });
          context = [...context, question,
            { role: "user", text: `[page contents] ${url}\n\n${page.text}` }];
        } catch (err) {
          if (err?.name === "AbortError") throw err;
          closeStep({ ok: false });
          /* say so plainly — a model that does not know the lookup failed will
             ask for the same page again */
          context = [...context, question,
            { role: "user", text: `[browse failed] ${url} — ${err?.message || "the page could not be read"}` }];
        }
        hops++;
      }
      /* a finished reply is better evidence than any test button */
      recordProviderResult(model.providerId, true, "Answered a real message");
    } else {
      await streamBuiltIn(craftReply(trimmed, conv.messages.length), push, ac.signal);
    }
    if (frame) cancelAnimationFrame(frame);
    draw();
    turn.stopThinking();
    const reply = cleanAnswer(answer);
    conv.messages.push({ role: "assistant", text: reply });
    save();
    notifyReply(reply);
  } catch (err) {
    if (frame) cancelAnimationFrame(frame);
    turn.stopThinking();
    if (ac.signal.aborted) {
      /* stopping is not a failure: keep whatever already arrived */
      draw();
      const partial = cleanAnswer(answer);
      if (partial) {
        conv.messages.push({ role: "assistant", text: partial });
        save();
      } else {
        turn.wrap.remove();
      }
      toast("Stopped.");
      return;
    }
    if (model.providerId) {
      const p = state.providers.find(x => x.id === model.providerId);
      if (p) recordProviderResult(p.id, false, friendlyTestError(err, p));
    }
    turn.textEl.classList.add("msg-error");
    turn.textEl.textContent = "⚠ " + (err?.message || "Request failed");
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
  return (state.relayUrl || "").trim().replace(/\/+$/, "");
}
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } }

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
    const d = sseJson(line)?.choices?.[0]?.delta;
    return d
      ? { text: d.content || "", reasoning: d.reasoning_content || d.reasoning || "" }
      : null;
  },
  anthropic(line) {
    const j = sseJson(line);
    if (!j) return null;
    if (j.type === "error") throw new Error(j.error?.message || "The provider returned an error.");
    const d = j.delta || {};
    if (d.type === "text_delta") return { text: d.text || "", reasoning: "" };
    if (d.type === "thinking_delta") return { text: "", reasoning: d.thinking || "" };
    return null;
  },
  gemini(line) {
    const j = sseJson(line);
    if (!j) return null;
    if (j.error?.message) throw new Error(j.error.message);
    return splitThoughts(j.candidates?.[0]?.content?.parts);
  },
  ollama(line) {
    if (!line.trim()) return null;
    let j;
    try { j = JSON.parse(line); } catch { return null; }
    if (j.error) throw new Error(String(j.error));
    return { text: j.message?.content || "", reasoning: j.message?.thinking || "" };
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
  openai: (j) => ({ text: j.choices?.[0]?.message?.content || "", reasoning: "" }),
  anthropic: (j) => ({
    text: (j.content || []).filter(b => b.type === "text").map(b => b.text).join(""),
    reasoning: (j.content || []).filter(b => b.type === "thinking").map(b => b.thinking || "").join(""),
  }),
  gemini: (j) => splitThoughts(j.candidates?.[0]?.content?.parts),
  ollama: (j) => ({ text: j.message?.content || "", reasoning: j.message?.thinking || "" }),
};

async function streamProvider(url, opts, kind, onDelta) {
  const res = await openProviderCall(url, opts);
  if ((res.headers.get("content-type") || "").includes("application/json")) {
    const whole = WHOLE_REPLIES[kind]((await res.json()) || {});
    if (whole.text || whole.reasoning) onDelta(whole);
    return;
  }
  if (!res.body) throw new Error("The provider sent no response body.");

  const parse = STREAM_LINES[kind];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const takeLine = (raw) => {
    const delta = parse(raw);
    if (delta && (delta.text || delta.reasoning)) onDelta(delta);
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

const PLACEHOLDER_BY_MODE = {
  chat: "Message Notal AI...",
  coding: "Describe a bug or paste your code...",
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

function setMode(mode) {
  if (!SUGGESTIONS[mode]) return;
  state.mode = mode;
  save();
  els.modeSeg.querySelectorAll(".mode-btn").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  els.input.placeholder = PLACEHOLDER_BY_MODE[mode];
  renderSuggestions();
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
    setAccountMenu(false);
    if (!els.overlay.hidden) closeSettings();
    else if (panelOpen) setView("chats");
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
   panel closes. The sidebar nav is the quick access to each one. */
els.chatTitle = $(".chat-title");
const PANELS = ["projects", "memory", "skills"];
let panelOpen = null;

function renderPanel(name) {
  if (name === "projects") renderProjects();
  else if (name === "memory") renderMemory();
  else renderSkills();
}

function openPanel(name) {
  const overlay = $(`#view-${name}`);
  overlay.hidden = false;
  renderPanel(name);
  motion.reveal(overlay.querySelector(".panel-modal"));
}

/* hidden synchronously: an overlay that fades out but never finishes would
   sit invisible on top of the chat and swallow every click */
function closePanel(name) {
  $(`#view-${name}`).hidden = true;
}

function setView(name) {
  const panel = PANELS.includes(name) ? name : null;
  if (panel !== panelOpen) {
    if (panelOpen) closePanel(panelOpen);
    panelOpen = panel;
    if (panel) openPanel(panel);
  } else if (panel) {
    renderPanel(panel);
  }
  document.querySelectorAll(".nav-item").forEach(b =>
    b.classList.toggle("active", b.dataset.view === (panel ?? "chats")));
  els.chatTitle.textContent = activeConv()?.title
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
  // The worker stays at the site root so one registration covers both the
  // landing page and /chat/; its default scope is its own folder.
  navigator.serviceWorker.register("../sw.js")
    .catch(err => console.warn("Offline support did not start:", err?.message));
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
ensureAuth().catch(() => {});
