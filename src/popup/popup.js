"use strict";

const pickButton = document.getElementById("pick");
const note = document.getElementById("note");

pickButton.addEventListener("click", async () => {
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
