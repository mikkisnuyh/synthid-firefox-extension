"use strict";

(function () {
  const ALL = "<all_urls>";
  // Content-script host permission: removing it would break the extension.
  const SYNTHID_ORIGIN = "https://synthid.com/*";
  const DEFAULTS = { openInForeground: true };

  const foreground = document.getElementById("openInForeground");
  const allStatus = document.getElementById("all-status");
  const toggleAll = document.getElementById("toggle-all");
  const sitesBlock = document.getElementById("sites-block");
  const sites = document.getElementById("sites");
  const error = document.getElementById("error");

  let hasAll = false;

  function showError(e) {
    error.textContent = e ? String(e && e.message ? e.message : e) : "";
    error.hidden = !e;
  }

  async function loadSettings() {
    const s = await browser.storage.sync.get(DEFAULTS);
    foreground.checked = s.openInForeground !== false;
  }

  foreground.addEventListener("change", () => {
    browser.storage.sync.set({ openInForeground: foreground.checked }).catch(showError);
  });

  function siteLabel(pattern) {
    const m = /^(\*|https?):\/\/([^/]+)\//.exec(pattern);
    return m ? m[2] : pattern;
  }

  async function render() {
    const perms = await browser.permissions.getAll();
    const origins = perms.origins || [];
    hasAll = origins.includes(ALL) || origins.includes("*://*/*");

    allStatus.textContent = hasAll
      ? "SynthID Check can download media from all sites."
      : "SynthID Check asks before downloading media from a new site.";
    toggleAll.textContent = hasAll ? "Remove access to all sites" : "Allow all sites";

    const specific = origins.filter((o) => o !== ALL && o !== "*://*/*" && o !== SYNTHID_ORIGIN);
    sites.textContent = "";
    for (const origin of specific) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = siteLabel(origin);
      name.title = origin;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "link";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        browser.permissions.remove({ origins: [origin] }).then(render, showError);
      });
      li.append(name, remove);
      sites.appendChild(li);
    }
    sitesBlock.hidden = specific.length === 0;
  }

  toggleAll.addEventListener("click", () => {
    showError(null);
    // permissions.request() must be called directly from the click.
    const op = hasAll
      ? browser.permissions.remove({ origins: [ALL] })
      : browser.permissions.request({ origins: [ALL] });
    op.then(render, showError);
  });

  browser.permissions.onAdded.addListener(() => render().catch(showError));
  browser.permissions.onRemoved.addListener(() => render().catch(showError));

  loadSettings().catch(showError);
  render().catch(showError);
})();
