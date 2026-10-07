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

function setup({ termsAccepted = true, termsDialog = false, signInOnAttach = false, siteState = true, faqText = "", keepInput = false, backLink = false } = {}) {
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
  if (faqText) {
    const faq = w.document.createElement("div");
    faq.textContent = faqText;
    w.document.body.append(faq);
  }
  if (termsDialog) {
    const b = w.document.createElement("button");
    b.textContent = "Agree and continue";
    b.id = "agree";
    w.document.body.append(b);
  }

  // Signed in, the site leaves the upload page for its detection page, shows "Detecting...",
  // then a result or an error card. Going back restores the upload page.
  let detection = null;
  const showUploadPage = () => {
    if (detection) detection.remove();
    detection = null;
    if (!w.document.querySelector("input[type=file]")) {
      const input = w.document.createElement("input");
      input.type = "file";
      input.hidden = true;
      w.document.body.append(input);
    }
  };
  w.addEventListener("popstate", showUploadPage);
  w.document.addEventListener(
    "change",
    () => {
      log.push("change");
      if (signInOnAttach) {
        const d = w.document.createElement("div");
        d.textContent = "Please sign in before detection.";
        w.document.body.append(d);
        return;
      }
      // The window's own timer, so it can't fire after the test closed the window.
      w.setTimeout(() => {
        if (!w.location.pathname.endsWith("-detection")) w.history.pushState({}, "", "/image-detection");
        if (!keepInput) w.document.querySelector("input[type=file]").remove();
        if (detection) detection.remove();
        detection = w.document.createElement("div");
        detection.textContent = "Detecting...";
        w.document.body.append(detection);
        if (backLink) {
          // Like the site's "← Back" link: navigates within the app, no history entry needed.
          const link = w.document.createElement("a");
          link.innerHTML = "<mat-icon>arrow_back</mat-icon> Back";
          link.addEventListener("click", () => {
            log.push("back-link");
            w.history.replaceState({}, "", "/");
            showUploadPage();
          });
          detection.after(link);
          const prevRemove = detection.remove.bind(detection);
          detection.remove = () => {
            link.remove();
            prevRemove();
          };
        }
      }, 20);
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
    // Replace "Detecting..." with what the site shows when it's done.
    showOutcome(kind) {
      detection.textContent = {
        result: "Analysis Results SynthID was not detected",
        error: "error Something went wrong! Please wait and try again later",
        quota: "You will start having image quota again in 3 hours",
      }[kind];
    },
    onDetectionPage: () => !!detection,
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
  await until(() => env.onDetectionPage(), "detection page");
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

// ---------------------------------------------------------------------------
// What the site does with the file

async function attachedSignedIn(opts) {
  const env = setup(opts);
  await env.seedSession();
  env.showAvatar();
  env.start();
  await until(() => env.onDetectionPage(), "detection page");
  return env;
}

test("detecting, then a result: success without buttons that hides itself, no error", async () => {
  const env = await attachedSignedIn();
  await until(() => env.banner() && /File attached/.test(env.banner().text), "success banner");
  assert.deepEqual(env.banner().buttons, []);
  env.showOutcome("result");
  await until(() => env.banner() === null, "banner hides itself", 6000);
  await sleep(300);
  assert.equal(env.banner(), null, "no error banner after a result");
  env.close();
});

test("detecting, then the site's error card: neutral error banner with Try again, which re-attaches", async () => {
  const env = await attachedSignedIn();
  await until(() => env.banner() && /File attached/.test(env.banner().text), "success banner");
  env.showOutcome("error");
  await until(() => env.banner() && /Unexpected error/.test(env.banner().text), "error banner");
  assert.match(env.banner().text, /couldn't check your file\. Please try again later\./);
  assert.doesNotMatch(env.banner().text, /limit|quota/i, "doesn't claim a rate limit");
  assert.ok(env.banner().buttons.includes("Try again"));
  await sleep(4500);
  assert.ok(env.banner() && /Unexpected error/.test(env.banner().text), "error banner stays");

  const button = [...env.w.__bannerRoot.querySelectorAll(".actions button")].find((b) => b.textContent === "Try again");
  button.click(); // back to the upload page, then attach again
  await until(() => env.log.filter((e) => e === "change").length === 2, "second attach after Try again");
  env.close();
});

test("an error after the success banner already hid still shows the error banner", async () => {
  const env = await attachedSignedIn();
  await until(() => env.banner() && /File attached/.test(env.banner().text), "success banner");
  await until(() => env.banner() === null, "success hides", 6000);
  env.showOutcome("error");
  await until(() => env.banner() && /Unexpected error/.test(env.banner().text), "error banner");
  env.close();
});

test("the site's quota message gets the same neutral error banner", async () => {
  const env = await attachedSignedIn();
  env.showOutcome("quota");
  await until(() => env.banner() && /Unexpected error/.test(env.banner().text), "error banner");
  env.close();
});

test("result wording on the home page (FAQ) is never taken as a result", async () => {
  const env = setup({ faqText: "How do I interpret detection results? Analysis Results SynthID was detected" });
  await env.seedSession();
  env.showAvatar();
  env.start();
  await until(() => env.log.includes("change"), "attach");
  // Still on the upload page for a moment: no success yet, only once "Detecting..." shows.
  assert.ok(!(env.banner() && /File attached/.test(env.banner().text)));
  await until(() => env.onDetectionPage(), "detection page");
  await until(() => env.banner() && /File attached/.test(env.banner().text), "success banner");
  env.close();
});

// Reported: Try again showed the old error again immediately. The site keeps its file input on
// the detection page, so the retry attached there while the old error card was still showing.
for (const [name, opts] of [
  ["browser back", { keepInput: true }],
  ["the site's Back link", { keepInput: true, backLink: true }],
]) {
  test(`Try again doesn't re-show the old error before the site reacts (${name})`, async () => {
    const env = await attachedSignedIn(opts);
    env.showOutcome("error");
    await until(() => env.banner() && /Unexpected error/.test(env.banner().text), "error banner");
    const button = [...env.w.__bannerRoot.querySelectorAll(".actions button")].find((b) => b.textContent === "Try again");
    button.click();
    await until(() => env.log.filter((e) => e === "change").length === 2, "second attach");
    if (opts.backLink) assert.ok(env.log.includes("back-link"), "used the site's Back link");
    await sleep(10); // before the site re-renders
    assert.ok(!(env.banner() && /Unexpected error/.test(env.banner().text)), "old error not reported again");

    // The site analyses the new attempt and succeeds this time.
    await until(() => env.banner() && /File attached/.test(env.banner().text), "success for the retry");
    env.showOutcome("result");
    await until(() => env.banner() === null, "banner hides", 6000);
    env.close();
  });
}

test("Try again when the site fails again: the new error is reported after the site reacts", async () => {
  const env = await attachedSignedIn({ keepInput: true });
  env.showOutcome("error");
  await until(() => env.banner() && /Unexpected error/.test(env.banner().text), "error banner");
  [...env.w.__bannerRoot.querySelectorAll(".actions button")].find((b) => b.textContent === "Try again").click();
  await until(() => env.banner() && /File attached/.test(env.banner().text), "retry is detecting");
  env.showOutcome("error");
  await until(() => env.banner() && /Unexpected error/.test(env.banner().text), "new error banner");
  env.close();
});
