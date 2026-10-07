"use strict";

/* global SynthIDMedia, SynthIDPending */

const Media = SynthIDMedia;
const DiskPending = SynthIDPending;

// Pending records. Media from private windows must never reach on-disk
// IndexedDB, so those live in memory (lost if the event page unloads).
const memoryPending = new Map();

const Pending = {
  put(record, incognito) {
    if (!incognito) return DiskPending.put(record);
    memoryPending.set(record.tabId, {
      createdAt: Date.now(),
      autoAttach: true,
      attachedAt: null,
      signInSeen: false,
      ...record,
    });
    return Promise.resolve();
  },
  async get(tabId) {
    const rec = memoryPending.get(tabId);
    if (rec) {
      if (Date.now() - rec.createdAt <= DiskPending.TTL_MS) return rec;
      memoryPending.delete(tabId);
      return null;
    }
    return DiskPending.get(tabId);
  },
  async update(tabId, patch) {
    const rec = memoryPending.get(tabId);
    if (!rec) return DiskPending.update(tabId, patch);
    const updated = { ...rec, ...patch, tabId };
    memoryPending.set(tabId, updated);
    return updated;
  },
  async remove(tabId) {
    if (memoryPending.delete(tabId)) return undefined;
    return DiskPending.remove(tabId);
  },
  clear() {
    memoryPending.clear();
    return DiskPending.clear();
  },
  purgeExpired() {
    const now = Date.now();
    for (const [id, rec] of memoryPending) {
      if (now - rec.createdAt > DiskPending.TTL_MS) memoryPending.delete(id);
    }
    return DiskPending.purgeExpired();
  },
};

const SYNTHID_URL = "https://synthid.com/";
const POPUP_PAGE = "src/popup/popup.html";
const ALL_SITES = "<all_urls>";
const WORKING_NOTICE_DELAY_MS = 800;
const DEFAULT_SETTINGS = { openInForeground: true };

const TEXT = {
  title: "SynthID Check",
  nothingFound: "No image, video or audio found here.",
  streaming:
    "This is a streaming video and can't be captured. Download the file and upload it on synthid.com yourself.",
  unsupported: (what) =>
    "SynthID can check JPG, PNG, WebP, GIF, AVIF, HEIC, TIFF, BMP images, MP3/WAV/OGG/FLAC/AAC/M4A audio " +
    `and MP4/MOV/WebM video. This file is ${what}.`,
  siteAccess:
    "SynthID Check needs access to websites to download this file. " +
    "Allow it in the extension's settings (about:addons → SynthID Check → Permissions).",
  fetchFailed: (status) =>
    `Couldn't download the file (${status}). Try saving it and uploading it on synthid.com.`,
  tooLarge: (mb) => `This file is larger than ${mb} MB. Try a smaller file.`,
  empty: "The file is empty.",
  unsupportedUrl: "This file's address can't be downloaded. Try saving it and uploading it on synthid.com.",
  badDataUrl: "Couldn't read this embedded file. Try saving it and uploading it on synthid.com.",
  blobFailed: "Couldn't read this file from the page. Try saving it and uploading it on synthid.com.",
  working: "Getting the file…",
  synthidAccess:
    "SynthID Check needs access to synthid.com to attach the file. " +
    "Re-enable it in the extension's settings (about:addons → SynthID Check → Permissions).",
};
const SYNTHID_ORIGIN_PATTERN = "https://synthid.com/*";

class Notice extends Error {
  constructor(message, state = "error") {
    super(message);
    this.state = state;
  }
}

// The background fetch failed at the network level (not an HTTP status).
class NetworkError extends Error {}

// ---------------------------------------------------------------------------
// Site access. <all_urls> is a required host permission, granted at install.
// Firefox lets users revoke it later, so keep a synchronous cache of whether it
// is granted: user-action handlers must call permissions.request() before any
// await, and need an immediate answer to "do we have access already?".

const siteAccess = { all: false };

function hasAllSites(origins) {
  return (origins || []).some((o) => o === ALL_SITES || o === "*://*/*");
}

function refreshSiteAccess() {
  return browser.permissions.getAll().then((perms) => {
    siteAccess.all = hasAllSites(perms.origins);
  }, (e) => console.warn("SynthID Check: permissions.getAll failed", e));
}

refreshSiteAccess();
browser.permissions.onAdded.addListener((perms) => {
  if (hasAllSites(perms && perms.origins)) siteAccess.all = true;
  refreshSiteAccess();
});
browser.permissions.onRemoved.addListener((perms) => {
  if (hasAllSites(perms && perms.origins)) siteAccess.all = false;
  refreshSiteAccess();
});

// If access to all sites is missing, ask for it. Call this synchronously from a
// user-action handler (before any await). Never rejects; resolves to whether
// access is granted. Callers continue either way: the same-origin in-page fetch
// works without it, and getFile shows a notice when a download needs it.
function requestSiteAccess() {
  if (siteAccess.all) return Promise.resolve(true);
  try {
    return browser.permissions.request({ origins: [ALL_SITES] }).then(
      (granted) => {
        if (granted) siteAccess.all = true;
        return Boolean(granted);
      },
      (e) => {
        console.warn("SynthID Check: permissions.request failed", e);
        return false;
      },
    );
  } catch (e) {
    console.warn("SynthID Check: permissions.request failed", e);
    return Promise.resolve(false);
  }
}

// ---------------------------------------------------------------------------
// Helpers

function isHttp(url) {
  return typeof url === "string" && /^https?:/i.test(url);
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

async function getSettings() {
  try {
    return await browser.storage.sync.get(DEFAULT_SETTINGS);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// Notices run one at a time per tab so a late "working" notice can't cover an
// error, and one stalled tab can't delay notices in other tabs.
const noticeQueues = new Map();

function enqueueNotice(tabId, task) {
  const next = (noticeQueues.get(tabId) || Promise.resolve()).then(task);
  const tail = next.catch(() => {});
  noticeQueues.set(tabId, tail);
  tail.then(() => {
    if (noticeQueues.get(tabId) === tail) noticeQueues.delete(tabId);
  });
  return next;
}

function notify(tabId, notice) {
  return enqueueNotice(tabId, () => showNotice(tabId, notice));
}

function hideNotice(tabId) {
  return enqueueNotice(tabId, () => hideBanner(tabId));
}

async function showNotice(tabId, notice) {
  if (tabId == null || tabId < 0) return;
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["src/content/banner.js"],
      injectImmediately: true,
    });
    await browser.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: (n) => {
        SynthIDBanner.show(n);
      },
      args: [{ title: TEXT.title, actions: [], ...notice }],
    });
  } catch (e) {
    console.warn("SynthID Check:", notice.message, e);
  }
}

async function hideBanner(tabId) {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: () => {
        if (typeof globalThis.SynthIDBanner?.hide === "function") SynthIDBanner.hide();
      },
    });
  } catch {
    // Nothing to hide.
  }
}

async function injectResolve(tabId, frameId) {
  await browser.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files: ["src/content/resolve.js"],
    injectImmediately: true,
  });
}

// executeScript results are structured-cloned; accept a Blob or raw bytes.
function toBlob(value, type) {
  if (value instanceof Blob) return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return new Blob([value], { type: type || "" });
  return null;
}

// ---------------------------------------------------------------------------
// Menus

// onInstalled and onStartup can both fire (e.g. the first start after an update),
// so rebuilds run one at a time; interleaved removeAll/create calls would
// otherwise create duplicate ids.
let menusBuild = Promise.resolve();

function createMenus() {
  menusBuild = menusBuild
    .then(() => browser.menus.removeAll())
    .then(() => {
      browser.menus.create({
        id: "check-media",
        title: "Check with SynthID",
        contexts: ["image", "video", "audio"],
      });
      browser.menus.create({
        id: "find-media",
        title: "Find media here and check with SynthID",
        contexts: ["page", "frame", "link"],
      });
    })
    .catch((e) => console.warn("SynthID Check: creating menus failed", e));
  return menusBuild;
}

browser.runtime.onInstalled.addListener(() => {
  createMenus();
});
browser.runtime.onStartup.addListener(() => {
  createMenus();
  // Tab ids restart each session; a stale file must not attach to an unrelated tab.
  Pending.clear().catch((e) => console.warn("SynthID Check: clearing pending files failed", e));
});

browser.menus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null || tab.id < 0) return;
  if (info.menuItemId !== "check-media" && info.menuItemId !== "find-media") return;
  // Synchronously, before any await: only a user-action handler may prompt.
  const access = requestSiteAccess();
  if (info.menuItemId === "check-media") onCheckMedia(info, tab, access);
  else onFindMedia(info, tab, access);
});

function onCheckMedia(info, tab, access) {
  const url = info.srcUrl;
  const frameId = info.frameId ?? 0;
  const pageUrl = info.pageUrl || tab.url;
  const ctx = { tab, frameId, frameUrl: info.frameUrl || pageUrl, pageUrl };

  // No usable URL (or a blob: URL): let resolve.js inspect the element instead.
  if (!url || /^blob:/i.test(url)) {
    onFindMedia(info, tab, access);
    return;
  }

  const media = { kind: info.mediaType || "image", url, isBlob: false, isMediaSource: false };
  access.then(() => acquire(media, ctx));
}

async function onFindMedia(info, tab, access = Promise.resolve(true)) {
  const frameId = info.frameId ?? 0;
  const pageUrl = info.pageUrl || tab.url;
  const ctx = { tab, frameId, frameUrl: info.frameUrl || pageUrl, pageUrl };
  let media = null;
  try {
    await injectResolve(tab.id, frameId);
    const [res] = await browser.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId] },
      injectImmediately: true,
      func: (targetId) => {
        const el = targetId != null ? browser.menus.getTargetElement(targetId) : null;
        const m = el ? SynthIDResolve.fromElement(el) : null;
        return m ? { kind: m.kind, url: m.url, isBlob: m.isBlob, isMediaSource: m.isMediaSource } : null;
      },
      args: [info.targetElementId ?? null],
    });
    media = res && res.result;
  } catch (e) {
    console.warn("SynthID Check: couldn't inspect the page", e);
  }
  if (!media || !media.url) {
    notify(tab.id, { state: "info", message: TEXT.nothingFound });
    return;
  }
  await access; // the permission prompt, if any, was raised by the click
  acquire(media, ctx);
}

// ---------------------------------------------------------------------------
// Toolbar menu / shortcut: pick mode
//
// The toolbar button opens the popup menu (action.onClicked doesn't fire when a
// popup is set). Its "Pick media" button and the start-picker shortcut both end up here.

async function startPicker(tabId) {
  if (typeof tabId !== "number") return false;
  try {
    await browser.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ["src/content/resolve.js", "src/content/picker.js"],
      injectImmediately: true,
    });
    await browser.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      injectImmediately: true,
      func: () => {
        SynthIDPicker.start();
      },
    });
    return true;
  } catch (e) {
    console.warn("SynthID Check: can't start the picker on this page", e);
    return false;
  }
}

browser.commands.onCommand.addListener(async (name, tab) => {
  if (name !== "start-picker") return;
  // Synchronously, before any await. Not awaited: pick mode starts regardless.
  requestSiteAccess();
  let tabId = tab?.id;
  if (typeof tabId !== "number") {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    tabId = active?.id;
  }
  startPicker(tabId);
});

// ---------------------------------------------------------------------------
// Getting the file

async function acquire(media, ctx) {
  const tabId = ctx.tab.id;
  let finished = false;
  let workingShown = false;
  const timer = setTimeout(() => {
    if (finished) return;
    workingShown = true;
    notify(tabId, { state: "working", message: TEXT.working });
  }, WORKING_NOTICE_DELAY_MS);

  try {
    const file = await getFile(media, ctx);
    const checked = validate(file, media.url);
    await openSynthId(checked, sourceUrlFor(media, ctx), ctx.tab);
    finished = true;
    if (workingShown) hideNotice(tabId);
  } catch (e) {
    finished = true;
    if (e instanceof Notice) {
      notify(tabId, { state: e.state, message: e.message });
    } else {
      console.error("SynthID Check:", e);
      notify(tabId, { state: "error", message: TEXT.fetchFailed("error") });
    }
  } finally {
    clearTimeout(timer);
  }
}

function sourceUrlFor(media, ctx) {
  return isHttp(media.url) ? media.url : ctx.frameUrl || ctx.tab.url || "";
}

async function getFile(media, ctx) {
  const url = media.url;
  if (media.isMediaSource) throw new Notice(TEXT.streaming, "warn");

  if (/^data:/i.test(url)) {
    try {
      const blob = Media.dataUrlToBlob(url);
      return { blob, type: blob.type, url };
    } catch {
      throw new Notice(TEXT.badDataUrl);
    }
  }

  if (/^blob:/i.test(url)) return readBlobInFrame(media, ctx);

  if (!isHttp(url)) throw new Notice(TEXT.unsupportedUrl);

  let granted = siteAccess.all;
  if (!granted) {
    try {
      granted = await browser.permissions.contains({ origins: [ALL_SITES] });
    } catch {
      granted = false;
    }
  }
  if (granted) {
    try {
      return await fetchInBackground(url);
    } catch (e) {
      // E.g. a redirect to a host we have no permission for. Fall back once.
      if (!(e instanceof NetworkError)) throw e;
      console.warn("SynthID Check: background fetch failed, trying the fallback", e);
    }
  }

  // activeTab covers the page's own origin, so fetch from inside the page.
  // The media may belong to the top-level page while the click was in a cross-origin frame.
  const fetchFrameId = sameOrigin(url, ctx.frameUrl)
    ? ctx.frameId
    : ctx.pageUrl && sameOrigin(url, ctx.pageUrl)
      ? 0
      : null;
  if (fetchFrameId !== null) {
    const result = await fetchInFrame(url, ctx, fetchFrameId).catch((e) => {
      console.warn("SynthID Check: in-page fetch unavailable", e);
      return null;
    });
    if (result) return result;
  }

  if (granted) throw new Notice(TEXT.fetchFailed("network error"));
  throw new Notice(TEXT.siteAccess, "warn");
}

async function fetchInBackground(url) {
  const tooLarge = () => new Notice(TEXT.tooLarge(Media.MAX_BYTES / 1048576));
  const controller = new AbortController();
  let res;
  try {
    res = await fetch(url, { credentials: "include", cache: "force-cache", signal: controller.signal });
  } catch {
    throw new NetworkError("fetch failed");
  }
  if (!res.ok) throw new Notice(TEXT.fetchFailed(res.status));
  if (Number(res.headers.get("content-length")) > Media.MAX_BYTES) {
    controller.abort();
    throw tooLarge();
  }
  const type = res.headers.get("content-type") || "";
  if (!res.body) {
    const blob = await res.blob();
    return { blob, type: blob.type || type, url: res.url || url };
  }
  // No (or wrong) content-length: count bytes and stop early past the cap.
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > Media.MAX_BYTES) {
        controller.abort();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof Notice) throw e;
    throw new NetworkError("body read failed");
  }
  const blob = new Blob(chunks, { type });
  return { blob, type: blob.type || type, url: res.url || url };
}

// Returns null when the script can't run in the frame (caller falls back).
async function fetchInFrame(url, ctx, frameId = ctx.frameId) {
  const [res] = await browser.scripting.executeScript({
    target: { tabId: ctx.tab.id, frameIds: [frameId] },
    injectImmediately: true,
    func: async (u, max) => {
      try {
        const r = await fetch(u, { credentials: "include", cache: "force-cache" });
        if (!r.ok) return { ok: false, status: r.status };
        if (Number(r.headers.get("content-length")) > max) return { ok: false, tooLarge: true };
        const blob = await r.blob();
        return { ok: true, blob, type: blob.type, url: r.url };
      } catch (e) {
        return { ok: false, status: "network error" };
      }
    },
    args: [url, Media.MAX_BYTES],
  });
  const out = res && res.result;
  if (!out) return null;
  if (out.tooLarge) throw new Notice(TEXT.tooLarge(Media.MAX_BYTES / 1048576));
  if (!out.ok) throw new Notice(TEXT.fetchFailed(out.status));
  const blob = toBlob(out.blob, out.type);
  if (!blob) return null;
  return { blob, type: out.type || blob.type, url: out.url || url };
}

async function readBlobInFrame(media, ctx) {
  const isAV = media.kind === "video" || media.kind === "audio";
  let out = null;
  try {
    await injectResolve(ctx.tab.id, ctx.frameId);
    const [res] = await browser.scripting.executeScript({
      target: { tabId: ctx.tab.id, frameIds: [ctx.frameId] },
      injectImmediately: true,
      func: (u) => SynthIDResolve.readBlobUrl(u),
      args: [media.url],
    });
    out = res && res.result;
  } catch (e) {
    console.warn("SynthID Check: readBlobUrl failed", e);
  }
  if (out && !out.ok && out.error === "too large") throw new Notice(TEXT.tooLarge(Media.MAX_BYTES / 1048576));
  const blob = out && out.ok ? toBlob(out.blob, out.type) : null;
  if (!blob) throw new Notice(isAV ? TEXT.streaming : TEXT.blobFailed, isAV ? "warn" : "error");
  return { blob, type: out.type || blob.type, url: media.url };
}

function validate(file, mediaUrl) {
  let type = Media.normalizeMime(file.type);
  const nameUrl = isHttp(file.url) ? file.url : mediaUrl;
  let name = Media.fileNameFor(nameUrl, type);

  if (!Media.isAcceptedType(type, name)) {
    const ext = Media.extensionFromUrl(nameUrl);
    const what = type && type !== "application/octet-stream" ? type : ext ? `.${ext}` : "an unknown type";
    throw new Notice(TEXT.unsupported(what), "warn");
  }
  if (file.blob.size > Media.MAX_BYTES) throw new Notice(TEXT.tooLarge(Media.MAX_BYTES / 1048576));
  if (file.blob.size === 0) throw new Notice(TEXT.empty);

  // Servers sometimes send application/octet-stream; give the upload a real type.
  if (!Media.extensionForMime(type)) {
    type = Media.mimeForExtension(name.split(".").pop()) || type;
    name = Media.fileNameFor(nameUrl, type);
  }
  const blob = file.blob.type === type ? file.blob : new Blob([file.blob], { type });
  return { blob, type, name };
}

// ---------------------------------------------------------------------------
// Opening synthid.com

// getPending waits for this so a fast-loading tab can't read before put().
let openInFlight = Promise.resolve();

// Opens a tab next to the source tab. openerTabId can throw when the source
// tab is in another window, so fall back to a plain tab in the same window.
async function createTabNear(sourceTab, props) {
  try {
    return await browser.tabs.create({
      ...props,
      windowId: sourceTab.windowId,
      index: sourceTab.index + 1,
      openerTabId: sourceTab.id,
    });
  } catch (e) {
    console.warn("SynthID Check: opening next to the source tab failed", e);
    return browser.tabs.create({ ...props, windowId: sourceTab.windowId });
  }
}

function openSynthId(file, sourceUrl, sourceTab) {
  const run = (async () => {
    // The content script's host permission can be revoked in about:addons.
    let hasAccess = false;
    try {
      hasAccess = await browser.permissions.contains({ origins: [SYNTHID_ORIGIN_PATTERN] });
    } catch {
      hasAccess = false;
    }
    if (!hasAccess) throw new Notice(TEXT.synthidAccess, "warn");

    const settings = await getSettings();
    const newTab = await createTabNear(sourceTab, {
      url: SYNTHID_URL,
      active: settings.openInForeground !== false,
    });
    await Pending.put(
      {
        tabId: newTab.id,
        blob: file.blob,
        name: file.name,
        type: file.type,
        sourceUrl,
        createdAt: Date.now(),
        autoAttach: true,
        attachedAt: null,
        signInSeen: false,
      },
      Boolean(sourceTab.incognito || newTab.incognito),
    );
  })();
  // Chain rather than replace: with overlapping checks, a tab must wait for its
  // own put() too, not just the most recent one.
  const settled = run.catch(() => {});
  openInFlight = Promise.all([openInFlight, settled]).then(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Messages

function isFromSynthId(sender) {
  return sender.tab && typeof sender.url === "string" && sender.url.startsWith(SYNTHID_URL);
}

function isFromPopup(sender) {
  return typeof sender.url === "string" && sender.url.startsWith(browser.runtime.getURL(POPUP_PAGE));
}

async function onGetPending(tabId) {
  await openInFlight;
  const rec = await Pending.get(tabId);
  if (!rec) return { found: false };
  return {
    found: true,
    blob: rec.blob,
    name: rec.name,
    type: rec.type,
    sourceUrl: rec.sourceUrl,
    autoAttach: rec.autoAttach,
    signInSeen: rec.signInSeen,
  };
}

async function onAttached(tabId, signInRequired) {
  const rec = await Pending.get(tabId);
  if (rec) {
    await Pending.update(tabId, {
      attachedAt: Date.now(),
      signInSeen: Boolean(rec.signInSeen || signInRequired),
      autoAttach: Boolean(signInRequired),
    });
  }
  return { ok: true };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== "string" || sender.id !== browser.runtime.id) return undefined;

  switch (msg.type) {
    case "synthid:getPending":
      if (!isFromSynthId(sender)) return Promise.resolve({ found: false });
      return onGetPending(sender.tab.id).catch((e) => {
        console.warn("SynthID Check: getPending failed", e);
        return { found: false };
      });

    case "synthid:attached":
      if (!isFromSynthId(sender)) return Promise.resolve({ ok: false });
      return onAttached(sender.tab.id, msg.signInRequired === true).catch(() => ({ ok: false }));

    case "synthid:clear":
      if (!isFromSynthId(sender)) return Promise.resolve({ ok: false });
      return Pending.remove(sender.tab.id).then(
        () => ({ ok: true }),
        () => ({ ok: false }),
      );

    case "synthid:picked":
      if (sender.tab) {
        const ctx = {
          tab: sender.tab,
          frameId: sender.frameId ?? 0,
          frameUrl: sender.url || sender.tab.url,
          pageUrl: sender.tab.url,
        };
        if (msg.media && msg.media.url) acquire(msg.media, ctx);
        else notify(sender.tab.id, { state: "info", message: TEXT.nothingFound });
      }
      return undefined;

    case "synthid:startPicker":
      if (!isFromPopup(sender)) return Promise.resolve({ ok: false });
      return startPicker(msg.tabId).then((ok) => ({ ok }));

    default:
      return undefined;
  }
});

// ---------------------------------------------------------------------------
// Cleanup

browser.tabs.onRemoved.addListener((tabId) => {
  noticeQueues.delete(tabId);
  Pending.remove(tabId).catch(() => {});
});

Pending.purgeExpired().catch((e) => console.warn("SynthID Check: purge failed", e));
