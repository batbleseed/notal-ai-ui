/* Run the relay locally, exactly as Cloudflare would: node worker/dev-relay.mjs [port] */
import http from "node:http";
import worker from "./notal-relay.mjs";

const PORT = Number(process.argv[2] || 8787);
const env = {
  RELAY_ALLOWED_HOSTS: process.env.RELAY_ALLOWED_HOSTS || "",
  RELAY_ALLOWED_ORIGINS: process.env.RELAY_ALLOWED_ORIGINS || "",
};

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined,
  });
  try {
    const out = await worker.fetch(request, env, {});
    res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
    res.end(await out.text());
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(err?.message || err) } }));
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`notal relay (dev) → http://127.0.0.1:${PORT}/health`);
});
