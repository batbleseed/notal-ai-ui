/* ============ the model that runs in this tab ============
   WebLLM brings the runtime and the weights. After one download every reply is
   worked out on this device — no key, no server, nothing leaving the tab. This
   file only knows how to load it, ask it and forget it; the chat UI stays in
   app.js. */

/* Pinned on purpose: the runtime and the model shards have to agree, and a
   floating "latest" can change both while someone is halfway through a
   download. */
const WEBLLM_URL = "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm";
const WEB_MODEL_CARD = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
const WEB_MODEL_ID = "browser-qwen-05b";
const WEB_MODEL_NAME = "browser mini · Qwen 0.5B";
const WEB_MODEL_MB = 290;
const WEB_MODEL_MAX_TOKENS = 512;
/* WebLLM keeps what it downloads in the Cache API under this scope. */
const WEB_MODEL_CACHE = "webllm/model";

let webLLM = null;
let webEngine = null;
let webEngineStarting = null;
let webAdapterPromise = null;

/* Having navigator.gpu is not the same as having a device: a blocked or
   software-only tab answers null here, and that is worth knowing before 290 MB
   is offered to someone who cannot use it. */
function webModelSupported() {
  if (!webAdapterPromise) {
    webAdapterPromise = (async () => {
      try {
        const adapter = navigator.gpu && await navigator.gpu.requestAdapter();
        return !!adapter;
      } catch { return false; }
    })();
  }
  return webAdapterPromise;
}

async function webModelLibrary() {
  if (!webLLM) webLLM = await import(WEBLLM_URL);
  return webLLM;
}

/* One engine for the session: the second question costs tokens, not another
   download. onProgress gets WebLLM's own {text, progress} so the wait tells the
   truth instead of spinning. */
function webModelEngine(onProgress) {
  if (webEngine) return Promise.resolve(webEngine);
  if (webEngineStarting) return webEngineStarting;
  webEngineStarting = webModelLibrary()
    .then((webllm) => webllm.CreateMLCEngine(WEB_MODEL_CARD, {
      initProgressCallback: (p) => onProgress?.(p?.text || "", p?.progress),
    }))
    .then((engine) => { webEngine = engine; webEngineStarting = null; return engine; })
    .catch((err) => { webEngineStarting = null; throw err; });
  return webEngineStarting;
}

async function webModelOnDevice() {
  if (typeof caches !== "object" || !caches) return false;
  const cache = await caches.open(WEB_MODEL_CACHE);
  return (await cache.keys()).some(req => req.url.includes(WEB_MODEL_CARD));
}

/* The whole origin's holding, because the Cache API gives no per-entry size
   back; it is labelled as such in Settings rather than passed off as the
   model's own weight. */
async function webModelUsage() {
  try {
    const est = await navigator.storage?.estimate();
    return est?.usage ? Math.round(est.usage / 1e6) : null;
  } catch { return null; }
}

async function webModelForget() {
  if (webEngine) {
    try { await webEngine.unload(); } catch { /* already gone */ }
    webEngine = null;
  }
  if (typeof caches !== "object" || !caches) return;
  const cache = await caches.open(WEB_MODEL_CACHE);
  const keys = await cache.keys();
  await Promise.all(keys
    .filter(req => req.url.includes(WEB_MODEL_CARD))
    .map(req => cache.delete(req)));
}

/* The answer arrives as a real token stream, so the caller's onToken sees the
   same shape it sees from any hosted provider. */
async function webModelAsk(messages, onToken, opts = {}) {
  const { signal, onProgress } = opts;
  const engine = await webModelEngine(onProgress);
  const interrupt = () => { engine.interruptGenerate?.().catch(() => {}); };
  signal?.addEventListener("abort", interrupt, { once: true });
  let text = "";
  try {
    const stream = await engine.chat.completions.create({
      messages, stream: true, max_tokens: WEB_MODEL_MAX_TOKENS, temperature: 0.7,
    });
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (delta) { text += delta; onToken?.(delta); }
      if (signal?.aborted) break;
    }
  } finally {
    signal?.removeEventListener("abort", interrupt);
  }
  return text;
}

/* WebLLM fails in three distinguishable ways, and which one it is decides what
   the person can actually do next. */
function webModelError(err) {
  const m = String(err?.message || err || "");
  if (/max sequence|seq length|context window|preprocess fill/i.test(m))
    return "This exchange is longer than the small model can hold. Start a new chat, or ask it to work from a shorter part.";
  if (/webgpu|no adapter|gpu device|device lost|webgpu is not supported/i.test(m))
    return "WebGPU did not come up, so no model can run here. Update the browser or close other tabs that are using the graphics card.";
  if (/fetch|network|failed to load|failed to fetch|opfs|storage/i.test(m))
    return "The model files did not arrive. The first download needs the internet, and enough free space on this device.";
  return m.slice(0, 200) || "The browser model did not start.";
}
