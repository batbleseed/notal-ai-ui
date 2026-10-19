/* Notal AI — the bridge that runs inside Notal's own tab.

   The page cannot reach the browser, and the extension cannot reach the page, so
   this small relay stands in the one place both can: it is injected only into the
   origins the manifest lists (this app, on localhost or from disk), which is what
   keeps any other site from giving the extension orders. It moves messages and
   nothing else — no page reading, no decisions. Whether an action happens at all
   is settled by the approval card in Notal, before a message like this is ever
   sent. */

(() => {
  if (window.__notalBridge) return;
  window.__notalBridge = true;

  window.addEventListener("message", (e) => {
    const d = e.data;
    /* a reply is on its way back to the page when it carries replyTo, and this
       listener would otherwise answer its own answer */
    if (!d || d.notalPlugin !== 1 || d.replyTo || !d.id || !d.method) return;
    if (e.source !== window) return;

    let send;
    try { send = chrome.runtime.sendMessage({ notalPlugin: 1, ...d }); }
    catch { send = Promise.reject(new Error("this companion was updated or removed — reload the page to pick up the new one")); }

    const answer = (payload) => {
      try {
        window.postMessage({ notalPlugin: 1, replyTo: d.id, ...payload }, e.origin || "*");
      } catch { /* the page navigated away mid-call */ }
    };
    send.then(
      (result) => answer({ ok: true, result }),
      (err) => answer({ ok: false, error: String(err?.message || err) })
    );
  });
})();
