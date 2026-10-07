"use strict";

// Runs the synthid.com content script (banner.js + synthid.js) in jsdom against a
// minimal stand-in for the site's DOM. The live end-to-end check is scripts/test-synthid-live.js.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { IDBFactory } = require("fake-indexeddb");

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

// Firebase keeps its saved session in this database (as on synthid.com).
function seedSession(idb) {
  return new Promise((resolve, reject) => {
    const req = idb.open("firebaseLocalStorageDb", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("firebaseLocalStorage", { keyPath: "fbase_key" });
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("firebaseLocalStorage", "readwrite");
      tx.objectStore("firebaseLocalStorage").put({ fbase_key: "firebase:authUser:KEY:[DEFAULT]", value: {} });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

function clearSession(idb) {
  return new Promise((resolve, reject) => {
    const req = idb.open("firebaseLocalStorageDb");
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("firebaseLocalStorage", "readwrite");
      tx.objectStore("firebaseLocalStorage").clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
    };
    req.onerror = () => reject(req.error);
  });
}

function setup({ termsAccepted = true, termsDialog = false, signInOnAttach = false, siteState = true } = {}) {
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

  w.indexedDB = new IDBFactory();
  if (siteState) {
    w.localStorage.setItem("firstTime", JSON.stringify({ isInitialized: true, termsAccepted }));
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
    seedSession: () => seedSession(w.indexedDB),
    clearSession: () => clearSession(w.indexedDB),
    // What the site renders in the account button once a session is restored.
    showAvatar() {
      const a = w.document.createElement("sid-account-avatar");
      const img = w.document.createElement("img");
      img.className = "profile-image";
      a.append(img);
      w.document.body.append(a);
    },
    start() {
      w.eval(BANNER);
      w.eval(SYNTHID);
    },
    close() {
      w.close();
    },
  };
}

test("signed in: waits for the session to be restored, then attaches and shows a button-less success that hides itself", async () => {
  const env = setup();
  await env.seedSession();
  env.start();
  await until(() => env.banner() && /sign you in/.test(env.banner().text), "waiting-for-sign-in banner");
  await sleep(300);
  assert.ok(!env.log.includes("change"), "not attached before the session is restored");

  env.showAvatar(); // Firebase finished restoring the session
  await until(() => env.log.includes("change"), "attach after restore");
  await until(() => env.banner() && /File attached/.test(env.banner().text), "success banner");
  assert.deepEqual(env.banner().buttons, [], "success banner has no action buttons");
  assert.ok(env.log.includes("synthid:attached:false"));

  await until(() => env.banner() === null, "banner hides itself", 6000);
  await until(() => env.log.includes("synthid:clear"), "pending file cleared");
  env.close();
});

test("signed in and already restored: attaches right away", async () => {
  const env = setup();
  await env.seedSession();
  env.showAvatar();
  const t0 = Date.now();
  env.start();
  await until(() => env.log.includes("change"), "attach");
  assert.ok(Date.now() - t0 < 500, "attached within 500 ms, took " + (Date.now() - t0));
  env.close();
});

test("signed out: attaches right away, shows Sign in + Retry, then notices the sign-in", async () => {
  const env = setup({ signInOnAttach: true });
  const t0 = Date.now();
  env.start();
  await until(() => env.log.includes("change"), "attach");
  assert.ok(Date.now() - t0 < 500, "no waiting when there is no saved session");
  await until(() => env.banner() && /Sign in required/.test(env.banner().text), "sign-in banner");
  assert.ok(env.banner().buttons.includes("Retry"));
  assert.ok(env.log.includes("synthid:attached:true"));
  await sleep(4500);
  assert.ok(env.banner() && /Sign in required/.test(env.banner().text), "sign-in banner stays");
  assert.ok(!env.log.includes("synthid:clear"));

  env.showAvatar(); // the user signed in through the site's dialog
  await until(() => env.banner() && /Signed in/.test(env.banner().text), "signed-in banner");
  assert.ok(env.banner().buttons.includes("Retry"));
  env.close();
});

test("expired saved session: attaches as soon as the site drops it, without waiting for a timeout", async () => {
  const env = setup({ signInOnAttach: true });
  await env.seedSession();
  env.start();
  await until(() => env.banner() && /sign you in/.test(env.banner().text), "waiting-for-sign-in banner");
  await env.clearSession(); // Firebase couldn't refresh the session and signed out
  await until(() => env.log.includes("change"), "attach after sign-out", 3000);
  await until(() => env.banner() && /Sign in required/.test(env.banner().text), "sign-in banner");
  env.close();
});

test("first visit: waits for the site's state and never attaches while the Terms dialog is showing", async () => {
  const env = setup({ siteState: false, termsDialog: true });
  env.start();
  await until(() => env.banner() && /Accept the terms/.test(env.banner().text), "terms banner");
  // The app stores its state with the Terms not yet accepted.
  env.w.localStorage.setItem("firstTime", JSON.stringify({ isInitialized: true, termsAccepted: false }));
  await sleep(1500);
  assert.ok(!env.log.includes("change"), "not attached before acceptance");

  // The user accepts: the site stores it and removes the dialog.
  env.w.localStorage.setItem("firstTime", JSON.stringify({ isInitialized: true, termsAccepted: true }));
  env.w.document.getElementById("agree").remove();
  await until(() => env.log.includes("change"), "attach after acceptance");
  env.close();
});

test("Terms not accepted yet but the dialog renders late: still no attach", async () => {
  const env = setup({ termsAccepted: false });
  env.start();
  await sleep(800);
  assert.ok(!env.log.includes("change"), "stored termsAccepted:false blocks attaching");
  const b = env.w.document.createElement("button");
  b.textContent = "Agree and continue";
  env.w.document.body.append(b);
  await until(() => env.banner() && /Accept the terms/.test(env.banner().text), "terms banner");
  env.w.localStorage.setItem("firstTime", JSON.stringify({ isInitialized: true, termsAccepted: true }));
  b.remove();
  await until(() => env.log.includes("change"), "attach after acceptance");
  env.close();
});

test("dismissing while waiting for the sign-in cancels the attach", async () => {
  const env = setup();
  await env.seedSession();
  env.start();
  await until(() => env.banner() && /sign you in/.test(env.banner().text), "waiting-for-sign-in banner");
  env.w.__bannerRoot.querySelector(".close").click();
  env.showAvatar();
  await sleep(600);
  assert.ok(!env.log.includes("change"), "nothing attached after dismiss");
  assert.ok(env.log.includes("synthid:clear"));
  env.close();
});
