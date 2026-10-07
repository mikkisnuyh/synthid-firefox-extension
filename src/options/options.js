"use strict";

(function () {
  const ALL = { origins: ["<all_urls>"] };
  const DEFAULTS = { openInForeground: true, dropZone: true };

  const foreground = document.getElementById("openInForeground");
  const dropZone = document.getElementById("dropZone");
  const accessStatus = document.getElementById("access-status");
  const restoreBlock = document.getElementById("restore-block");
  const restore = document.getElementById("restore");
  const error = document.getElementById("error");

  function showError(e) {
    error.textContent = e ? String(e && e.message ? e.message : e) : "";
    error.hidden = !e;
  }

  async function loadSettings() {
    const s = await browser.storage.sync.get(DEFAULTS);
    foreground.checked = s.openInForeground !== false;
    dropZone.checked = s.dropZone !== false;
  }

  foreground.addEventListener("change", () => {
    browser.storage.sync.set({ openInForeground: foreground.checked }).catch(showError);
  });

  dropZone.addEventListener("change", () => {
    browser.storage.sync.set({ dropZone: dropZone.checked }).catch(showError);
  });

  // Granted at install. Firefox lets users revoke it, so offer a way back.
  async function render() {
    const hasAll = await browser.permissions.contains(ALL);
    accessStatus.textContent = hasAll
      ? "SynthID Check has access to all websites."
      : "Access to websites is turned off, so SynthID Check can't download files to check.";
    restoreBlock.hidden = hasAll;
  }

  restore.addEventListener("click", () => {
    showError(null);
    // permissions.request() must be called directly from the click.
    browser.permissions.request(ALL).then(render, showError);
  });

  browser.permissions.onAdded.addListener(() => render().catch(showError));
  browser.permissions.onRemoved.addListener(() => render().catch(showError));

  document.getElementById("version").textContent = "v" + browser.runtime.getManifest().version;

  loadSettings().catch(showError);
  render().catch(showError);
})();
