"use strict";

const pickButton = document.getElementById("pick");
const note = document.getElementById("note");

// Access to all websites is granted at install but the user can revoke it.
// Checked once at load so the click handler can call permissions.request()
// synchronously (a request after an await no longer counts as a user action).
// Until the check finishes this stays false; requesting an already granted
// permission resolves silently.
const ALL_SITES = { origins: ["<all_urls>"] };
let hasSiteAccess = false;
browser.permissions.contains(ALL_SITES).then(
  (granted) => {
    hasSiteAccess = Boolean(granted);
  },
  (e) => console.warn("SynthID Check: couldn't check site access", e),
);

pickButton.addEventListener("click", async () => {
  // First, before any await. Pick mode starts whatever the answer.
  const access = hasSiteAccess
    ? null
    : browser.permissions.request(ALL_SITES).catch((e) => {
        console.warn("SynthID Check: permissions.request failed", e);
        return false;
      });
  pickButton.disabled = true;
  note.hidden = true;
  let ok = false;
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const reply = await browser.runtime.sendMessage({ type: "synthid:startPicker", tabId: tab?.id });
    ok = Boolean(reply && reply.ok);
  } catch (e) {
    console.warn("SynthID Check: couldn't start the picker", e);
  }
  if (ok) {
    if (access) await access; // keep the popup open while the prompt is up
    window.close();
    return;
  }
  note.hidden = false;
  pickButton.disabled = false;
});

document.getElementById("open-site").addEventListener("click", async () => {
  await browser.tabs.create({ url: "https://synthid.com/" });
  window.close();
});

document.getElementById("settings").addEventListener("click", async () => {
  await browser.runtime.openOptionsPage();
  window.close();
});
