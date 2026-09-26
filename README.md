# Notal AI

A calm, self-hostable AI workspace that runs entirely in the browser. No backend of its
own, no account required, no build step — four files do almost all the work, and every
byte of your data stays on your machine until you send a message to a model you chose.

**Live app:** https://batbleseed.github.io/notal-ai-ui/ (the landing page is at that address,
the workspace one click later at `/chat.html`)

Styled after the reading-comfort end of the internet: cream and charcoal surfaces, Source
Serif headings, one terracotta accent, and a triangular logo whose eyes follow your cursor
in the chat.

---

## Run it

Clone and open it — there is nothing to install:

```bash
git clone https://github.com/batbleseed/notal-ai-ui.git
cd notal-ai-ui
node server.js       # or double-click start.bat, which opens the browser too
```

Then open **http://127.0.0.1:4173/**. `server.js` is a 29-line static file server whose only
real job is serving `.webmanifest` with the correct content type, which Chrome demands before
it will offer "Install app". There is deliberately no `package.json` — nothing here has a
dependency to install.

Opening `chat.html` straight from the filesystem also works for chatting, but the service
worker, Google sign-in and `crypto.subtle` (the PIN hash) all need `http://localhost` or
HTTPS, so use the server for anything beyond a look.

You can also just drag `chat.html` into a browser and press *New chat* — the built-in model
replies without touching the network.

## What's in the box

| | |
|---|---|
| **Chat** | Multiple conversations titled from their first message, live search, typewriter reveal, plain-text bubbles, image lightbox |
| **Attachments** | Images render inline and reach vision-capable models as native image blocks; other files attach by name and size |
| **Dictation** | The mic button dictates through the Web Speech API and drops the transcript in the composer |
| **Providers** | OpenAI-compatible, Anthropic, Google Gemini, Ollama and any custom OpenAI-shaped endpoint — bring your own key |
| **Provider relay** | Optional Cloudflare Worker that forwards calls for endpoints which refuse browser requests ([below](#the-relay)) |
| **Projects** | Group conversations into a project; the project name is added to the system prompt and the sidebar filters to it |
| **Memory** | Facts you add are injected into every request's system prompt, and can be toggled off individually |
| **Skills** | Saved reusable prompts — one click runs them, another inserts them into the composer to edit |
| **Notifications** | Desktop notification plus a soft synthesised chime when a reply lands in a background tab |
| **Security** | PIN app lock (SHA-256, never stored as text), optional auto-lock after idle, manual lock shortcut |
| **Sign in** | Google sign-in through Firebase — used only to get a name and photo for the UI; keys and chats stay local either way |
| **Install as an app** | It is a PWA: installable on Windows, macOS, Android and iOS, and the shell keeps working offline |
| **Dark mode** | Real theme, not a filter — synced between the account popover and Settings, and it updates the installed app's title bar colour |

Keyboard: `Ctrl`/`⌘` `K` new chat · `Shift` `F` search · `I` focus input · `B` sidebar ·
`,` settings · `Shift` `L` lock · `Enter` send · `Shift` `Enter` newline · `Esc` close.

### Be aware: the built-in model is a demo

`notal generic`, the model you start on, is **not** an AI. It pattern-matches your message
and returns a scripted reply so the interface is usable with no key and no network. Real
answers need a provider — add one below.

## Connecting a model

Settings → **Providers** → fill the form. The key is saved to `localStorage` in this browser
and sent only to the address in that same row.

| Provider | Model ID | Base URL |
|---|---|---|
| Google Gemini | `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.1-pro-preview` | leave empty |
| Anthropic | `claude-sonnet-4-5`, `claude-haiku-4-5` | leave empty |
| OpenAI-compatible | `gpt-4o-mini`, `llama-3.3-70b-versatile`, … | `https://api.openai.com/v1` |
| Ollama (local) | whatever `ollama list` shows, e.g. `llama3.1:8b` | `http://localhost:11434` |

Get a Gemini key at [aistudio.google.com/api-key](https://aistudio.google.com/api-key); model
names are listed at [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models).
Only chat models work here — `-live` and `-tts` variants use streaming audio endpoints.

Conversation history is sent as the last 14 messages, and image attachments are converted to
whichever shape each provider expects (`image_url`, `source.base64`, `inline_data`, or
Ollama's `images` array).

## The relay

**You probably don't need it.** The three big providers all answer calls that come straight
from a browser tab today — Anthropic when the request sends
`anthropic-dangerous-direct-browser-access`, OpenAI and Google with permissive CORS. Verified
from this site's own origin: each returned its own `401 invalid key` for a bad key, which means
the request got there. With no relay configured, Notal AI talks to them directly.

The relay exists for endpoints that refuse browsers. Most self-hosted OpenAI-compatible servers
(`llama.cpp`'s server, vLLM, an internal gateway, anything behind a proxy that doesn't add CORS
headers) fail in the tab before the request ever reaches the model — that is exactly what
happened to this project's own test server, and it is what the relay fixed. It also moves the
outbound call behind an address you control rather than whichever machine has the page open.

The relay is a ~160-line Cloudflare Worker you deploy on your own account: the app wraps the
request in an envelope, the Worker unwraps it, calls the target with your key, and returns the
provider's own status and JSON.

It is **off by default**. Set it in Settings → **General → Provider relay**, paste the URL and
press *Test* — it should read *"Reachable — allow-listed N provider hosts"*.

Deploy it:

1. [workers.cloudflare.com](https://workers.cloudflare.com) → **Create** → **Worker**, name it
   `notal-relay`. The Workers free plan needs no card.
2. In the code editor, replace everything in `worker.js` with the contents of
   [`worker/notal-relay.mjs`](worker/notal-relay.mjs) → **Save and Deploy**.
3. Optional: **Settings → Variables** → add `RELAY_ALLOWED_ORIGINS` with any extra site
   address that must call it. `localhost`, `*.github.io` and `*.pages.dev` are already allowed
   in code.
4. Paste `https://notal-relay.<your-name>.workers.dev` into the app.

Already deployed on a Worker called something else? Change `name` in `wrangler.toml` to match
the first label of its URL, otherwise `wrangler deploy` creates a second Worker instead of
updating it. To use the CLI instead of the dashboard: `npx wrangler login && npx wrangler deploy`.

Local targets skip the relay on purpose: a Worker on Cloudflare cannot reach Ollama on your
laptop, so the app only routes `localhost` through a relay that is itself local.

What the relay guarantees, and what it does not:

- Only provider hosts on a built-in allow-list may be targeted, only `https` (plus local
  addresses), and only auth headers are forwarded. Bodies are capped at 12 MB and upstream
  calls time out after 90 s.
- Nothing is written to disk and no database exists — it is stateless by construction.
- Your key **does** pass through Cloudflare's servers in transit, so it is your own Worker or
  nobody's. Keep the URL to yourself: there is no auth on it, and anyone who has it could send
  requests through it *using your key*. Set a hard spend cap with your provider.

## Where your data lives

Everything is in `localStorage` under one key, `notal.state`: conversations, projects, memory,
skills, provider keys, and settings. There is no sync and no server-side copy, so chats do not
follow you between browsers, devices, or between `127.0.0.1` and the hosted site — each origin
keeps its own settings, which is why a key has to be added once per address.

Clearing site data, or Settings → **General → Clear all chats**, is the only delete path. When
storage fills up, attachments' base64 image data is dropped before anything else.

Sending a message posts your conversation to the provider you configured (through your relay,
if you set one). Firebase is contacted for sign-in only. The Firebase web config in `app.js` is
public by design — it is a browser identifier, not a secret, and access is enforced by the
authorized-domains list in the Firebase console.

## Layout

```
index.html              landing page → links to the chat
chat.html               the app
app.js                  all behaviour: chat, providers, relay envelope, views, lock, PWA
styles.css              the design system, light and dark
sw.js                   offline shell; code is network-first so updates land
manifest.webmanifest    install metadata and icons
favicon.svg  icons/     192 and 512 maskable PNGs
make-icons.js           regenerates icons/ from scratch, pure Node, no image library
server.js               static dev server with the right MIME types
start.bat               node server.js for Windows
worker/notal-relay.mjs  the Cloudflare relay
worker/dev-relay.mjs    run that same Worker in Node: node worker/dev-relay.mjs 8787
wrangler.toml           deploy config for the relay
```

There are no runtime dependencies — not for the app, not for the dev server, not for the
relay's local test harness. Node is only ever a development convenience.

### Hacking on it

```bash
node --check app.js                    # the whole syntax gate this repo has
node worker/dev-relay.mjs 8787         # the relay, locally
node make-icons.js                     # after changing the logo
```

`worker/dev-relay.mjs` is a small `fetch`-compatible adapter around the Worker export, so
editing the Worker and hitting *Test* in Settings exercises the same code you deploy.

## Credit

Design direction borrowed shamelessly from Claude's reading comfort. Logo is a triangle with
eyes because a triangle with eyes is funnier than a triangle. Built and maintained by one
person. MIT licensed — see [LICENSE](LICENSE).
