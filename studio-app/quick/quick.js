/* Quick Chat, the surface. All the thinking happens in the main window: this
   page hands the question over, paints the tokens as they come back, and gets
   out of the way. The thread here is only this visit — the real conversation,
   with the answer in it, is the one the chat window keeps. */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const panel = $("#qPanel"), head = $("#qHead"), thread = $("#qThread");
  const form = $("#qForm"), input = $("#qInput"), sendBtn = $("#qSend"), stopBtn = $("#qStop");
  const modelLine = $("#qModel"), subLine = $("#qSub"), pinBtn = $("#qPin");

  const notal = window.notal || {};
  let job = null;          // { id, askEl, ansEl, text }
  let pinned = false;

  /* ---------- theme and model, read from the app's own state ----------
     Both windows are served from the same origin, so this page sees the same
     localStorage the chat uses. A "storage" event fires when the other window
     writes, which means a theme or model change lands here while you type. */
  function appState() {
    try { return JSON.parse(localStorage.getItem("notal.state") || "{}"); }
    catch { return {}; }
  }

  function syncAppearance() {
    const s = appState();
    document.documentElement.dataset.theme = s.theme || "dark";
    const model = (s.models || []).find(m => m.id === s.selectedModel);
    modelLine.textContent = model ? model.name : "no model chosen — pick one in the app";
    const conv = (s.conversations || []).find(c => c.id === s.activeId);
    subLine.textContent = conv ? "Answering in “" + conv.title + "”" : "Answers go into a new chat";
  }

  syncAppearance();
  window.addEventListener("storage", syncAppearance);
  /* a chat started in the other window may not exist yet when this one opens */
  setInterval(syncAppearance, 4000);

  if (notal.info) notal.info().then(info => {
    document.title = "Quick Chat — " + (info.name || "Notal AI Studio");
  }).catch(() => {});

  /* ---------- rendering: text only, never markup ----------
     The reply is model output, so nothing it contains is ever handed to
     innerHTML. Fenced blocks become <pre>, everything else becomes paragraphs,
     and both go in through textContent. */
  function renderInto(el, text) {
    el.replaceChildren();
    const parts = String(text || "").split("```");
    parts.forEach((chunk, i) => {
      if (i % 2 === 1) {
        const body = chunk.replace(/^[ \t]*[A-Za-z0-9_+.#-]*\n/, "").replace(/\n$/, "");
        const pre = document.createElement("pre");
        pre.textContent = body;
        el.append(pre);
        return;
      }
      const trimmed = chunk.replace(/^\n+|\n+$/g, "");
      if (!trimmed) return;
      for (const para of trimmed.split(/\n{2,}/)) {
        const p = document.createElement("p");
        p.textContent = para;
        el.append(p);
      }
    });
  }

  function scrollDown() { thread.scrollTop = thread.scrollHeight; }

  function setBusy(on) {
    head.classList.toggle("thinking", on);
    stopBtn.hidden = !on;
    sendBtn.disabled = on;
    notal.engineBusy && notal.engineBusy(on);
  }

  function clearThread() {
    thread.replaceChildren();
  }

  function ask(text) {
    if (job) return;
    if (thread.querySelector(".q-empty")) clearThread();
    const turn = document.createElement("div");
    turn.className = "q-turn";
    const askEl = document.createElement("div");
    askEl.className = "q-ask";
    askEl.textContent = text;
    const ansEl = document.createElement("div");
    ansEl.className = "q-ans";
    turn.append(askEl, ansEl);
    thread.append(turn);
    scrollDown();
    setBusy(true);
    input.value = "";
    autoresize();
    job = { id: notal.quickSend(text), askEl, ansEl, text: "", started: Date.now() };
  }

  function finish(payload) {
    if (!job) return { };
    const cur = job;
    job = null;
    setBusy(false);
    const ms = Date.now() - cur.started;
    if (payload.error) {
      cur.askEl.classList.add("error");
      const p = document.createElement("p");
      p.textContent = String(payload.error);
      cur.ansEl.append(p);
    } else {
      renderInto(cur.ansEl, payload.text || cur.text);
    }
    const meta = document.createElement("p");
    meta.className = "q-meta";
    meta.textContent = (payload.error ? "did not answer" : "answered in " + (ms / 1000).toFixed(1) + "s")
      + " · saved in the chat";
    cur.ansEl.append(meta);
    scrollDown();
    return { chars: (payload.text || cur.text || "").length, error: payload.error || null };
  }

  if (notal.onQuickEvent) {
    notal.onQuickEvent((ev) => {
      if (!job || ev.id !== job.id) return;
      if (ev.kind === "chunk") { job.text += ev.text; renderInto(job.ansEl, job.text); scrollDown(); }
      else if (ev.kind === "reasoning") { /* the overlay has no room for the trail */ }
      else if (ev.kind === "done") finish(ev);
    });
  } else {
    subLine.textContent = "this window has no bridge to the app";
  }

  /* ---------- window controls ---------- */
  function hide() { notal.quickHide ? notal.quickHide() : window.close(); }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) ask(text);
  });

  sendBtn.addEventListener("click", () => {
    const text = input.value.trim();
    if (text && !job) ask(text);
  });

  stopBtn.addEventListener("click", () => {
    if (job) notal.quickCancel && notal.quickCancel(job.id);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = input.value.trim();
      if (text) ask(text);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); hide(); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#qSend").click();
  });

  $("#qClose").addEventListener("click", hide);
  $("#qOpen").addEventListener("click", () => { notal.showMain ? notal.showMain() : window.open("/chat/", "_self"); hide(); });
  pinBtn.addEventListener("click", () => {
    pinned = !pinned;
    pinBtn.setAttribute("aria-pressed", String(pinned));
    pinBtn.title = pinned ? "Stays open when you click away" : "Hide when you click away";
    notal.setPinned && notal.setPinned(pinned);
  });

  function autoresize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 130) + "px";
  }
  input.addEventListener("input", autoresize);

  if (notal.onQuickFocusInput) notal.onQuickFocusInput(() => input.focus());
  window.addEventListener("focus", () => input.focus());
  input.focus();
})();
