/* The options page for the companion. It knows one thing: which addresses are
   Notal. That list is what background.js registers the bridge against, and what
   it checks every incoming message against, so it is stored in chrome.storage
   rather than kept in a file someone would have to edit and reload. */
"use strict";

const KEY = "notalOrigins";
const $ = (sel) => document.querySelector(sel);

/* The same rule background.js applies, written out again because a service
   worker cannot import a helper from another file — and because an address that
   is refused here is one person is told about, rather than one silently ignored
   later. */
function normalizeOrigin(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.hostname.includes("*")) return null;
  return u.origin;
}

async function readList() {
  const stored = await chrome.storage.sync.get([KEY]);
  return Array.isArray(stored?.[KEY]) ? stored[KEY] : [];
}

async function writeList(list) {
  await chrome.storage.sync.set({ [KEY]: list });
  await render();
}

function originRow(origin) {
  const li = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = origin;

  const drop = document.createElement("button");
  drop.type = "button";
  drop.className = "remove";
  drop.textContent = "Remove";
  drop.addEventListener("click", async () => {
    const list = await readList();
    await writeList(list.filter(x => x !== origin));
    $("#status").textContent = `${origin} is no longer allowed to ask. Reload its tab to take the bridge out of it.`;
  });

  li.append(label, drop);
  return li;
}

async function render() {
  const list = await readList();
  $("#originList").replaceChildren(...list.map(originRow));
  $("#emptyNote").hidden = list.length > 0;
  return list;
}

$("#addForm").addEventListener("submit", (e) => {  e.preventDefault();
  const box = $("#originInput");
  const error = $("#addError");
  const wanted = normalizeOrigin(box.value);
  error.hidden = true;
  if (!wanted) {
    error.textContent = "That is not an address. Notal has to be served over http or https — a file on disk cannot use this companion.";
    error.hidden = false;
    return;
  }
  readList().then((list) => {
    if (list.includes(wanted)) {
      error.textContent = `${wanted} is already listed.`;
      error.hidden = false;
      return;
    }
    return writeList([...list, wanted]).then(() => {
      box.value = "";
      $("#status").textContent = "Saved. Press Connect below so a Notal tab that is already open gets the bridge.";
    });
  });
});

/* a refused address stops being true the moment it is being corrected */
$("#originInput").addEventListener("input", () => { $("#addError").hidden = true; });

$("#rebind").addEventListener("click", async () => {
  const btn = $("#rebind");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  const status = $("#status");
  try {
    const reply = await chrome.runtime.sendMessage({ notalPlugin: 1, method: "rebind" });
    if (!reply?.ok) throw new Error(reply?.error || "the companion did not answer");
    const n = reply.result?.rebound ?? 0;
    status.textContent = n
      ? `Connected ${n} tab${n === 1 ? "" : "s"}: ${reply.result.tabs.map(t => t.url).join(", ")}`
      : "No open tab is at an address this companion knows. Open Notal, or add its address above first.";
  } catch (err) {
    status.textContent = String(err?.message || err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect the Notal tabs already open";
  }
});

render();
