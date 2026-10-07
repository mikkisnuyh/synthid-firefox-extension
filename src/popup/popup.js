"use strict";

const pickButton = document.getElementById("pick");

// Describe drag and drop as currently set up. Runs on load and whenever the
// main view is shown again, so changes made in Settings show up.
const CORNERS = ["top-right", "bottom-right", "top-left", "bottom-left"];
function refreshDragText() {
  return browser.storage.sync.get({ dropZone: true, dropZoneCorner: "top-right" }).then(
    (s) => {
      const on = s.dropZone !== false;
      document.getElementById("way-drag").hidden = !on;
      document.getElementById("way-drag-off").hidden = on;
      document.getElementById("corner").textContent = CORNERS.includes(s.dropZoneCorner)
        ? s.dropZoneCorner
        : "top-right";
    },
    (e) => console.warn("SynthID Check: couldn't read the settings", e),
  );
}
refreshDragText();
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

// View switching. The popup always opens on the main view.
const mainView = document.getElementById("main-view");
const settingsView = document.getElementById("settings-view");
const settingsButton = document.getElementById("settings");
const backButton = document.getElementById("back");

function showSettings() {
  mainView.hidden = true;
  settingsView.hidden = false;
  window.SettingsView.refresh();
  document.documentElement.scrollTop = 0;
  backButton.focus();
}

function showMain() {
  window.SettingsView.cancelRecording();
  settingsView.hidden = true;
  mainView.hidden = false;
  refreshDragText();
  settingsButton.focus();
}

settingsButton.addEventListener("click", showSettings);
backButton.addEventListener("click", showMain);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || settingsView.hidden) return;
  if (window.SettingsView.isRecording()) return;
  e.preventDefault();
  showMain();
});
