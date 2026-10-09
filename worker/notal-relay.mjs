/**
 * Notal AI provider relay — a thin, allow-listed forwarder.
 *
 * Why this exists: the big providers answer browser calls directly, but plenty
 * of OpenAI-compatible servers send no CORS headers at all, and a browser
 * refuses those. Going through the relay keeps the request shape identical, so
 * the app works whether the relay is configured or not.
 *
 * The relay never sees an account and never stores anything: it forwards the
 * caller's own key to a host on the allow-list and returns the provider's
 * response, status included. It can also read one public web page for the app
 * (POST /browse), because sites send no CORS header for their own HTML.
 *
 * Deploy: Cloudflare dashboard → Workers → Create → paste this file, or
 * `wrangler deploy` with the included wrangler.toml.
 */

const ALLOWED_HOSTS = new Set([
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.groq.com",
  "openrouter.ai",
  "api.deepseek.com",
  "api.mistral.ai",
  "api.together.xyz",
  "api.fireworks.ai",
  "api.cohere.com",
  "ollama.com",
  // a relay running on this machine can also serve a local Ollama;
  // the app never sends local targets to a remote relay
  "localhost",
  "127.0.0.1",
]);

// only these request headers are ever forwarded upstream
const FORWARD_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "anthropic-version",
  "content-type",
]);

const MAX_BODY_BYTES = 12 * 1024 * 1024;   // room for base64 image attachments
const UPSTREAM_TIMEOUT_MS = 90_000;

const json = (obj, init = {}) =>
  new Response(JSON.stringify(obj), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const configured = (env.RELAY_ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);

  let allow = null;
  if (configured.includes("*")) allow = "*";
  else if (origin) {
    let host = "";
    try { host = new URL(origin).hostname; } catch { /* not a URL */ }
    const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    const pages = host.endsWith(".github.io") || host.endsWith(".pages.dev");
    if (local || pages || configured.includes(origin)) allow = origin;
  }
  if (!allow) return {};
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": "content-type,x-notal-relay",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "600",
    "vary": "Origin",
  };
}

function extraHosts(env) {
  return (env.RELAY_ALLOWED_HOSTS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function targetError(url, env) {
  let parsed;
  try { parsed = new URL(url); } catch { return "target url is not valid"; }
  if (parsed.protocol !== "https:") {
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (!local) return "only https targets are allowed";
  }
  const allowed = new Set([...ALLOWED_HOSTS, ...extraHosts(env)]);
  if (!allowed.has(parsed.hostname.toLowerCase()))
    return `host "${parsed.hostname}" is not on the relay allow-list`;
  return null;
}

// The timeout covers only the wait for the provider's headers. Applying it to
// the whole exchange would cut off a long streamed reply mid-sentence.
function fetchToHeaders(url, init, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`upstream did not answer within ${ms}ms`);
      err.name = "TimeoutError";
      reject(err);
    }, ms);
    const stop = (fn) => (arg) => { clearTimeout(timer); fn(arg); };
    fetch(url, init).then(stop(resolve), stop(reject));
  });
}

async function handleRelay(request, env, cors) {
  let envelope;
  try { envelope = await request.json(); }
  catch { return json({ error: { message: "relay expects a JSON envelope" } }, { status: 400, headers: cors }); }

  const { url, method = "POST", headers = {}, body } = envelope || {};
  if (typeof url !== "string")
    return json({ error: { message: "relay needs a target url" } }, { status: 400, headers: cors });

  const bad = targetError(url, env);
  if (bad) return json({ error: { message: bad } }, { status: 403, headers: cors });

  if (body === undefined || body === null || typeof body !== "object")
    return json({ error: { message: "relay needs a JSON body object" } }, { status: 400, headers: cors });
  const payload = JSON.stringify(body);
  if (payload.length > MAX_BODY_BYTES)
    return json({ error: { message: "payload too large for the relay" } }, { status: 413, headers: cors });

  const upstreamHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (FORWARD_HEADERS.has(k.toLowerCase()) && typeof v === "string" && v)
      upstreamHeaders[k] = v;
  }
  if (!upstreamHeaders["content-type"]) upstreamHeaders["content-type"] = "application/json";

  let upstream;
  try {
    upstream = await fetchToHeaders(url, {
      method,
      headers: upstreamHeaders,
      body: method === "GET" ? undefined : payload,
    }, UPSTREAM_TIMEOUT_MS);
  } catch (err) {
    const reason = err?.name === "TimeoutError" ? "timed out" : "could not be reached";
    return json({ error: { message: `Provider ${reason}` } }, { status: 502, headers: cors });
  }

  // The body goes through untouched. Buffering it here would hold a streamed
  // reply until the end and the caller would see the whole answer at once.
  const replyHeaders = { ...cors, "x-relay": "notal" };
  const contentType = upstream.headers.get("content-type");
  if (contentType) replyHeaders["content-type"] = contentType;
  for (const name of ["cache-control", "retry-after", "x-request-id"]) {
    const value = upstream.headers.get(name);
    if (value) replyHeaders[name] = value;
  }
  const empty = upstream.status === 204 || upstream.status === 304;
  return new Response(empty ? null : upstream.body, { status: upstream.status, headers: replyHeaders });
}

/* ---------- browsing public pages ----------
   The app can fetch a page itself, but almost no site sends a CORS header for
   its HTML, so a browser tab is refused. This endpoint does the one thing the
   tab cannot: read a public page and hand the text back. Nothing is stored. */
const MAX_PAGE_BYTES = 400 * 1024;
const BROWSE_TIMEOUT_MS = 25_000;

function isPrivateHost(host) {
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")
      || host.endsWith(".lan") || host.endsWith(".corp") || !host.includes(".")) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return a >= 224;                       // multicast and reserved blocks
  }
  const v6 = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (v6.includes(":")) {
    if (v6 === "::" || v6 === "::1") return true;
    return /^f[cd]/.test(v6) || /^fe[89abc]/.test(v6);  // unique-local, link-local
  }
  return false;
}

function browseTargetError(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return "browse url is not valid"; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    return "only http and https pages can be browsed";
  if (isPrivateHost(parsed.hostname.toLowerCase()))
    return "that address is not a public page";
  return null;
}

/* A page is capped while it streams in, so a site that sends 40 MB of video
   chunks cannot make the Worker hold them. */
async function readCapped(res, maxBytes) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8");
  let out = "", bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value?.byteLength || 0;
    out += decoder.decode(value, { stream: true });
    if (bytes > maxBytes) { await reader.cancel(); break; }
  }
  return out;
}

async function handleBrowse(request, cors) {
  let input;
  try { input = await request.json(); }
  catch { return json({ ok: false, error: "browse expects JSON like {\"url\":\"https://…\"}" },
    { status: 400, headers: cors }); }

  const url = typeof input?.url === "string" ? input.url.trim() : "";
  const bad = browseTargetError(url);
  if (bad) return json({ ok: false, error: bad }, { status: 403, headers: cors });

  let page;
  try {
    page = await fetchToHeaders(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "user-agent": "NotalAI/1.0 (+in-app reader; asks permission by URL)",
      },
    }, BROWSE_TIMEOUT_MS);
  } catch (err) {
    const reason = err?.name === "TimeoutError" ? "timed out" : "could not be reached";
    return json({ ok: false, error: `The page ${reason}` }, { status: 502, headers: cors });
  }

  if (page.status >= 400)
    return json({ ok: false, status: page.status, error: `the site answered ${page.status}` },
      { headers: cors });

  const contentType = page.headers.get("content-type") || "";
  if (contentType && !/(text|html|json|xml|javascript)/i.test(contentType))
    return json({ ok: false, status: page.status, contentType,
      error: `that is not a text page (${contentType.split(";")[0]})` }, { headers: cors });

  const html = await readCapped(page, MAX_PAGE_BYTES);
  if (!html.trim()) return json({ ok: false, error: "the page came back empty" }, { headers: cors });

  return json({ ok: true, status: page.status, url: page.url || url, contentType, html },
    { headers: { ...cors, "x-relay": "notal" } });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });

    if (pathname === "/health")
      return json({ ok: true, relay: "notal", hosts: ALLOWED_HOSTS.size, browse: true },
        { headers: cors });

    if (pathname === "/browse") {
      if (request.method !== "POST")
        return json({ error: { message: "browse is a POST endpoint" } }, { status: 405, headers: cors });
      return handleBrowse(request, cors);
    }

    if (pathname !== "/relay" || request.method !== "POST")
      return json({ error: { message: "unknown endpoint — use POST /relay, POST /browse or GET /health" } },
        { status: 404, headers: cors });

    return handleRelay(request, env, cors);
  },
};
