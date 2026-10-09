/* The relay Notal AI Studio runs for itself, on this machine.

   The web app talks to providers through a Cloudflare Worker because a browser
   tab is not allowed to: sites send no CORS header, so the tab's own request is
   refused. A desktop app has no such rule — this file is the same idea, served
   from 127.0.0.1, and it answers exactly like worker/notal-relay.mjs does so the
   app cannot tell the difference:

     POST /relay    forward one provider call, body untouched, stream preserved
     POST /browse   read one public page and hand the HTML back
     GET  /health   say what this relay is

   Three things this does better than the hosted relay, because it is local:
   - your API keys never leave the machine;
   - a streamed reply arrives token by token instead of all at once;
   - any https host is allowed, so a self-hosted or unusual provider works, and a
     local Ollama at 127.0.0.1:11434 is reachable. */
"use strict";
const { Readable } = require("stream");

const ALLOWED_HOSTS = new Set([
  "api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com",
  "api.groq.com", "openrouter.ai", "api.deepseek.com", "api.mistral.ai",
  "api.together.xyz", "api.fireworks.ai", "api.cohere.com", "ollama.com",
]);

/* Only these request headers are ever forwarded upstream, so a stray cookie or
   an authorization header meant for another site cannot ride along. */
const FORWARD_HEADERS = new Set([
  "authorization", "x-api-key", "x-goog-api-key", "anthropic-version",
  "anthropic-beta", "content-type", "openai-organization", "openai-project",
]);

const MAX_BODY_BYTES = 12 * 1024 * 1024;   // room for base64 image attachments
const UPSTREAM_TIMEOUT_MS = 90_000;         // headers only — never a whole stream
const MAX_PAGE_BYTES = 400 * 1024;
const BROWSE_TIMEOUT_MS = 25_000;

const json = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-notal-relay": "studio",
  });
  res.end(body);
};

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

function isLocalHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/* A relay anyone on the network could reach has to be strict. This one listens
   on loopback only, and the caller is the person who owns the machine, so any
   https endpoint is fair game — that is what makes a self-hosted model server
   work without editing an allow-list. http stays local-only, so a plain-text
   request can never leave the machine by accident. */
function relayTargetError(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return "target url is not valid"; }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && isLocalHost(parsed.hostname.toLowerCase())) return null;
  return "the studio relay only forwards https targets, or http to this machine";
}

/* A page is a page: reading the user's own router or a service on their LAN is
   not what the in-app reader is for, so private addresses stay out. */
function isPrivateHost(host) {
  if (isLocalHost(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")
      || host.endsWith(".corp") || !host.includes(".")) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return a >= 224;
  }
  const v6 = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (v6.includes(":")) {
    if (v6 === "::" || v6 === "::1") return true;
    return /^f[cd]/.test(v6) || /^fe[89abc]/.test(v6);
  }
  return false;
}

function browseTargetError(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return "browse url is not valid"; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    return "only http and https pages can be browsed";
  if (isPrivateHost(parsed.hostname.toLowerCase())) return "that address is not a public page";
  return null;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (c) => {
      bytes += c.length;
      if (bytes > maxBytes) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const text = await readBody(req, MAX_BODY_BYTES);
  if (!text.trim()) return {};
  return JSON.parse(text);
}

/* The timer covers only the wait for the upstream's headers. Applying it to the
   whole exchange would cut a long streamed reply off mid-sentence. */
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

async function handleRelay(req, res) {
  let envelope;
  try { envelope = await readJsonBody(req); }
  catch { return json(res, 400, { error: { message: "relay expects a JSON envelope" } }); }

  const { url, method = "POST", headers = {}, body } = envelope || {};
  if (typeof url !== "string")
    return json(res, 400, { error: { message: "relay needs a target url" } });
  const bad = relayTargetError(url);
  if (bad) return json(res, 403, { error: { message: bad } });
  if (body === undefined || body === null || typeof body !== "object")
    return json(res, 400, { error: { message: "relay needs a JSON body object" } });

  const payload = JSON.stringify(body);
  if (payload.length > MAX_BODY_BYTES)
    return json(res, 413, { error: { message: "payload too large for the relay" } });

  const upstreamHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (FORWARD_HEADERS.has(k.toLowerCase()) && typeof v === "string" && v) upstreamHeaders[k] = v;
  }
  if (!upstreamHeaders["content-type"]) upstreamHeaders["content-type"] = "application/json";

  let upstream;
  try {
    upstream = await fetchToHeaders(url, {
      method,
      headers: upstreamHeaders,
      body: method === "GET" || method === "HEAD" ? undefined : payload,
    }, UPSTREAM_TIMEOUT_MS);
  } catch (err) {
    const reason = err?.name === "TimeoutError" ? "timed out" : "could not be reached";
    return json(res, 502, { error: { message: `Provider ${reason}` } });
  }

  /* The body goes through as it arrives. Buffering it here is what makes a
     hosted relay feel like it answers all at once — locally there is no reason
     to do that, so the typewriter effect stays a typewriter. */
  const replyHeaders = { "x-notal-relay": "studio" };
  const contentType = upstream.headers.get("content-type");
  if (contentType) replyHeaders["content-type"] = contentType;
  for (const name of ["cache-control", "retry-after", "x-request-id"]) {
    const value = upstream.headers.get(name);
    if (value) replyHeaders[name] = value;
  }
  const empty = upstream.status === 204 || upstream.status === 304 || method === "HEAD";
  if (empty || !upstream.body) { res.writeHead(upstream.status, replyHeaders); return res.end(); }

  res.writeHead(upstream.status, replyHeaders);
  const nodeStream = Readable.fromWeb(upstream.body);
  nodeStream.on("error", () => res.destroy());
  res.on("close", () => nodeStream.destroy());
  nodeStream.pipe(res);
}

async function handleBrowse(req, res) {
  let input;
  try { input = await readJsonBody(req); }
  catch { return json(res, 400, { ok: false, error: 'browse expects JSON like {"url":"https://…"}' }); }

  const url = typeof input?.url === "string" ? input.url.trim() : "";
  const bad = browseTargetError(url);
  if (bad) return json(res, 403, { ok: false, error: bad });

  let page;
  try {
    page = await fetchToHeaders(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "user-agent": "NotalAI/2.0 (+in-app reader; asks permission by URL)",
      },
    }, BROWSE_TIMEOUT_MS);
  } catch (err) {
    const reason = err?.name === "TimeoutError" ? "timed out" : "could not be reached";
    return json(res, 502, { ok: false, error: `The page ${reason}` });
  }

  if (page.status >= 400)
    return json(res, 200, { ok: false, status: page.status, error: `the site answered ${page.status}` });

  const contentType = page.headers.get("content-type") || "";
  if (contentType && !/(text|html|json|xml|javascript)/i.test(contentType))
    return json(res, 200, { ok: false, status: page.status, contentType,
      error: `that is not a text page (${contentType.split(";")[0]})` });

  /* Capped while it arrives, the same way the Worker does it: a site that sends
     a hundred megabytes of video chunks cannot make this app hold them. */
  let html = "", bytes = 0;
  if (page.body) {
    const stream = Readable.fromWeb(page.body);
    const decoder = new TextDecoder("utf-8");
    for await (const chunk of stream) {
      bytes += chunk.length;
      html += decoder.decode(Buffer.from(chunk), { stream: true });
      if (bytes > MAX_PAGE_BYTES) { stream.destroy(); break; }
    }
    html += decoder.decode();
  }
  if (!html.trim()) return json(res, 200, { ok: false, error: "the page came back empty" });
  return json(res, 200, { ok: true, status: page.status, url: page.url || url, contentType, html });
}

/* A local Ollama is the one model server that answers on this machine without a
   key, so the app can list what is installed instead of guessing. */
async function handleOllama(req, res) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const r = await fetch("http://127.0.0.1:11434/api/tags", { signal: controller.signal });
    const data = await r.json();
    json(res, 200, { running: true, models: (data.models || []).map(m => ({
      name: m.name, size: m.size,
      modified: m.modified_at ? new Date(m.modified_at * 1000).toISOString().slice(0, 10) : null,
    })) });
  } catch {
    json(res, 200, { running: false, models: [] });
  } finally {
    clearTimeout(timer);
  }
}

function handleHealth(res, info) {
  json(res, 200, {
    ok: true, relay: "notal", browse: true, hosts: ALLOWED_HOSTS.size,
    studio: info, "x-notal-relay": "studio",
  });
}

module.exports = { handleRelay, handleBrowse, handleOllama, handleHealth, json };
