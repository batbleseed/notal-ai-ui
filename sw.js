/* Notal AI service worker — offline shell for the landing page and the app. */
const CACHE = "notal-ai-v22";
const CORE = [
  "./",
  "./index.html",
  "./chat/index.html",
  "./styles.css",
  "./app.js",
  "./prompts.js",
  "./syntax.js",
  "./webmodel.js",
  "./gsap.min.js",
  "./icons/favicon-32.png",
  "./icons/notal-petals.png",
  "./icons/notal-core.png",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  /* addAll would happily store whatever the HTTP cache already held, which is
     how a fixed stylesheet stayed invisible for a whole release */
  const reqs = CORE.map(href => new Request(href, { cache: "reload" }));
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(reqs.map(r => c.put(r, fetch(r)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      /* WebLLM keeps the model weights in this same origin's cache; clearing
         them would throw away a 290 MB download on every release */
      if (key.startsWith("webllm/")) continue;
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || !req.url.startsWith(self.location.origin)) return;

  // pages: fresh from the network when online, cached copy when offline
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const res = await fetch(new Request(req, { cache: "reload" }));
        const c = await caches.open(CACHE);
        c.put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req)) || (await caches.match("./chat/index.html")) || Response.error();
      }
    })());
    return;
  }

  // Code must stay fresh: an installed app otherwise never sees a fix.
  // Images are stable, so serve those from cache first.
  const url = new URL(req.url);
  if (/\.(png|ico|svg|webp)$/.test(url.pathname)) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    })());
    return;
  }

  e.respondWith((async () => {
    try {
      /* cache:'reload' — a plain fetch(req) can be answered by the HTTP cache
         without touching the network at all, and then "fresh from the network"
         is only a comment */
      const res = await fetch(new Request(req, { cache: "reload" }));
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch {
      return (await caches.match(req)) || Response.error();
    }
  })());
});
