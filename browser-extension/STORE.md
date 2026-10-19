# Putting this companion on the Chrome Web Store

Everything here is done by a person, in a browser, with a Google account. Nothing
in the app can do it for you, and nothing here has been done yet — the extension
is unpacked code in this folder until it is uploaded.

Cost, once, per developer account: **US$5**, non-refundable. It is the same
account for every extension you publish, and it is not a subscription.

## 1. Register

<https://chrome.google.com/webstore/devconsole> — sign in with the Google account
you want to own this, pay the fee, accept the developer agreement. A new account
sometimes needs a day before the payment goes through.

## 2. Check the code before it is packaged

- `manifest.json` — Manifest V3, which is the only kind accepted now. Bump
  `version` for every upload (`0.2`, `0.3`, …); the store keeps the history and
  Chrome updates installed copies from it.
- `host_permissions: ["<all_urls>"]` is what lets the companion read and act on
  the tab you point it at. It is also the one thing that makes review slow: a
  broad host permission is checked by a human rather than a bot. Expect days
  rather than minutes on the first submission, and hours on later ones.
- The bridge is **not** declared in the manifest. It is registered at runtime
  against the addresses the user lists on the options page, so a store install
  works on a hosted Notal and not just on `localhost`.

## 3. Zip it

`browser-extension/` becomes the archive, with `manifest.json` at its root — not
inside a folder in the zip.

```
cd notal-ai-ui-main
zip -r /tmp/notal-companion.zip browser-extension -x "*.DS_Store"
```

## 4. Fill the listing in

**Name** (max 45 characters):
`Notal AI — browser companion`

**Summary** (max 132 characters):
`Lets Notal AI read and act on your open tabs. Only your own pages can ask, and every change waits for you.`

**Description** — what a reviewer and a stranger both read:

> Notal AI is a workspace that runs in a browser tab, and this companion is the
> half of it that reaches the rest of the browser. With the plugin switched on in
> Notal's Settings, the assistant can list your tabs, read the text of a page,
> and map the links, buttons and fields on it.
>
> What it cannot do is act without you. Opening a tab, moving one, clicking,
> typing and closing a tab each arrive in Notal as a card that says what is about
> to happen. Nothing runs until that card is approved. Typing refuses a password
> field, and refuses a field whose label has changed since the page was mapped.
> A tab being worked on in the background shows a mark so you can see it.
>
> This companion only answers a page you have named. Any page on localhost or
> 127.0.0.1 counts, because that server is one this machine started; a hosted
> Notal is added on the options page, and its address is the only thing that
> grants access. A page opened from disk is never trusted.
>
> There is no server. The companion talks to the tabs in this Chrome and to the
> Notal page that asked, and nothing else. Uninstalling it removes everything.

**Category**: Developer tools. **Language**: English.
**Visibility**: Public (unlisted if you would rather hand out a link).

## 5. The answers a reviewer asks for

**Single purpose** — the one-sentence version Chrome wants:

> Lets a Notal AI page the user has approved read and act on this browser's other
> tabs, with each action that changes something confirmed by the user first.

**Permissions and justifications**, as they appear in the form:

| Requested | Why it is needed |
| --- | --- |
| `tabs` + `<all_urls>` | The assistant answers a question about a page the user is looking at, so it has to read that page and, once the user approves it, click or type in it. |
| `scripting` | Injects the bridge into the Notal page the user named on the options page, and the page-reading functions into the tab being worked on. |
| `storage` | Keeps the list of addresses allowed to ask, so it survives the extension reloading and follows the user's own Chrome profile. |

There is no remote code: no `externally_connectable`, no hosted script, no
`eval` of anything fetched. Saying so plainly in the justification is what makes
the human review go through.

**Privacy declarations** — for an extension that can read page content, all of
these are the honest answer:
- Single purpose: as above.
- Data handled: content of pages the user opens, and the tab list.
- "Is your extension the seller of user data?" No.
- "Is user data used or transferred for purposes beyond the single purpose?" No.
- "Is user data sold or transferred to third parties?" No.
- Remote code: none — the code is in the package.

**Privacy policy URL**: required once the extension can read page content, which
this one can. It has to be a public page of its own — a GitHub gist or a page on
your own site is fine — saying what is collected (nothing leaves the machine),
where it goes (nowhere), and how to reach you. Google also asks for a contact
address in the listing.

## 6. Store graphics

- Store icon: 128×128 PNG — `icons/icon128.png` is that file.
- At least one screenshot, 1280×800 or 640×400. The two worth taking: the Plugins
  panel in Notal's Settings with Browser switched on and Test reporting the
  companion answering, and an approval card mid-question.

## 7. Upload and wait

Item 6 of the developer dashboard: **Item upload**, choose the zip, fill the
listing, save, then **Publish item**. The status goes Pending review → Live. You
get one email; the review clock restarts if you change anything, so it is worth
getting the listing text right before the first submission.

## 8. After it is live

The unpacked folder keeps working and takes precedence if both are installed —
they are separate entries in `chrome://extensions`. Remove the unpacked one before
testing what a stranger gets, and check the two things that only a store install
reveals: the options page, and whether the bridge reaches a hosted Notal.
