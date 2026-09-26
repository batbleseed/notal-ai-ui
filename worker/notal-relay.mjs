/**
 * Notal AI provider relay — a thin, allow-listed forwarder.
 *
 * Why this exists: browsers cannot call most LLM APIs directly (CORS blocks
 * them), and this way the request shape stays identical, so the app works
 * whether the relay is configured or not.
 *
 * The relay never sees an account and never stores anything: it forwards the
 * caller's own key to a host on the allow-list and returns the provider's
 * response, status included.
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
    upstream = await fetch(url, {
      method,
      headers: upstreamHeaders,
      body: method === "GET" ? undefined : payload,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err?.name === "TimeoutError" ? "timed out" : "could not be reached";
    return json({ error: { message: `Provider ${reason}` } }, { status: 502, headers: cors });
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      ...cors,
      "x-relay": "notal",
    },
  });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });

    if (pathname === "/health")
      return json({ ok: true, relay: "notal", hosts: ALLOWED_HOSTS.size }, { headers: cors });

    if (pathname !== "/relay" || request.method !== "POST")
      return json({ error: { message: "unknown endpoint — use POST /relay or GET /health" } },
        { status: 404, headers: cors });

    return handleRelay(request, env, cors);
  },
};
