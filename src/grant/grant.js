"use strict";

(function () {
  const params = new URLSearchParams(location.search);
  const origin = params.get("origin") || "";
  const requestId = params.get("id") || "";
  const match = /^https?:\/\/([^/*]+)\/\*$/.exec(origin);

  const question = document.getElementById("question");
  const allow = document.getElementById("allow");
  const allowAll = document.getElementById("allow-all");
  const cancel = document.getElementById("cancel");
  const status = document.getElementById("status");

  function setStatus(text) {
    status.textContent = text;
    status.hidden = !text;
  }

  function setBusy(busy) {
    allow.disabled = busy || !match;
    allowAll.disabled = busy || !match;
  }

  async function closeSelf() {
    try {
      const tab = await browser.tabs.getCurrent();
      if (tab) {
        await browser.tabs.remove(tab.id);
        return;
      }
    } catch {
      // Fall through to window.close().
    }
    window.close();
  }

  async function onResult(granted) {
    if (!granted) {
      setStatus("Not allowed. SynthID Check can't download this file. You can close this tab.");
      setBusy(false);
      return;
    }
    let reply = null;
    try {
      reply = await browser.runtime.sendMessage({ type: "synthid:granted", requestId });
    } catch {
      reply = null;
    }
    if (reply && reply.ok) {
      closeSelf();
    } else {
      setStatus("Access allowed. The original tab is gone or the request expired, so pick the media again.");
      setBusy(false);
    }
  }

  function request(origins) {
    setBusy(true);
    setStatus("");
    // Called directly in the click handler, as permissions.request() requires.
    browser.permissions.request({ origins }).then(onResult, (e) => {
      setStatus("Couldn't ask for permission: " + (e && e.message ? e.message : String(e)));
      setBusy(false);
    });
  }

  if (match) {
    const host = match[1];
    question.textContent = `Allow SynthID Check to download media from ${host}?`;
    allow.addEventListener("click", () => request([origin]));
    allowAll.addEventListener("click", () => request(["<all_urls>"]));
  } else {
    question.textContent = "This link is not valid.";
    setStatus("Right-click the media again to start a new check.");
  }
  setBusy(false);
  cancel.addEventListener("click", closeSelf);
})();
