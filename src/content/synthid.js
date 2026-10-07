/* synthid.com content script: attaches the pending file to the site's own upload form.
 * Never clicks the Terms button, never retries without a user click. */
(function () {
  "use strict";
  // Strict check: page elements named "__synthidCheckLoaded" can't satisfy `=== true`.
  if (globalThis.__synthidCheckLoaded === true) return;
  globalThis.__synthidCheckLoaded = true;

  // Everything below waits for page state (DOM, synthid.com's own stored state, Firebase's
  // saved session), not for fixed delays. These limits are only fallbacks in case the site
  // changes; they are generous so slow connections and computers aren't affected.
  const FILE_INPUT_MAX_MS = 60000;
  const SITE_STATE_MAX_MS = 30000; // synthid.com writes its state (incl. Terms) at startup
  const AUTH_RESTORE_MAX_MS = 30000; // Firebase restoring a saved session
  const SIGN_IN_PROMPT_MAX_MS = 15000; // signed out: the site's sign-in prompt after attaching
  const TERMS_WAIT_MS = 10 * 60 * 1000; // the user reading the Terms
  const SUCCESS_HIDE_MS = 4000; // UI only: how long the success banner stays

  const Banner = globalThis.SynthIDBanner;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (msg) => browser.runtime.sendMessage(msg);

  let file = null;
  let busy = false;
  let dismissed = false;
  let hideTimer = null;

  function show(o) {
    if (dismissed) return;
    clearTimeout(hideTimer);
    try {
      Banner.show(o);
    } catch (e) {
      console.warn("SynthID Check: banner failed", e);
    }
  }

  function isVisible(el) {
    return !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
  }

  function termsShown() {
    for (const b of document.querySelectorAll("button, [role=button]")) {
      if (/agree and continue/i.test(b.textContent || "") && isVisible(b)) return true;
    }
    return false;
  }

  // synthid.com keeps its state in localStorage ("firstTime"), written once the app has
  // started: {isInitialized, termsAccepted, ...}. null until then.
  function siteState() {
    try {
      const v = JSON.parse(localStorage.getItem("firstTime") || "null");
      return v && typeof v === "object" ? v : null;
    } catch (e) {
      return null;
    }
  }

  // true: Terms accepted and no dialog; false: not (yet) accepted; null: unknown format.
  function termsAccepted() {
    const st = siteState();
    if (!st || !("termsAccepted" in st)) return null;
    return st.termsAccepted === true && !termsShown();
  }

  // The account button shows a profile picture (or monogram) only when signed in.
  function avatarSignedIn() {
    return !!document.querySelector("sid-account-avatar .profile-image");
  }

  const AUTH_DB = "firebaseLocalStorageDb";
  const AUTH_STORE = "firebaseLocalStorage";

  // Does synthid.com's Firebase have a saved session? true/false, or null if it can't be read.
  // Read-only: never creates the database (that would break the site's own setup of it).
  async function savedSession() {
    try {
      if (typeof indexedDB.databases !== "function") return null;
      const dbs = await indexedDB.databases();
      if (!dbs.some((d) => d.name === AUTH_DB)) return false;
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(AUTH_DB);
        req.onupgradeneeded = () => {
          req.transaction.abort();
          reject(new Error("no auth database"));
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        if (!db.objectStoreNames.contains(AUTH_STORE)) return false;
        const keys = await new Promise((resolve, reject) => {
          const req = db.transaction(AUTH_STORE, "readonly").objectStore(AUTH_STORE).getAllKeys();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        return keys.some((k) => String(k).startsWith("firebase:authUser:"));
      } finally {
        db.close();
      }
    } catch (e) {
      return null;
    }
  }

  function signInShown() {
    const t = document.body ? document.body.innerText || document.body.textContent || "" : "";
    return /please sign in before detection/i.test(t);
  }

  // Resolves with check()'s truthy result, or null on timeout/dismiss.
  function waitFor(check, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      let mo = null;
      let timer = null;
      let poll = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        if (mo) mo.disconnect();
        clearTimeout(timer);
        clearInterval(poll);
        resolve(v);
      };
      const test = () => {
        if (dismissed) return finish(null);
        let v = null;
        try {
          v = check();
        } catch (e) {
          v = null;
        }
        if (v) finish(v);
      };
      test();
      if (done) return;
      mo = new MutationObserver(test);
      mo.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
      poll = setInterval(test, 500);
      timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  // Like waitFor, for async checks (IndexedDB). Re-checks on DOM changes, at most every 250 ms.
  function waitForAsync(check, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      let running = false;
      let again = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        mo.disconnect();
        clearTimeout(timer);
        clearInterval(poll);
        resolve(v);
      };
      const test = async () => {
        if (done) return;
        if (dismissed) return finish(null);
        if (running) {
          again = true;
          return;
        }
        running = true;
        try {
          const v = await check();
          if (v) finish(v);
        } catch (e) {
          // keep waiting
        }
        running = false;
        if (again && !done) {
          again = false;
          setTimeout(test, 250);
        }
      };
      const mo = new MutationObserver(() => test());
      mo.observe(document, { childList: true, subtree: true, attributes: true });
      const poll = setInterval(test, 1000);
      const timer = setTimeout(() => finish(null), timeoutMs);
      test();
    });
  }

  const isImage = () => !!file && /^image\//.test(file.type || "");

  function fileInput() {
    return document.querySelector("input[type=file]");
  }

  function inputEvents(target, make) {
    target.dispatchEvent(make("input"));
    target.dispatchEvent(make("change"));
  }

  // Standard path: content-script objects only.
  function assignToInput(input) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    if (!input.files || input.files.length !== 1) throw new Error("input.files not set");
    inputEvents(input, (t) => new Event(t, { bubbles: true }));
  }

  function pasteToDocument() {
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    if (!ev.clipboardData || !ev.clipboardData.files.length) throw new Error("clipboardData not set");
    (document.activeElement || document).dispatchEvent(ev);
  }

  // Firefox only: build everything in the page's own compartment.
  function xrayAvailable() {
    return typeof cloneInto === "function" && !!window.wrappedJSObject;
  }

  function pageObject(w, props) {
    const o = new w.Object();
    for (const k of Object.keys(props)) o[k] = props[k];
    return o;
  }

  function pageDataTransfer(w) {
    const pf = new w.File(cloneInto([file], w), file.name, pageObject(w, { type: file.type }));
    const dt = new w.DataTransfer();
    dt.items.add(pf);
    return dt;
  }

  function assignToInputXray(input) {
    const w = window.wrappedJSObject;
    const pi = input.wrappedJSObject || input;
    pi.files = pageDataTransfer(w).files;
    if (!pi.files || pi.files.length !== 1) throw new Error("page input.files not set");
    inputEvents(pi, (t) => new w.Event(t, pageObject(w, { bubbles: true })));
  }

  function pasteXray() {
    const w = window.wrappedJSObject;
    const ev = new w.ClipboardEvent(
      "paste",
      pageObject(w, { clipboardData: pageDataTransfer(w), bubbles: true, cancelable: true })
    );
    (w.document.activeElement || w.document).dispatchEvent(ev);
  }

  // Returns the name of the method that worked; throws if none did.
  function attach(input) {
    if (dismissed) throw new Error("dismissed");
    if (termsShown()) throw new Error("terms dialog is showing");
    const steps = [];
    if (input) {
      steps.push(["input", () => assignToInput(input)]);
      if (xrayAvailable()) steps.push(["input-xray", () => assignToInputXray(input)]);
    }
    steps.push(["paste", pasteToDocument]);
    if (xrayAvailable()) steps.push(["paste-xray", pasteXray]);
    let last = null;
    for (const [name, fn] of steps) {
      try {
        fn();
        return name;
      } catch (e) {
        last = e;
      }
    }
    throw last || new Error("no attach method available");
  }

  function actionsAfter(extra) {
    const a = extra.slice();
    if (isImage()) a.push({ id: "copy", label: "Copy image" });
    return a;
  }

  function showFailure() {
    const hint = isImage()
      ? "Press Copy image, then Ctrl+V on the page."
      : "Download the file and upload it on synthid.com yourself.";
    show({
      state: "error",
      title: "Couldn't attach the file",
      message: hint,
      actions: actionsAfter([{ id: "attach", label: "Attach again" }]),
    });
  }

  // Resolves when it's safe to attach as far as the Terms are concerned. Never clicks them.
  async function termsReady() {
    for (;;) {
      if (dismissed) return false;
      // Wait until the site has started and recorded its Terms state, or shows the dialog.
      const known = await waitFor(() => termsShown() || termsAccepted() !== null, SITE_STATE_MAX_MS);
      if (dismissed) return false;
      if (!known) {
        // Unknown storage format (site changed): fall back to the dialog alone.
        return !termsShown() || (await waitTermsGone());
      }
      if (termsAccepted() === true) return true;
      if (!(await waitTermsGone())) return false;
    }
  }

  async function waitTermsGone() {
    show({
      state: "info",
      title: "SynthID Check",
      message: "Accept the terms to continue. Your file will be attached afterwards.",
    });
    // Accepting removes the dialog and stores termsAccepted: true.
    const ok = await waitFor(() => termsAccepted() === true || (termsAccepted() === null && !termsShown()), TERMS_WAIT_MS);
    if (!ok && !dismissed) {
      show({
        state: "warn",
        title: "SynthID Check",
        message: "The terms were not accepted in time. Accept them, then press Attach file.",
        actions: actionsAfter([{ id: "attach", label: "Attach file", primary: true }]),
      });
    }
    return !!ok;
  }

  // If Firebase has a saved session, wait until the page has restored it. Attaching earlier makes
  // the site treat the user as signed out. Returns whether the user is signed in.
  async function signInRestored() {
    if (avatarSignedIn()) return true;
    const saved = await savedSession();
    if (dismissed) return false;
    if (saved === false) return false;
    show({ state: "working", title: "SynthID Check", message: "Waiting for synthid.com to sign you in…" });
    // Done when the page shows the user signed in, or the saved session is gone (expired).
    const r = await waitForAsync(async () => {
      if (avatarSignedIn()) return "in";
      if (saved === true && (await savedSession()) === false) return "out";
      return null;
    }, AUTH_RESTORE_MAX_MS);
    return r === "in";
  }

  function showSignIn() {
    show({
      state: "warn",
      title: "Sign in required",
      message: "Sign in, then press Retry.",
      actions: actionsAfter([{ id: "retry", label: "Retry", primary: true }]),
    });
    // Tell the user as soon as the sign-in has gone through.
    waitFor(avatarSignedIn, TERMS_WAIT_MS).then((ok) => {
      if (ok && !dismissed && !busy) {
        show({
          state: "info",
          title: "Signed in",
          message: "Press Retry to check your file.",
          actions: actionsAfter([{ id: "retry", label: "Retry", primary: true }]),
        });
      }
    });
  }

  function showSuccess() {
    show({ state: "success", title: "File attached", message: "The result appears on the page." });
    hideTimer = setTimeout(() => {
      try {
        Banner.hide();
      } catch (e) {
        // ignore
      }
      // Done: a later reload of synthid.com shouldn't offer this file again.
      send({ type: "synthid:clear" }).catch(() => {});
    }, SUCCESS_HIDE_MS);
  }

  async function run() {
    if (busy || !file || dismissed) return;
    busy = true;
    try {
      show({ state: "working", title: "SynthID Check", message: "Attaching your file…" });
      const input = await waitFor(fileInput, FILE_INPUT_MAX_MS);
      if (dismissed) return;
      if (!input) throw new Error("file input not found");

      if (!(await termsReady())) return;
      const signedIn = await signInRestored();
      if (dismissed) return;
      // The Terms dialog may have come back while waiting for the sign-in (e.g. a reload).
      if (!(await termsReady())) return;
      show({ state: "working", title: "SynthID Check", message: "Attaching your file…" });

      const method = attach(fileInput() || input);
      console.debug("SynthID Check: attached via", method);

      if (signedIn) {
        send({ type: "synthid:attached", signInRequired: false }).catch(() => {});
        showSuccess();
        // Shouldn't happen, but if the site asks for sign-in anyway, say so.
        waitFor(signInShown, SUCCESS_HIDE_MS).then((seen) => {
          if (seen && !dismissed) {
            send({ type: "synthid:attached", signInRequired: true }).catch(() => {});
            showSignIn();
          }
        });
        return;
      }

      // Signed out: the site answers with its sign-in prompt.
      const prompt = await waitFor(signInShown, SIGN_IN_PROMPT_MAX_MS);
      if (dismissed) return;
      send({ type: "synthid:attached", signInRequired: !!prompt }).catch(() => {});
      if (prompt) showSignIn();
      else showSuccess();
    } catch (e) {
      if (dismissed) return;
      console.warn("SynthID Check: attach failed", e);
      showFailure();
    } finally {
      busy = false;
    }
  }

  async function toPng(blob) {
    if (blob.type === "image/png") return blob;
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d").drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG conversion failed"))), "image/png")
    );
  }

  async function copyImage() {
    if (!isImage()) {
      show({ state: "info", title: "SynthID Check", message: "Download the file and drag it onto the page." });
      return;
    }
    try {
      // The promise keeps the click's user activation while the PNG is prepared.
      const item = new ClipboardItem({ "image/png": toPng(file) });
      await navigator.clipboard.write([item]);
      show({
        state: "success",
        title: "Copied",
        message: "Copied, press Ctrl+V on the page.",
        actions: [{ id: "attach", label: "Attach again" }],
      });
    } catch (e) {
      console.warn("SynthID Check: copy failed", e);
      show({
        state: "error",
        title: "Couldn't copy the image",
        message: "Download the file and upload it on synthid.com yourself.",
        actions: [{ id: "attach", label: "Attach again" }],
      });
    }
  }

  function onAction(id) {
    if (id === "dismiss") {
      dismissed = true;
      clearTimeout(hideTimer);
      send({ type: "synthid:clear" }).catch(() => {});
    } else if (id === "retry" || id === "attach") {
      run();
    } else if (id === "copy") {
      copyImage();
    }
  }

  // At document_start the root element may not exist yet (Firefox guarantees it, other
  // injectors don't). The banner and observers need it.
  function documentRoot() {
    if (document.documentElement) return Promise.resolve();
    return new Promise((resolve) => {
      const mo = new MutationObserver(() => {
        if (document.documentElement) {
          mo.disconnect();
          resolve();
        }
      });
      mo.observe(document, { childList: true });
    });
  }

  async function main() {
    let res;
    try {
      // Runs at document_start, so the file transfer overlaps with the page loading.
      res = await send({ type: "synthid:getPending" });
    } catch (e) {
      return;
    }
    if (!res || !res.found || !res.blob) return;
    await documentRoot();
    file = new File([res.blob], res.name || "synthid-check", { type: res.type || res.blob.type || "" });
    Banner.onAction(onAction);

    if (!res.autoAttach) {
      let host = "";
      try {
        host = new URL(res.sourceUrl).hostname;
      } catch (e) {
        // sourceUrl is optional in the reply
      }
      show({
        state: "info",
        title: "SynthID Check",
        message: host ? "File from " + host + " is ready." : "Your file is ready.",
        actions: actionsAfter([{ id: "attach", label: "Attach again", primary: true }]),
      });
      return;
    }
    await run();
  }

  main().catch((e) => {
    console.warn("SynthID Check: unexpected error", e);
    if (file) showFailure();
  });
})();
