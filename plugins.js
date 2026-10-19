/* Notal AI — plugins. A plugin is a thing the model can make this app do, out
   in the world, and get a real answer back from. It is not an extension: an
   extension only changes what the model is told, while a plugin gives it a hand.
   Everything the model asks for goes through the same gate — a write is shown to
   the user and does not happen until they approve it — and the result handed back
   is whatever the service actually said, including when it said no.

   Loaded as a plain script before app.js, and it uses nothing from app.js at
   load time, so this file can be read on its own. Each plugin's calls go straight
   from this tab to the service with the user's own token, which the relay never
   carries — the one exception is GitHub's sign-in exchange, because GitHub's own
   token endpoints answer no browser, and even then the relay sees the request
   that asks for a token, never the token afterwards. */

/* How to address a plugin, spelled once here rather than in every plugin brief.
   The shape matches [browse], which the model already knows how to use. */
const PLUGIN_PROTOCOL = `

## Acting in the world with plugins

A plugin is enabled in Settings → Plugins, and each one gives you actions you may
call. To call one, put the tag below on its own line and stop writing there — do
not answer the question yet:

[tool:plugin.action]{"arg":"value"}[/tool]

The body is one JSON object, and it must parse. Rules:
- One action per turn, and never two tags in one message.
- The app runs it and hands you what the service actually returned, so do not
  invent a result and do not describe an action you have not been told succeeded.
- An action marked "will ask the user first" pauses for approval. If the app
  reports the user declined, accept that: say what you would have done and stop,
  or offer a safe alternative. Never call the same action again hoping for yes.
- If a call fails, the message you get back is the service's own. Repeat it
  plainly rather than retrying, unless the fix is yours to make — a wrong path,
  a bad argument — in which case correct it and call once more.
- Do not call a plugin for something you already know. Reading is for facts that
  live in the repository, not for facts about repositories in general.`;

/* ---------- GitHub sign-in ----------
   A personal access token works, but making one means opening a settings page,
   choosing scopes, and pasting a secret into a form — and a pasted secret is a
   thing that outlives the reason it was made for. GitHub's device flow is what
   they document for an app with no server of its own: this tab asks GitHub for a
   short code, the user types it at github.com/login/device once, and GitHub
   returns a token tied to their own login and to the scopes of the OAuth app
   they gave the client ID for. It comes with an expiry and a refresh token, so
   nothing here holds a key that GitHub has already revoked.

   Those two endpoints send no CORS header, which is the one thing a tab cannot
   get around, so the exchange is carried by the app's relay. The relay forwards
   only these fixed URLs and only the fields this flow defines, and the token it
   brings back is stored in this browser and sent afterwards to api.github.com
   alone — the relay never sees it, because the exchange is all it ever touches. */
const GH_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/* A device-flow token lasts eight hours. This is how early to trade the refresh
   token for a new one, so a call is never cut off halfway through. */
const GH_REFRESH_MARGIN_MS = 10 * 60 * 1000;

/* Filled in by app.js when it loads: where the relay is, and how to keep what
   sign-in brings back. Declared here so this file still reads and parses alone. */
const pluginHooks = { relay: () => "", persist: () => {} };

async function githubRelayStep(step, fields) {
  const base = pluginHooks.relay();
  if (!base) throw new Error(
    "GitHub's own sign-in pages answer no browser, so the exchange needs the app's relay. " +
    "Put a relay address in Settings → Providers, or save a personal access token below instead.");
  const res = await fetch(`${base}/github`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step, fields }),
  });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error(`${base}/github answered ${res.status} with something that is not JSON`); }
  /* GitHub's own answers — refusals included, and it answers a wrong client ID
     with a 404 — belong to the caller to read. Only the relay's own refusals,
     which it marks, end the call here. */
  if (payload?.refused_by) throw new Error(payload.error || `the relay refused the request (${res.status})`);
  if (!res.ok && payload?.error === undefined)
    throw new Error(`the relay answered ${res.status}${payload?.message ? `: ${payload.message}` : ""}`);
  return payload;
}

/* A wait the user can cancel: pressing Stop in the chat, or closing Settings,
   should not leave a poll running until the code expires on its own. */
function ghWait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", giveUp);
      resolve();
    }, ms);
    const giveUp = () => {
      clearTimeout(timer);
      reject(new DOMException("stopped before GitHub was signed into", "AbortError"));
    };
    signal?.addEventListener?.("abort", giveUp, { once: true });
  });
}

function rememberGithubToken(cfg, r) {
  cfg.oauth = {
    token: r.access_token,
    refresh: r.refresh_token || "",
    expiresAt: r.expires_in ? Date.now() + Number(r.expires_in) * 1000 : 0,
    scopes: (r.scope || "").split(",").filter(Boolean),
    login: "",
  };
  pluginHooks.persist();
  return cfg.oauth;
}

/* The scopes are asked for here, at sign-in, because an OAuth App's settings page
   has no scope picker — GitHub decides that per request. public_repo is the
   default so a token sitting in a browser cannot reach anything private unless
   the person using it typed that in on purpose. */
function ghScopes(cfg) {
  return String(cfg.scopes || "").trim() || "public_repo";
}

async function githubSignIn(cfg, onStatus, signal) {
  const clientId = String(cfg.clientId || "").trim();
  if (!clientId) throw new Error("Notal signs in with an OAuth app of your own, so its client ID goes in the field above.");

  const start = await githubRelayStep("device", { client_id: clientId, scope: ghScopes(cfg) });
  if (start.error)
    throw new Error(`GitHub would not hand out a code: ${start.error_description || start.error}. ` +
      "Check the client ID, and that Device Flow is switched on for that OAuth app.");
  if (!start.device_code || !start.user_code)
    throw new Error("GitHub answered the code request with something that had no code in it.");

  const link = start.verification_uri_complete || start.verification_uri || "https://github.com/login/device";
  onStatus?.({ stage: "code", code: start.user_code, link });

  let waitMs = Math.max(Number(start.interval) || 5, 2) * 1000;
  const deadline = Date.now() + (Number(start.expires_in) || 900) * 1000;
  for (;;) {
    await ghWait(waitMs, signal);
    const r = await githubRelayStep("token", {
      client_id: clientId,
      device_code: start.device_code,
      grant_type: GH_DEVICE_GRANT,
    });
    if (r.access_token) {
      const saved = rememberGithubToken(cfg, r);
      /* the login is what the readout says back to the user, and it is the one
         thing the token response does not include */
      try { saved.login = (await githubApi("/user", cfg, { signal }, signal))?.login || ""; }
      catch { /* a token that works later is still a token */ }
      pluginHooks.persist();
      onStatus?.({ stage: "done", login: saved.login });
      return saved;
    }
    switch (r.error) {
      case "authorization_pending": break;
      case "slow_down": waitMs += 5000; break;
      case "expired_token":
        throw new Error("That code ran out before it was used. Press Sign in again for a fresh one.");
      case "access_denied":
        throw new Error("The sign-in was declined at GitHub.");
      case "device_flow_disabled":
        throw new Error("That OAuth app has Device Flow switched off — turn it on in GitHub's application settings, or save a token instead.");
      default:
        throw new Error(`GitHub refused the token (${r.error || "no reason given"})` +
          (r.error_description ? `: ${r.error_description}` : ""));
    }
    if (Date.now() > deadline)
      throw new Error("GitHub's code expired before anyone entered it. Press Sign in again.");
  }
}

function githubSignOut(cfg) {
  cfg.oauth = null;
  pluginHooks.persist();
}

/* The token to send, asked for rather than assumed: an OAuth sign-in wins over a
   pasted token, and an OAuth token that has run out is traded for a new one
   before it is used. */
async function githubAccessToken(cfg, signal) {
  const o = cfg.oauth;
  if (!o?.token) return String(cfg.token || "").trim();
  if (!o.expiresAt || Date.now() < o.expiresAt - GH_REFRESH_MARGIN_MS) return o.token;
  if (!o.refresh)
    throw new Error("The GitHub sign-in has run out and there is nothing to renew it with — sign in again.");
  if (!String(cfg.clientId || "").trim())
    throw new Error("The GitHub sign-in needs its OAuth client ID to renew — put it back in the field above.");
  const r = await githubRelayStep("refresh", {
    client_id: String(cfg.clientId).trim(),
    refresh_token: o.refresh,
    grant_type: "refresh_token",
  });
  if (!r.access_token)
    throw new Error(`GitHub would not renew the sign-in (${r.error || "no reason given"}) — sign in again.`);
  /* GitHub only sends a new refresh token when it has rotated one; the old pair
     is still valid until the expiry it was given, so it stays */
  Object.assign(o, {
    token: r.access_token,
    refresh: r.refresh_token || o.refresh,
    expiresAt: r.expires_in ? Date.now() + Number(r.expires_in) * 1000 : 0,
  });
  pluginHooks.persist();
  return o.token;
}

/* ---------- GitHub ----------
   Five calls against api.github.com, which answers browser origins directly. The
   push is a real commit: blobs, one tree, one commit, then the ref moves — the
   same four requests the desktop client makes, so more than one file lands in
   one commit instead of one commit per file. */

async function githubApi(path, cfg, init, signal) {
  const token = await githubAccessToken(cfg, signal);
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    signal,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      /* an empty Bearer header is a rejected request, and public reads need no
         token at all — so one is only sent when there is one to send */
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
  const raw = await res.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; }
  catch { /* a proxy or a login page can answer instead of the API */ }
  if (!res.ok) {
    const detail = body?.message || raw.slice(0, 200) || res.statusText;
    /* 404 on a private repo is GitHub hiding it from a token without access, and
       "not found" would send the model off to check its spelling */
    if (res.status === 404) throw new Error(`GitHub said 404 — the repository or path does not exist, or this token cannot see it (${detail})`);
    if (res.status === 401) throw new Error(`GitHub rejected this token (401): ${detail}`);
    throw new Error(`GitHub said ${res.status}: ${detail}`);
  }
  return body;
}

function ghLimit(text, chars) {
  const s = String(text ?? "");
  return s.length > chars ? `${s.slice(0, chars)}\n… ${s.length - chars} more characters` : s;
}

/* The push is the only action here that cannot be undone by closing a tab, so
   it states its own consequence in the user's words for the approval card. */
function ghPushSummary(args) {
  const files = Array.isArray(args.files) ? args.files : [];
  const bytes = files.reduce((n, f) => n + (f?.content ? new Blob([f.content]).size : 0), 0);
  const where = `${args.owner}/${args.repo}@${args.branch}`;
  const kb = bytes > 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${bytes} B`;
  const paths = files.map(f => f?.path).filter(Boolean);
  const shown = paths.slice(0, 6).join(", ");
  const rest = paths.length > 6 ? ` and ${paths.length - 6} more` : "";
  return `${files.length} file${files.length === 1 ? "" : "s"} (${kb}) to ${where}: ${shown}${rest}`;
}

async function ghPush(args, cfg, signal) {
  const { owner, repo } = args;
  const branch = args.branch || "main";
  const message = String(args.message || "").trim();
  const files = Array.isArray(args.files) ? args.files : null;
  if (!owner || !repo) throw new Error("owner and repo are both required");
  if (!message) throw new Error("the commit needs a message");
  if (!files?.length) throw new Error("no files to commit");
  if (files.length > 25) throw new Error("more than 25 files in one commit — do it in smaller sets");
  for (const f of files)
    if (typeof f?.path !== "string" || typeof f?.content !== "string")
      throw new Error("every file needs a path and content given as text");

  const repoInfo = await githubApi(`/repos/${owner}/${repo}`, cfg, { signal }, signal);
  const defaultBranch = repoInfo.default_branch || "main";

  /* the branch may not exist yet — a fresh branch off the default one is the
     normal shape of a reviewable change, so that is allowed */
  let headSha = null;
  const ref = await githubApi(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    cfg, { signal }, signal).catch(err => {
      if (/404/.test(err.message)) return null;
      throw err;
    });
  if (ref?.object?.sha) {
    headSha = ref.object.sha;
  } else {
    const base = await githubApi(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
      cfg, { signal }, signal);
    headSha = base?.object?.sha;
    if (!headSha) throw new Error(`could not find the default branch ${defaultBranch} to branch from`);
  }
  const commit = await githubApi(`/repos/${owner}/${repo}/git/commits/${headSha}`, cfg, { signal }, signal);
  const baseTree = commit?.tree?.sha;

  const tree = [];
  for (const f of files) {
    if (new Blob([f.content]).size > 400 * 1024)
      throw new Error(`${f.path} is over 400 kB — the plugin commits text, not large assets`);
    const blob = await githubApi(`/repos/${owner}/${repo}/git/blobs`, cfg, {
      method: "POST",
      body: JSON.stringify({ content: f.content, encoding: "utf-8" }),
    }, signal);
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const madeTree = await githubApi(`/repos/${owner}/${repo}/git/trees`, cfg, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTree, tree }),
  }, signal);
  const madeCommit = await githubApi(`/repos/${owner}/${repo}/git/commits`, cfg, {
    method: "POST",
    body: JSON.stringify({ message, tree: madeTree.sha, parents: [headSha] }),
  }, signal);
  /* force stays false: a ref that moved while this was being built should fail
     rather than quietly drop somebody else's commit */
  if (ref) {
    await githubApi(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, cfg, {
      method: "PATCH", body: JSON.stringify({ sha: madeCommit.sha, force: false }),
    }, signal);
  } else {
    await githubApi(`/repos/${owner}/${repo}/git/refs`, cfg, {
      method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: madeCommit.sha }),
    }, signal);
  }

  const url = `https://github.com/${owner}/${repo}/commit/${madeCommit.sha}`;
  const compare = ref ? "" :
    `\nTo review it against ${defaultBranch}: https://github.com/${owner}/${repo}/compare/${defaultBranch}...${branch}?expand=1`;
  return `Committed ${ghPushSummary(args)}\nsha ${madeCommit.sha}\n${url}${compare}`;
}

const GITHUB_PLUGIN = {
  id: "github",
  name: "GitHub",
  desc: "Read a repository, its issues and its files, and commit files back through GitHub's own API. Nothing is cloned: the change is made from this tab, one commit at a time.",
  setup: [
    "On GitHub: Settings → Developer settings → OAuth Apps → New OAuth App. The homepage can be the address this page is on, and the callback URL can stay empty — this sign-in never redirects a browser back here.",
    "Open the app you just made and turn on Device Flow. GitHub leaves it off, and without it GitHub refuses to hand out a code.",
    "Copy that app's Client ID into the field below. The client secret is not needed and never leaves GitHub: the device flow exists for an application that cannot keep one.",
    "That page has no scope picker — GitHub grants scopes per request, not per app — so the scopes are asked for at sign-in instead: public_repo unless you type others below, and Test reads back whatever GitHub actually granted.",
    "Put a relay address in Settings → Providers, or use Notal AI Studio, which ships one. GitHub's code and token endpoints answer no browser tab, so the exchange itself is the one thing this app cannot do alone.",
    "Press Sign in with GitHub, type the code it shows into github.com/login/device, and wait. Nothing else: the token arrives here and renews itself.",
  ],
  signInLabel: "Sign in with GitHub",
  signOutLabel: "Sign out",
  fields: [{
    key: "clientId",
    label: "OAuth app client ID",
    optional: true,
    placeholder: "the public id of your own OAuth app",
    help: "From an OAuth App you make on GitHub, with Device Flow turned on. This one is public by design and is what GitHub shows you at the code screen — it is not a secret and grants nothing by itself.",
  }, {
    key: "scopes",
    label: "Scopes to ask GitHub for",
    optional: true,
    placeholder: "public_repo",
    help: "Asked for at sign-in, not chosen on the OAuth App's page. Left empty it asks for public_repo: enough to read and commit to public repositories, and blind to your private ones. Widen it to repo only if you mean Notal to reach private code.",
  }, {
    key: "token",
    label: "or a personal access token",
    type: "password",
    optional: true,
    placeholder: "github_pat_…",
    help: "The way that needs no relay: make a fine-grained token yourself, scoped to the repositories Notal should touch. Kept in this browser and sent only to api.github.com.",
  }],
  /* one of the two is enough — a signed-in account needs no pasted token, and a
     pasted token works without a relay to sign in through */
  ready(cfg) { return Boolean(cfg.oauth?.token || String(cfg.token || "").trim()); },
  notReady: "Nothing is connected: sign in with GitHub above, or paste a token below if no relay is set.",
  signIn: (cfg, onStatus, signal) => githubSignIn(cfg, onStatus, signal),
  signOut(cfg) { githubSignOut(cfg); },
  /* What the token is, asked of GitHub rather than assumed: a good-looking token
     that belongs to somebody else is exactly what Test is for. */
  async test(cfg) {
    if (!GITHUB_PLUGIN.ready(cfg))
      return { ok: false, message: "Nothing is connected yet — press Sign in with GitHub, or paste a token below." };
    const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(12000) : undefined;
    const me = await githubApi("/user", cfg, { signal }, signal);
    const how = cfg.oauth?.token ? "a sign-in GitHub handed out" : "a token you pasted";
    const scope = cfg.oauth?.scopes?.length ? `, scopes ${cfg.oauth.scopes.join(" ")}` : "";
    const when = cfg.oauth?.expiresAt
      ? `, and it renews itself around ${new Date(cfg.oauth.expiresAt).toLocaleString()}` : "";
    return { ok: true, message: `GitHub answers as ${me.login}${me.name ? ` (${me.name})` : ""} — this works from this browser with ${how}${scope}${when}.` };
  },
  brief: `

### GitHub

Reads run on their own. A push is different: the app shows it to the user and
waits, so ask for it when the change is actually finished, in one call carrying
every file it touches.

- github.repo {"owner":"me","repo":"app"} — what the repository is, its default
  branch, and its visibility.
- github.issues {"owner":"me","repo":"app","state":"open","limit":15} — the
  issues, numbered.
- github.file {"owner":"me","repo":"app","path":"src/app.js","ref":"main"} — the
  file's real contents, which is how you change code you have not seen.
- github.push {"owner":"me","repo":"app","branch":"notal/fix","message":"…",
  "files":[{"path":"src/app.js","content":"the whole new file"}]} — one commit
  holding every file listed. **will ask the user first.**
  Read the file before rewriting it, and send the complete new contents: a commit
  replaces the file, it does not patch it. Prefer a branch over the default one,
  and if the push was declined, the work is done as far as you may take it.`,
  actions: {
    "github.repo": {
      write: false,
      summary: a => `${a.owner}/${a.repo}`,
      async run(a, cfg, signal) {
        const r = await githubApi(`/repos/${a.owner}/${a.repo}`, cfg, { signal }, signal);
        return [
          `${r.full_name} — ${r.description || "no description"}`,
          `default branch ${r.default_branch}, visibility ${r.visibility || (r.private ? "private" : "public")}`,
          `stars ${r.stargazers_count}, open issues ${r.open_issues_count}, last push ${r.pushed_at}`,
          `license ${r.license?.spdx_id || "none"}, size ${r.size} kB`,
        ].join("\n");
      },
    },
    "github.issues": {
      write: false,
      summary: a => `issues in ${a.owner}/${a.repo}`,
      async run(a, cfg, signal) {
        const state = a.state || "open";
        const per = Math.min(Math.max(Number(a.limit) || 15, 1), 50);
        const list = await githubApi(
          `/repos/${a.owner}/${a.repo}/issues?state=${encodeURIComponent(state)}&per_page=${per}`,
          cfg, { signal }, signal);
        if (!list?.length) return `No ${state} issues in ${a.owner}/${a.repo}.`;
        return list.map(i => `#${i.number} ${i.title}${i.pull_request ? " (a pull request)" : ""}` +
          ` — ${i.state}, by ${i.user?.login}, updated ${i.updated_at}`).join("\n");
      },
    },
    "github.file": {
      write: false,
      summary: a => `${a.path} in ${a.owner}/${a.repo}`,
      async run(a, cfg, signal) {
        const ref = a.ref ? `?ref=${encodeURIComponent(a.ref)}` : "";
        const f = await githubApi(
          `/repos/${a.owner}/${a.repo}/contents/${String(a.path).replace(/^\/+/, "")}${ref}`,
          cfg, { signal }, signal);
        if (Array.isArray(f)) return `${a.owner}/${a.repo}:${a.path} is a directory:\n` +
          f.map(x => `${x.type === "dir" ? "d" : "-"} ${x.name} (${x.size} B)`).join("\n");
        if (f.encoding !== "base64") throw new Error("GitHub sent the file in a form this plugin cannot read");
        /* atob gives one character per byte, so multi-byte text needs the decode */
        const bytes = Uint8Array.from(atob(f.content.replace(/\n/g, "")), c => c.charCodeAt(0));
        const text = new TextDecoder().decode(bytes);
        return `${a.owner}/${a.repo}@${f.sha} ${a.path} (${f.size} B):\n\`\`\`\n${ghLimit(text, 6000)}\n\`\`\``;
      },
    },
    "github.push": {
      write: true,
      summary: ghPushSummary,
      run: (a, cfg, signal) => ghPush(a, cfg, signal),
    },
  },
};

/* ---------- browser control ----------
   A page cannot reach another tab, so this half lives in a small extension the
   user installs once (browser-extension/). The extension injects a bridge script
   into Notal's own page — and only there — and this is how the two talk: a
   postMessage carrying an id, and the same id on the way back. Anything the
   extension can do to another site is a write, so it waits for approval first. */

/* file:// has a null origin, and postMessage will not address it, so only that
   case falls back to "*" — every other origin names itself. */
const BRIDGE_TARGET = location.protocol === "file:" ? "*" : location.origin;
const BRIDGE_HELLO_MS = 1200;
const BRIDGE_CALL_MS = 25000;

let bridgeSeq = 0;
const bridgeWaiters = new Map();
let bridgeListener = null;

function bridgeMessage(payload) {
  window.postMessage({ notalPlugin: 1, ...payload }, BRIDGE_TARGET);
}

function bridgeAsk(method, args, timeoutMs, signal) {
  const id = `b${++bridgeSeq}`;
  if (!bridgeListener) {
    bridgeListener = (e) => {
      const d = e.data;
      if (!d || d.notalPlugin !== 1 || !d.replyTo) return;
      const wait = bridgeWaiters.get(d.replyTo);
      if (!wait) return;
      bridgeWaiters.delete(d.replyTo);
      wait.answer(d.ok ? { value: d.result } : { error: d.error || "the extension refused without saying why" });
    };
    window.addEventListener("message", bridgeListener);
  }
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", giveUp);
    };
    const fail = (message) => {
      bridgeWaiters.delete(id);
      stop();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail(method === "ping"
      ? "the Notal browser extension is not answering — is it installed and enabled?"
      : `the extension did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    const giveUp = () => fail("stopped before the extension answered");
    signal?.addEventListener?.("abort", giveUp, { once: true });
    bridgeWaiters.set(id, {
      answer: ({ value, error }) => { stop(); error ? reject(new Error(error)) : resolve(value); },
    });
    bridgeMessage({ id, method, args });
  });
}

/* Whether the companion is there, asked without a model in the loop so Settings
   can say it plainly. */
async function browserBridgeConnected() {
  try {
    const info = await bridgeAsk("ping", {}, BRIDGE_HELLO_MS);
    return { ok: true, ...info };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

const BROWSER_PLUGIN = {
  id: "browser",
  name: "Browser",
  desc: "Read the pages already open in Chrome, and act on them — follow a link, fill a field, press a button — through a companion extension you install once. It only ever answers Notal's own tab, and every action that moves a page waits for you.",
  setup: [
    "From the Chrome Web Store: search for Notal AI — browser companion and press Add to Chrome. From this folder instead: open chrome://extensions, switch on Developer mode, press Load unpacked and choose browser-extension.",
    "Either way, open its options (chrome://extensions → Details → Extension options) and list the address Notal is served from. A page on localhost or 127.0.0.1 is trusted without being listed; nothing else is.",
    "Press Connect the Notal tabs already open, or reload this page — a tab only carries the bridge from the moment it loads.",
    "Then switch the plugin on below and press Test. It will say whether the companion is answering, in its own words.",
    "It can see every page you can see, which is the point and the risk: leave it switched off until you want it, and read each approval card before approving it.",
  ],
  async test() {
    const seen = await browserBridgeConnected();
    if (!seen.ok) return { ok: false, message: seen.error };
    return { ok: true, message: `Companion v${seen.version || "0.2"} is answering — Notal can reach your tabs.` };
  },
  needs: { bridge: "The companion extension, from the Chrome Web Store or loaded unpacked from browser-extension/, with this page's address given to its options page." },
  fields: [],
  brief: `

### Browser

This reaches the tabs in the user's own Chrome, through an extension they
installed. It sees whatever the user can see, so ask for the least of it that
answers the question.

- browser.tabs {} — every open tab, with the number you address it by.
- browser.read {"tab":12} — the visible text of that tab. Use this for a page you
  do not have to touch.
- browser.snapshot {"tab":12} — the text again, plus every link, button and field
  numbered. The numbers only come from here, and only for the tab you snapshotted.
- browser.navigate {"tab":12,"url":"https://…"} — take an existing tab somewhere.
  **will ask the user first.**
- browser.open {"url":"https://…"} — a new tab. **will ask the user first.**
- browser.click {"tab":12,"index":3,"expect":"Sign in"} — press that numbered
  thing. "expect" is the label you read in the snapshot; the app refuses if the
  page has changed underneath you. **will ask the user first.**
- browser.type {"tab":12,"index":5,"text":"…","submit":false} — write into a
  field. Never type a password, a card number or anything you were not given to
  type into this page. **will ask the user first.**
- browser.close {"tab":12} — shut that tab. **will ask the user first.**

Read before you act, snapshot before you click, and after a click or a
navigation the old numbers are worthless — snapshot again. A page that needs the
user's own hands (a login, a two-code prompt, a payment) is theirs: open it, say
what you need, and wait for them to tell you it is done.`,
  actions: {
    "browser.tabs": {
      write: false,
      summary: () => "list the open tabs",
      async run(a, cfg, signal) {
        const r = await bridgeAsk("tabs", {}, BRIDGE_CALL_MS, signal);
        if (!r?.tabs?.length) return "No tabs the extension can see.";
        return r.tabs.map(t => `[${t.id}] ${t.title || "(untitled)"} — ${t.url}${t.active ? " (active)" : ""}${t.notal ? " (Notal)" : ""}`).join("\n");
      },
    },
    "browser.read": {
      write: false,
      summary: a => `read tab ${a.tab ?? "the active one"}`,
      async run(a, cfg, signal) {
        const r = await bridgeAsk("read", { tab: a.tab }, BRIDGE_CALL_MS, signal);
        return `${r.title || "a page"} — ${r.url}\n\n${ghLimit(r.text, 6000)}`;
      },
    },
    "browser.snapshot": {
      write: false,
      summary: a => `map the clickable things in tab ${a.tab ?? "the active one"}`,
      async run(a, cfg, signal) {
        const r = await bridgeAsk("snapshot", { tab: a.tab }, BRIDGE_CALL_MS, signal);
        const items = (r.items || []).map(i =>
          `[${i.index}] ${i.role}${i.name ? ` "${ghLimit(i.name, 60)}"` : ""}${i.value ? ` = ${ghLimit(i.value, 40)}` : ""}`);
        return `${r.title || "a page"} — ${r.url}\n` +
          `${r.elements} things you can act on:\n${items.join("\n") || "(nothing clickable found)"}\n\n` +
          `Text:\n${ghLimit(r.text, 3000)}`;
      },
    },
    "browser.open": {
      write: true,
      summary: a => `open a new tab at ${a.url}`,
      async run(a, cfg, signal) {
        const r = await bridgeAsk("open", { url: a.url }, BRIDGE_CALL_MS, signal);
        return `Opened [${r.tab}] ${r.url}`;
      },
    },
    "browser.navigate": {
      write: true,
      summary: a => `take tab ${a.tab ?? "the active one"} to ${a.url}`,
      async run(a, cfg, signal) {
        const r = await bridgeAsk("navigate", { tab: a.tab, url: a.url }, BRIDGE_CALL_MS, signal);
        return `Navigated [${r.tab}] to ${r.url}. Old numbers from that page are void — snapshot it again before clicking.`;
      },
    },
    "browser.click": {
      write: true,
      summary: a => `click number ${a.index}${a.expect ? ` ("${a.expect}")` : ""} in tab ${a.tab ?? "the active one"}`,
      async run(a, cfg, signal) {
        const r = await bridgeAsk("click", { tab: a.tab, index: a.index, expect: a.expect }, BRIDGE_CALL_MS, signal);
        return `Clicked ${r.describe}. The page is now ${r.url}${r.title ? ` — ${r.title}` : ""}. Its numbers may have changed; snapshot again before the next click.`;
      },
    },
    "browser.type": {
      write: true,
      summary: a => `type "${ghLimit(a.text, 60)}" into field ${a.index} in tab ${a.tab ?? "the active one"}`,
      async run(a, cfg, signal) {
        const r = await bridgeAsk("type", { tab: a.tab, index: a.index, text: a.text, submit: !!a.submit },
          BRIDGE_CALL_MS, signal);
        return `Typed into ${r.describe}${a.submit ? " and pressed Enter" : ""}. The page is now ${r.url}.`;
      },
    },
    "browser.close": {
      write: true,
      summary: a => `close tab ${a.tab}`,
      async run(a, cfg, signal) {
        const r = await bridgeAsk("close", { tab: a.tab }, BRIDGE_CALL_MS, signal);
        return r.closed ? `Closed the tab that held ${r.url}.` : "That tab was already gone.";
      },
    },
  },
};

const PLUGIN_DEFS = [GITHUB_PLUGIN, BROWSER_PLUGIN];

