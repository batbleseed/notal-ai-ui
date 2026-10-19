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

/* Both services end their own sentence with a period and this line adds one of
   its own, so without the trim the reader sees "not found.." */
function oauthReason(r) {
  return String(r?.error_description || r?.error || "").replace(/\.$/, "");
}

async function githubSignIn(cfg, onStatus, signal) {
  const clientId = String(cfg.clientId || "").trim();
  if (!clientId) throw new Error("Notal signs in with an OAuth app of your own, so its client ID goes in the field above.");

  const start = await githubRelayStep("device", { client_id: clientId, scope: ghScopes(cfg) });
  if (start.error)
    throw new Error(`GitHub would not hand out a code: ${oauthReason(start)}. ` +
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

/* ---------- Google, where one step cannot happen in a browser at all ----------
   GitHub's device flow asks a tab for nothing but a public client ID. Google's own
   documentation marks client_secret Required on the polling call, so the exchange
   needs somewhere that is allowed to hold a secret — and a secret a browser holds
   is not one. That is the relay's whole job here: it adds its own secret to the
   form on the way out and never sends it back.

   Measured from this machine rather than assumed: oauth2.googleapis.com,
   gmail.googleapis.com and www.googleapis.com each answer a cross-origin preflight
   with access-control-allow-origin. So once a token exists, Gmail and Drive calls
   go straight from this tab and the relay drops out of the picture entirely —
   which is also why pasting an access token here needs no relay at all. */
const GOOGLE_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/* a Google access token lives an hour, so it is traded early rather than caught
   out halfway through a call */
const GOOGLE_REFRESH_MARGIN_MS = 5 * 60 * 1000;

async function googleRelayStep(step, fields) {
  const base = pluginHooks.relay();
  if (!base) throw new Error(
    "Google's sign-in needs a client secret on the polling call, which no browser tab should hold, " +
    "so it goes through the app's relay. Put a relay address in Settings → Providers — and note the " +
    "relay itself has to be given GOOGLE_CLIENT_SECRET — or paste an access token below instead.");
  const res = await fetch(`${base}/google`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step, fields }),
  });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error(`${base}/google answered ${res.status} with something that is not JSON`); }
  /* Google's answers, refusals included, are the caller's to read; only a refusal
     the relay made itself ends the call here. */
  if (payload?.refused_by) throw new Error(payload.error || `the relay refused the request (${res.status})`);
  if (!res.ok && payload?.error === undefined)
    throw new Error(`the relay answered ${res.status}${payload?.message ? `: ${payload.message}` : ""}`);
  return payload;
}

/* One OAuth client serves Gmail and Drive, so the ID is only typed once: whichever
   of the two boxes holds it answers for both. */
function googleClientId(cfg) {
  const own = String(cfg?.clientId || "").trim();
  if (own) return own;
  for (const id of ["gmail", "drive"]) {
    const other = String(pluginHooks.config?.(id)?.clientId || "").trim();
    if (other) return other;
  }
  return "";
}

/* Asked for at sign-in, never stored on Google's side: an OAuth client of this
   type has no scope picker. The default per plugin is the least that does its
   job, and the field lets you widen it on purpose. */
function googleScopes(cfg, fallback) {
  return String(cfg.scopes || "").trim() || fallback;
}

function rememberGoogleToken(cfg, r) {
  cfg.oauth = {
    token: r.access_token,
    refresh: r.refresh_token || "",
    expiresAt: r.expires_in ? Date.now() + Number(r.expires_in) * 1000 : 0,
    /* Google separates its scopes with spaces, GitHub with commas */
    scopes: String(r.scope || "").split(/\s+/).filter(Boolean),
    login: "",
  };
  pluginHooks.persist();
  return cfg.oauth;
}

function googleWait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", giveUp);
      resolve();
    }, ms);
    const giveUp = () => {
      clearTimeout(timer);
      reject(new DOMException("stopped before Google was signed into", "AbortError"));
    };
    signal?.addEventListener?.("abort", giveUp, { once: true });
  });
}

/* opts.scopes is what this plugin asks for, opts.identify is how it finds out
   whose account the token turned out to be — the profile call differs per API, so
   the plugin brings it rather than this flow guessing. */
async function googleSignIn(cfg, opts, onStatus, signal) {
  const clientId = googleClientId(cfg);
  if (!clientId)
    throw new Error("Google signs this in with an OAuth client of your own, so its client ID goes in the field above.");

  const start = await googleRelayStep("device", { client_id: clientId, scope: googleScopes(cfg, opts.scopes) });
  if (start.error)
    throw new Error(`Google would not hand out a code: ${oauthReason(start)}. ` +
      "Check the client ID, and that this relay has been given the client secret.");
  if (!start.device_code || !start.user_code)
    throw new Error("Google answered the code request with something that had no code in it.");

  /* Google's own page calls this field verification_url where the RFC it follows
     calls it verification_uri, and no verification_uri_complete exists for the
     device flow here — so read whichever arrived and fall back to the known page */
  const link = start.verification_url || start.verification_uri || "https://www.google.com/device";
  onStatus?.({ stage: "code", code: start.user_code, link });

  let waitMs = Math.max(Number(start.interval) || 5, 2) * 1000;
  const deadline = Date.now() + (Number(start.expires_in) || 1800) * 1000;
  for (;;) {
    await googleWait(waitMs, signal);
    const r = await googleRelayStep("token", {
      client_id: clientId,
      device_code: start.device_code,
      grant_type: GOOGLE_DEVICE_GRANT,
    });
    if (r.access_token) {
      const saved = rememberGoogleToken(cfg, r);
      try { saved.login = (await opts.identify?.(cfg, signal)) || ""; }
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
        throw new Error("The sign-in was declined at Google.");
      default:
        throw new Error(`Google refused the token (${r.error || "no reason given"})` +
          (r.error_description ? `: ${r.error_description}` : ""));
    }
    if (Date.now() > deadline)
      throw new Error("Google's code expired before anyone entered it. Press Sign in again.");
  }
}

function googleSignOut(cfg) {
  cfg.oauth = null;
  pluginHooks.persist();
}

/* The token to send, asked for rather than assumed: a sign-in wins over a pasted
   token, and a sign-in that has run out is traded for a new one before use.
   Google does not rotate the refresh token on this grant, so the old one stays. */
async function googleAccessToken(cfg, signal) {
  const o = cfg.oauth;
  if (!o?.token) return String(cfg.token || "").trim();
  if (!o.expiresAt || Date.now() < o.expiresAt - GOOGLE_REFRESH_MARGIN_MS) return o.token;
  if (!o.refresh)
    throw new Error("The Google sign-in has run out and there is nothing to renew it with — sign in again.");
  const clientId = googleClientId(cfg);
  if (!clientId)
    throw new Error("The Google sign-in needs its OAuth client ID to renew — put it back in the field above.");
  const r = await googleRelayStep("refresh", {
    client_id: clientId,
    refresh_token: o.refresh,
    grant_type: "refresh_token",
  });
  if (!r.access_token)
    throw new Error(`Google would not renew the sign-in (${r.error || "no reason given"}) — sign in again.`);
  Object.assign(o, {
    token: r.access_token,
    refresh: r.refresh_token || o.refresh,
    expiresAt: r.expires_in ? Date.now() + Number(r.expires_in) * 1000 : 0,
  });
  pluginHooks.persist();
  return o.token;
}

/* Gmail and Drive are two different hosts, and one of them is a upload endpoint,
   so this takes the whole address rather than a path. init.raw asks for the body
   as text, which is what a file's contents and an export both come back as. */
async function googleApi(url, cfg, init, signal) {
  const token = await googleAccessToken(cfg, signal);
  if (!token) throw new Error("Nothing is connected to Google yet — sign in, or paste an access token.");
  const res = await fetch(url, {
    ...init,
    signal,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.body && !init?.rawBody ? { "content-type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  if (init?.raw) {
    if (!res.ok) throw new Error(`Google said ${res.status} reading that file: ${text.slice(0, 200)}`);
    return text;
  }
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch { /* a proxy or a login page can answer instead of the API */ }
  if (!res.ok) {
    const e = body?.error;
    const reason = e?.errors?.[0]?.reason || "";
    const detail = e?.message || text.slice(0, 200) || res.statusText;
    /* the two 403s a person can actually fix, said as the thing to fix */
    if (res.status === 403 && /accessNotConfigured|APIS_DISABLED|not been used|enable it/i.test(`${detail} ${reason}`))
      throw new Error(`That Google API is not switched on for this OAuth client. Google Cloud Console → APIs & Services → Library, enable it, then try again. (it said: ${detail})`);
    if (res.status === 403 && /auth|permission|insufficient/i.test(`${detail} ${reason}`))
      throw new Error(`Google refused this call for the scopes this sign-in was given (403): ${detail}`);
    if (res.status === 401) throw new Error(`Google rejected this token (401): ${detail}`);
    if (res.status === 404) throw new Error(`Google said 404 — no such message or file, or this token cannot see it (${detail})`);
    throw new Error(`Google said ${res.status}: ${detail}`);
  }
  return body;
}

function base64UrlFromText(text) {
  const bytes = new TextEncoder().encode(String(text));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textFromBase64Url(b64) {
  const s = String(b64 || "").replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
  /* the cube's drawing. This is markup written here, next to the plugin it
     names, and it is the only place a plugin's icon comes from — nothing a
     service ever sends can change what these tiles look like. */
  icon: '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="8.5" r="2.4"/><path d="M6 8.4v7.2"/><path d="M18 10.9c0 3.2-2.7 4.7-6.2 4.7H9.4"/>',
  desc: "Read a repository, its issues and its files, and commit files back through GitHub's own API. Nothing is cloned: the change is made from this tab, one commit at a time.",
  setup: [
    "Nothing to do to try it: the client ID below is Notal's own OAuth app, already filled in, and GitHub's device flow needs no secret from you. Make your own app if you would rather hold the tokens — steps 1 to 3 are for that.",
    "On GitHub: Settings → Developer settings → OAuth Apps → New OAuth App. Homepage and callback URL both want a real address, and GitHub will not let the callback be blank — put the address Notal is served from in both. Neither one is used: the device flow never redirects a browser back here.",
    "Open the app you just made and turn on Device Flow. GitHub leaves it off, and without it GitHub refuses to hand out a code. Expire user access tokens can stay on: that is what gives a token that renews itself instead of one that dies in eight hours.",
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
    /* a client ID is the half of an OAuth pair that is meant to be public — it is
       what GitHub prints on the code screen — so it ships here and grants nothing
       by itself. Whoever runs this app signs in through their own OAuth app. */
    default: "Ov23liq9tswM30kZ6Q7n",
    placeholder: "the public id of your own OAuth app",
    help: "Already filled with the id of Notal's own OAuth app: it is public by design, it grants nothing on its own, and sign-in works the moment Device Flow is switched on for it. Put your own app's id here to make the tokens yours instead.",
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
  icon: '<rect x="3" y="4.5" width="18" height="15" rx="2.2"/><path d="M3 9.4h18"/><path d="M6.4 7h.01M9.2 7h.01M12 7h.01"/>',
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

/* ---------- Gmail ----------
   Four calls. Three read a mailbox that is already yours; the fourth writes a
   message and stops for approval before a byte of it leaves, because a mail sent
   is a mail sent. The read scope is what Google classes Restricted, so the
   account is the only thing that can grant it — nothing here asks for the right to
   read somebody else's mail. */
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_SCOPES = "https://www.googleapis.com/auth/gmail.readonly " +
  "https://www.googleapis.com/auth/gmail.send";

async function gmailIdentify(cfg, signal) {
  const p = await googleApi(`${GMAIL_BASE}/profile`, cfg, { signal }, signal);
  if (!p?.emailAddress) return "";
  return p.messagesTotal ? `${p.emailAddress}, ${p.messagesTotal} messages` : p.emailAddress;
}

function gmailHeader(msg, want) {
  const h = (msg?.payload?.headers || []).find(x => x.name?.toLowerCase() === want.toLowerCase());
  return h?.value || "";
}

/* a mail is a tree of parts, and the plain-text one is the reading copy; an html
   body is stripped to words rather than shown as markup */
function gmailBody(msg) {
  let plain = "", html = "";
  const walk = part => {
    if (!part) return;
    if (part.body?.data) {
      const text = textFromBase64Url(part.body.data);
      if (part.mimeType === "text/plain" && !plain) plain = text;
      else if (part.mimeType === "text/html" && !html) html = text;
    }
    for (const sub of part.parts || []) walk(sub);
  };
  walk(msg?.payload);
  const body = plain || html.replace(/<[^>]*>/g, " ").replace(/[ \t]+/g, " ").trim();
  return body || msg?.snippet || "";
}

function gmailRaw(a) {
  const to = String(a.to || "").trim();
  if (!to) throw new Error("a message needs someone to go to");
  const lines = [`To: ${to}`];
  if (String(a.cc || "").trim()) lines.push(`Cc: ${String(a.cc).trim()}`);
  lines.push(`Subject: ${String(a.subject || "(no subject)")}`, "", String(a.body ?? ""));
  return base64UrlFromText(lines.join("\r\n"));
}

const GMAIL_PLUGIN = {
  id: "gmail",
  name: "Gmail",
  icon: '<rect x="3" y="5.5" width="18" height="13" rx="2.2"/><path d="M3.8 7 12 12.8 20.2 7"/>',
  desc: "Read and search the mailbox that signs in, and write a message — which is shown to you before it is sent. Everything goes to Google's own API from this tab; nothing is copied anywhere else.",
  setup: [
    "Google Cloud Console → APIs & Services → Library, and switch on Gmail API. An OAuth client that has not been given the API gets a 403 that this plugin repeats back to you.",
    "OAuth consent screen: External, and add the Gmail address you will sign in with under Test users. While the app is unverified Google shows a Google-hasn't-verified-this-app warning at the code screen — that warning is expected here, not a failure, and Gmail's read scope is one of the Restricted ones a public app has to be assessed for.",
    "Credentials → Create credentials → OAuth client ID, application type TV and Limited-input devices. That is the type that speaks the device flow.",
    "Copy its Client ID into the field below. Its Client Secret does not go here: it goes to the relay (GOOGLE_CLIENT_SECRET on the worker, or notal-ai-studio/google_secret for the desktop app), because Google requires it on the polling call and a browser must not hold one.",
    "Press Sign in with Google, type the code it shows at www.google.com/device, and wait for this to finish on its own.",
    "No relay at all? Authorize in Google's own OAuth Playground and paste the access token below. It lasts about an hour and needs no secret, because Gmail answers this tab directly.",
  ],
  signInLabel: "Sign in with Google",
  signOutLabel: "Sign out",
  fields: [{
    key: "clientId",
    label: "OAuth client ID",
    optional: true,
    placeholder: "…apps.googleusercontent.com",
    help: "From a TV and Limited-input devices client you make in Google Cloud Console. Public by design. The same client ID serves Gmail and Drive, so it only has to be typed into one of the two.",
  }, {
    key: "scopes",
    label: "Scopes to ask Google for",
    optional: true,
    placeholder: GMAIL_SCOPES,
    help: "Asked for at sign-in, space-separated. Left empty it asks for gmail.readonly and gmail.send: your own mail, and the right to write a message you approve. Drop gmail.send if Notal should never be able to send.",
  }, {
    key: "token",
    label: "or an access token from elsewhere",
    type: "password",
    optional: true,
    placeholder: "ya29.…",
    help: "Google's OAuth Playground will give you one. It needs no relay and no client secret, and it runs out in about an hour.",
  }],
  ready(cfg) { return Boolean(cfg.oauth?.token || String(cfg.token || "").trim()); },
  notReady: "Nothing is connected: sign in with Google above, or paste an access token below.",
  signIn: (cfg, onStatus, signal) => googleSignIn(cfg, { scopes: GMAIL_SCOPES, identify: gmailIdentify }, onStatus, signal),
  signOut(cfg) { googleSignOut(cfg); },
  async test(cfg) {
    if (!GMAIL_PLUGIN.ready(cfg))
      return { ok: false, message: "Nothing is connected yet — press Sign in with Google, or paste an access token." };
    const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(12000) : undefined;
    const who = await gmailIdentify(cfg, signal);
    const how = cfg.oauth?.token ? "a sign-in Google handed out" : "a token you pasted";
    const when = cfg.oauth?.expiresAt
      ? `, and it renews itself around ${new Date(cfg.oauth.expiresAt).toLocaleString()}` : "";
    return { ok: true, message: `Gmail answers for ${who} — this works from this browser with ${how}${when}.` };
  },
  brief: `
### Gmail

Reads run on their own. Sending is not: the app shows you the message and waits,
so only send what the user actually asked for, and say in your own reply that you
sent it.

- gmail.profile {} — the address this sign-in is, and how many messages it holds.
- gmail.list {"query":"is:unread category:primary","limit":10} — the newest
  matches of a Gmail search query. Gmail's own operators work (is:unread, from:,
  subject:, older_than:7d). No query gives the newest mail there is.
- gmail.read {"id":"18f…"} — one message: from, to, date, subject and its text.
  The id comes from gmail.list, never from memory.
- gmail.send {"to":"someone@example.com","subject":"…","body":"…","cc":""} —
  one plain-text message. **will ask the user first.**

Mail is someone's inbox. Quote the least of it that answers the question, and if a
send was declined, it was not sent — do not retry it behind the approval.`,
  actions: {
    "gmail.profile": {
      write: false,
      summary: () => "the signed-in Gmail account",
      async run(a, cfg, signal) {
        const p = await googleApi(`${GMAIL_BASE}/profile`, cfg, { signal }, signal);
        return `${p.emailAddress || "an address Google did not name"} — ` +
          `${p.messagesTotal ?? "?"} messages, ${p.threadsTotal ?? "?"} threads`;
      },
    },
    "gmail.list": {
      write: false,
      summary: a => `${a.query ? `mail matching “${ghLimit(a.query, 60)}”` : "the newest mail"}`,
      async run(a, cfg, signal) {
        const per = Math.min(Math.max(Number(a.limit) || 10, 1), 25);
        const q = a.query ? `&q=${encodeURIComponent(String(a.query))}` : "";
        const list = await googleApi(
          `${GMAIL_BASE}/messages?maxResults=${per}${q}&includeSnippets=false`, cfg, { signal }, signal);
        const ids = list?.messages || [];
        if (!ids.length)
          return a.query ? `Nothing in this mailbox matches ${a.query}.` : "This mailbox has no messages at all.";
        /* the list endpoint gives ids and nothing else, so the headers come from
           one metadata call per message — which is why the limit is small */
        const some = await Promise.all(ids.map(m => googleApi(
          `${GMAIL_BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          cfg, { signal }, signal).catch(() => null)));
        return ids.map((m, i) => {
          const msg = some[i];
          if (!msg) return `[${m.id}] — Google would not send this one`;
          return `[${m.id}] ${gmailHeader(msg, "Date")} — from ${gmailHeader(msg, "From")}: ` +
            `${gmailHeader(msg, "Subject") || "(no subject)"}${msg.snippet ? ` — ${msg.snippet}` : ""}`;
        }).join("\n");
      },
    },
    "gmail.read": {
      write: false,
      summary: a => `message ${a.id}`,
      async run(a, cfg, signal) {
        if (!a.id) throw new Error("gmail.read needs the id gmail.list gave");
        const m = await googleApi(`${GMAIL_BASE}/messages/${encodeURIComponent(String(a.id))}?format=full`,
          cfg, { signal }, signal);
        return `From ${gmailHeader(m, "From")}\nTo ${gmailHeader(m, "To")}\n` +
          `Date ${gmailHeader(m, "Date")}\nSubject: ${gmailHeader(m, "Subject") || "(no subject)"}\n\n` +
          ghLimit(gmailBody(m), 6000);
      },
    },
    "gmail.send": {
      write: true,
      summary: a => `send a message to ${a.to}: “${a.subject || "(no subject)"}”, ` +
        `${new Blob([String(a.body ?? "")]).size} B of text`,
      async run(a, cfg, signal) {
        const made = await googleApi(`${GMAIL_BASE}/messages`, cfg, {
          method: "POST", body: JSON.stringify({ raw: gmailRaw(a) }),
        }, signal);
        if (!made?.id) throw new Error("Gmail accepted the send but did not name the message it made");
        return `Sent to ${a.to}${a.cc ? ` (cc ${a.cc})` : ""}, message id ${made.id}, ` +
          `thread ${made.threadId || "new"}.`;
      },
    },
  },
};

/* ---------- Drive ----------
   The read half is drive.readonly, which is Google's own list of everything the
   account can open. The write half is deliberately the narrower drive.file: a
   token sitting in a browser can create and update files this app made, and gets
   no purchase on the rest of the drive. */
const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_FILE_BASE = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_SCOPES = "https://www.googleapis.com/auth/drive.readonly " +
  "https://www.googleapis.com/auth/drive.file";

async function driveIdentify(cfg, signal) {
  const about = await googleApi(`${DRIVE_BASE}/about?fields=user(emailAddress,displayName)`,
    cfg, { signal }, signal);
  const u = about?.user;
  if (!u?.emailAddress) return "";
  return u.displayName ? `${u.displayName} <${u.emailAddress}>` : u.emailAddress;
}

/* Drive's query language takes single quotes, so one in a name ends the string
   and starts something else */
function driveQuote(value) { `'${String(value).replace(/'/g, "\\'")}'`; }

const DRIVE_FIELDS = "id,name,mimeType,size,modifiedTime,trashed";

const DRIVE_PLUGIN = {
  id: "drive",
  name: "Drive",
  icon: '<path d="M8.3 4.4h7.4l4.6 8-3.3 6.2H6.4"/><path d="M3.4 12.4 8.3 4.4"/><path d="M1.6 20.6 3.4 12.4"/><path d="M6.4 18.6H17"/>',
  desc: "Find and read files in the Google account that signs in, and write a plain-text file back. Google Docs are read through Google's own text export, so they come back as words rather than an unreadable id.",
  setup: [
    "Google Cloud Console → APIs & Services → Library, and switch on Google Drive API. The Gmail and Drive APIs are separate switches on that page.",
    "Use the OAuth client you made for Gmail — the same Client ID below serves both, and one consent screen covers both, provided the Drive API is enabled for it too.",
    "Press Sign in with Google and type the code at www.google.com/device, or paste an access token from Google's OAuth Playground if there is no relay to hand.",
    "The write half asks for drive.file, not drive.readonly's bigger cousin: Notal can create and change files it made, and sees the rest of the drive read-only.",
  ],
  signInLabel: "Sign in with Google",
  signOutLabel: "Sign out",
  fields: [{
    key: "clientId",
    label: "OAuth client ID",
    optional: true,
    placeholder: "…apps.googleusercontent.com",
    help: "The same TV and Limited-input devices client Gmail uses. Left empty, Drive reads it from the Gmail plugin's box.",
  }, {
    key: "scopes",
    label: "Scopes to ask Google for",
    optional: true,
    placeholder: DRIVE_SCOPES,
    help: "Space-separated, asked for at sign-in. Empty means drive.readonly plus drive.file. Drop drive.file and Notal can read but never write.",
  }, {
    key: "token",
    label: "or an access token from elsewhere",
    type: "password",
    optional: true,
    placeholder: "ya29.…",
    help: "From Google's OAuth Playground, with the Drive scopes ticked. Lasts about an hour and needs no relay.",
  }],
  ready(cfg) { return Boolean(cfg.oauth?.token || String(cfg.token || "").trim()); },
  notReady: "Nothing is connected: sign in with Google above, or paste an access token below.",
  signIn: (cfg, onStatus, signal) => googleSignIn(cfg, { scopes: DRIVE_SCOPES, identify: driveIdentify }, onStatus, signal),
  signOut(cfg) { googleSignOut(cfg); },
  async test(cfg) {
    if (!DRIVE_PLUGIN.ready(cfg))
      return { ok: false, message: "Nothing is connected yet — press Sign in with Google, or paste an access token." };
    const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(12000) : undefined;
    const who = await driveIdentify(cfg, signal);
    const how = cfg.oauth?.token ? "a sign-in Google handed out" : "a token you pasted";
    return { ok: true, message: `Drive answers for ${who} — this works from this browser with ${how}.` };
  },
  brief: `
### Drive

Reads run on their own. Writing a file does not: it is shown to the user first.

- drive.about {} — whose drive this is.
- drive.list {"limit":15} — the most recently changed files, biggest first.
- drive.search {"query":"budget","limit":15} — files whose name or content matches.
- drive.read {"id":"1Ab…"} — the words in one file. A Google Doc comes back as
  text; a PDF or an image does not come back at all, and says so.
- drive.write {"name":"notes.txt","text":"…"} — a new plain-text file, or the new
  contents of one this plugin already made. **will ask the user first.**

A drive is somebody's work. Search before reading, read the one file you need, and
never overwrite a file you have not read in this conversation.`,
  actions: {
    "drive.about": {
      write: false,
      summary: () => "whose Drive this is",
      async run(a, cfg, signal) {
        return `Drive of ${await driveIdentify(cfg, signal) || "an account Google did not name"}.`;
      },
    },
    "drive.list": {
      write: false,
      summary: () => "the recently changed files in Drive",
      async run(a, cfg, signal) {
        const per = Math.min(Math.max(Number(a.limit) || 15, 1), 50);
        const r = await googleApi(
          `${DRIVE_BASE}/files?pageSize=${per}&fields=files(${DRIVE_FIELDS})&orderBy=modifiedTime%20desc` +
          `&q=${encodeURIComponent("trashed = false")}`, cfg, { signal }, signal);
        const files = r?.files || [];
        if (!files.length) return "No files in this Drive that this token can see.";
        return files.map(f => `[${f.id}] ${f.name} — ${f.mimeType}, ${f.size ?? "?"} B, changed ${f.modifiedTime}`).join("\n");
      },
    },
    "drive.search": {
      write: false,
      summary: a => `Drive files matching “${ghLimit(a.query, 60)}”`,
      async run(a, cfg, signal) {
        const per = Math.min(Math.max(Number(a.limit) || 15, 1), 50);
        const bits = [`trashed = false`];
        const text = String(a.query || "").trim();
        if (text) bits.push(`(name contains ${driveQuote(text)} or fullText contains ${driveQuote(text)})`);
        const r = await googleApi(
          `${DRIVE_BASE}/files?pageSize=${per}&fields=files(${DRIVE_FIELDS})&q=` +
          encodeURIComponent(bits.join(" and ")), cfg, { signal }, signal);
        const files = r?.files || [];
        if (!files.length) return `Nothing in this Drive matches ${text || "that"}.`;
        return `${files.length} file${files.length === 1 ? "" : "s"}:\n` +
          files.map(f => `[${f.id}] ${f.name} — ${f.mimeType}, changed ${f.modifiedTime}`).join("\n");
      },
    },
    "drive.read": {
      write: false,
      summary: a => `the file ${a.id}`,
      async run(a, cfg, signal) {
        if (!a.id) throw new Error("drive.read needs the id drive.list or drive.search gave");
        const meta = await googleApi(`${DRIVE_BASE}/files/${encodeURIComponent(String(a.id))}` +
          `?fields=id,name,mimeType,size`, cfg, { signal }, signal);
        const type = meta?.mimeType || "";
        /* Google's own formats have no bytes to fetch — the export endpoint turns
           them into text, and a presentation has no text export worth asking for */
        const exportAs = type === "application/vnd.google-apps.document" ? "text/plain"
          : type === "application/vnd.google-apps.spreadsheet" ? "text/csv"
          : type === "application/vnd.google-apps.drawing" ? "text/plain" : "";
        if (exportAs) {
          const text = await googleApi(
            `${DRIVE_BASE}/files/${encodeURIComponent(meta.id)}/export?mimeType=${encodeURIComponent(exportAs)}`,
            cfg, { signal, raw: true }, signal);
          return `${meta.name} (${type}, ${text.length} characters):\n\n${ghLimit(text, 6000)}`;
        }
        if (meta.size && Number(meta.size) > 400 * 1024)
          throw new Error(`${meta.name} is ${meta.size} B — this plugin reads text files, not large ones`);
        const text = await googleApi(`${DRIVE_BASE}/files/${encodeURIComponent(meta.id)}?alt=media`,
          cfg, { signal, raw: true }, signal);
        return `${meta.name} (${type || "unknown type"}, ${text.length} characters):\n\n${ghLimit(text, 6000)}`;
      },
    },
    "drive.write": {
      write: true,
      summary: a => `write ${a.name || "a file"} to Drive, ${new Blob([String(a.text ?? "")]).size} B of text`,
      async run(a, cfg, signal) {
        const name = String(a.name || "").trim();
        const text = String(a.text ?? "");
        if (!name) throw new Error("drive.write needs a file name");
        if (!text.trim()) throw new Error("drive.write needs some text — an empty file is not a change");
        if (text.length > 200_000) throw new Error("drive.write sends text files, and this is over 200 kB");
        const made = await googleApi(`${DRIVE_FILE_BASE}?uploadType=media&fields=${DRIVE_FIELDS}`, cfg, {
          method: "POST",
          headers: { "content-type": a.mime || "text/plain" },
          body: text,
          rawBody: true,
        }, signal);
        return `Wrote ${made.name || name} to Drive as ${made.id}. ` +
          `Google's own page for it: https://drive.google.com/file/d/${made.id}/view`;
      },
    },
  },
};

const PLUGIN_DEFS = [GITHUB_PLUGIN, BROWSER_PLUGIN, GMAIL_PLUGIN, DRIVE_PLUGIN];

