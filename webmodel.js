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
const WEB_MODEL_NAME = "local ai";
const WEB_MODEL_MB = 290;
const WEB_MODEL_MAX_TOKENS = 512;
/* Where WebLLM keeps what it downloads under the default "cache" backend: the
   weights, the chat config, and the compiled library it runs them with. A
   download is only finished when all three are here, so all three are checked. */
const WEB_MODEL_SCOPES = ["webllm/model", "webllm/config", "webllm/wasm"];

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

function webCache() {
  return typeof caches === "object" && caches ? caches : null;
}

/* Every entry this card has across the three scopes, with its real size. The
   Cache API keeps Content-Length on the stored response, so the MB figure is
   measured rather than the number the model card advertises. */
async function webModelFiles() {
  const c = webCache();
  if (!c) return { files: 0, bytes: 0 };
  let files = 0, bytes = 0;
  for (const scope of WEB_MODEL_SCOPES) {
    const cache = await c.open(scope);
    for (const req of await cache.keys()) {
      if (!req.url.includes(WEB_MODEL_CARD)) continue;
      const res = await cache.match(req);
      const len = Number(res?.headers?.get("content-length")) || 0;
      files++;
      bytes += len;
    }
  }
  return { files, bytes };
}

/* The weights are the download; the config and the library are a few hundred KB
   beside them. Presence means the shards are here, which is the only part worth
   asking someone to wait for. */
async function webModelOnDevice() {
  const c = webCache();
  if (!c) return false;
  const cache = await c.open(WEB_MODEL_SCOPES[0]);
  return (await cache.keys()).some(req => req.url.includes(WEB_MODEL_CARD));
}

/* What this card actually occupies, in MB, measured from the stored responses.
   Null when nothing of it is here — the caller then quotes the advertised size
   and says so. */
async function webModelBytes() {
  const { bytes } = await webModelFiles();
  return bytes ? Math.round(bytes / 1e6) : null;
}

/* Deleting through WebLLM's own helper, because it knows which of the three
   scopes a given version writes to. The cache sweep is the fallback for a
   release where the helper is missing or throws halfway through. */
async function webModelForget() {
  if (webEngine) {
    try { await webEngine.unload(); } catch { /* already gone */ }
    webEngine = null;
  }
  const webllm = await webModelLibrary().catch(() => null);
  if (webllm?.deleteModelAllInfoInCache) {
    try { await webllm.deleteModelAllInfoInCache(WEB_MODEL_CARD); } catch { /* fall through */ }
  }
  const c = webCache();
  if (!c) return;
  for (const scope of WEB_MODEL_SCOPES) {
    const cache = await c.open(scope);
    const keys = await cache.keys();
    await Promise.all(keys
      .filter(req => req.url.includes(WEB_MODEL_CARD))
      .map(req => cache.delete(req)));
  }
}

/* The answer arrives as a real token stream, so the caller's onToken sees the
   same shape it sees from any hosted provider — and the counts come from the
   runtime, not from a guess made by watching how fast text appeared. */
async function webModelAsk(messages, onToken, opts = {}) {
  const { signal, onProgress } = opts;
  const engine = await webModelEngine(onProgress);
  const interrupt = () => { engine.interruptGenerate?.().catch(() => {}); };
  signal?.addEventListener("abort", interrupt, { once: true });
  const startedAt = Date.now();
  let text = "";
  let firstTokenMs = null;
  let usage = null;
  try {
    const stream = await engine.chat.completions.create({
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: WEB_MODEL_MAX_TOKENS,
      temperature: 0.7,
    });
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (delta) {
        if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
        text += delta;
        onToken?.(delta);
      }
      if (signal?.aborted) break;
    }
  } finally {
    signal?.removeEventListener("abort", interrupt);
  }
  return {
    text,
    elapsedMs: Date.now() - startedAt,
    firstTokenMs,
    completionTokens: usage?.completion_tokens ?? null,
    promptTokens: usage?.prompt_tokens ?? null,
  };
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
