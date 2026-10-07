"use strict";

// Runs the synthid.com content script (banner.js + synthid.js) in jsdom against a
// minimal stand-in for the site's DOM. The live end-to-end check is scripts/test-synthid-live.js.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SRC = path.join(__dirname, "..", "src", "content");
const BANNER = fs.readFileSync(path.join(SRC, "banner.js"), "utf8");
const SYNTHID = fs.readFileSync(path.join(SRC, "synthid.js"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await sleep(20);
  }
  assert.fail("timed out waiting for " + what);
}

function setup({ termsAccepted = true, termsDialog = false, signInOnAttach = false } = {}) {
  const dom = new JSDOM(`<!doctype html><body><input type="file" hidden></body>`, {
    url: "https://synthid.com/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const log = [];

  // jsdom has no DataTransfer and no settable input.files.
  w.DataTransfer = class {
    constructor() {
      const files = [];
      files.item = (i) => files[i];
      this.files = files;
      this.items = { add: (f) => files.push(f) };
    }
  };
  Object.defineProperty(w.HTMLInputElement.prototype, "files", {
    configurable: true,
    get() {
      return this._files;
    },
    set(v) {
      this._files = v;
    },
  });
  w.Element.prototype.getClientRects = function () {
    return [1];
  };
  // jsdom has no innerText; the script reads it to find the sign-in dialog.
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent;
    },
  });

  if (termsAccepted) {
    w.localStorage.setItem("firstTime", JSON.stringify({ isInitialized: true, termsAccepted: true }));
  }
  if (termsDialog) {
    const b = w.document.createElement("button");
    b.textContent = "Agree and continue";
    b.id = "agree";
    w.document.body.append(b);
  }

  w.document.addEventListener(
    "change",
    () => {
      log.push("change");
      if (signInOnAttach) {
        const d = w.document.createElement("div");
        d.textContent = "Please sign in before detection.";
        w.document.body.append(d);
      }
    },
    true,
  );

  // Keep a handle on the closed shadow root so the test can read the banner.
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (init) {
    const root = attach.call(this, init);
    if (this.localName === "synthid-check-banner") w.__bannerRoot = root;
    return root;
  };

  w.browser = {
    runtime: {
      sendMessage: async (m) => {
        log.push(m.type + (m.type === "synthid:attached" ? ":" + m.signInRequired : ""));
        if (m.type === "synthid:getPending") {
          return {
            found: true,
            blob: new w.Blob(["png"], { type: "image/png" }),
            name: "a.png",
            type: "image/png",
            autoAttach: true,
            sourceUrl: "https://example.com/a.png",
          };
        }
        return { ok: true };
      },
    },
  };

  const banner = () => {
    const box = w.__bannerRoot && w.__bannerRoot.querySelector(".box");
    if (!box || box.hidden) return null;
    return {
      text: box.textContent,
      buttons: [...box.querySelectorAll(".actions button")].map((b) => b.textContent),
    };
  };

  return {
    w,
    log,
    banner,
    start() {
      w.eval(BANNER);
      w.eval(SYNTHID);
    },
    close() {
      w.close();
    },
  };
}

test("returning visitor: attaches without waiting, then shows a button-less success that hides itself", async () => {
  const env = setup();
  const t0 = Date.now();
  env.start();
  await until(() => env.log.includes("change"), "attach");
  assert.ok(Date.now() - t0 < 500, "attached within 500 ms, took " + (Date.now() - t0));

  await until(() => env.banner() && /File attached/.test(env.banner().text), "success banner");
  assert.deepEqual(env.banner().buttons, [], "success banner has no action buttons");
  assert.ok(env.log.includes("synthid:attached:false"));

  await until(() => env.banner() === null, "banner hides itself", 6000);
  await until(() => env.log.includes("synthid:clear"), "pending file cleared");
  env.close();
});

test("sign-in needed: shows the sign-in banner with Retry, no auto-hide", async () => {
  const env = setup({ signInOnAttach: true });
  env.start();
  await until(() => env.banner() && /Sign in required/.test(env.banner().text), "sign-in banner");
  assert.ok(env.banner().buttons.includes("Retry"));
  assert.ok(env.log.includes("synthid:attached:true"));
  await sleep(4500);
  assert.ok(env.banner() && /Sign in required/.test(env.banner().text), "sign-in banner stays");
  assert.ok(!env.log.includes("synthid:clear"));
  env.close();
});

test("first visit: never attaches while the Terms dialog is showing", async () => {
  const env = setup({ termsAccepted: false, termsDialog: true });
  env.start();
  await until(() => env.banner() && /Accept the terms/.test(env.banner().text), "terms banner");
  await sleep(1500);
  assert.ok(!env.log.includes("change"), "not attached before acceptance");

  // The user accepts: the site stores it and removes the dialog.
  env.w.localStorage.setItem("firstTime", JSON.stringify({ termsAccepted: true }));
  env.w.document.getElementById("agree").remove();
  await until(() => env.log.includes("change"), "attach after acceptance");
  env.close();
});

test("first visit without the stored flag: waits a short Terms-free period before attaching", async () => {
  const env = setup({ termsAccepted: false });
  const t0 = Date.now();
  env.start();
  await until(() => env.log.includes("change"), "attach", 4000);
  const took = Date.now() - t0;
  assert.ok(took >= 900 && took < 2500, "attached after the safety wait, took " + took);
  env.close();
});
