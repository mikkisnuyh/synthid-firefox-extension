"use strict";

/* global SynthIDMedia, SynthIDPending */

const Media = SynthIDMedia;
const Pending = SynthIDPending;

const SYNTHID_URL = "https://synthid.com/";
const GRANT_PAGE = "src/grant/grant.html";
const GRANT_KEY_PREFIX = "grant:";
const GRANT_TTL_MS = 30 * 60 * 1000;
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
  declined: (host) => `SynthID Check needs permission to download this file from ${host}.`,
  fetchFailed: (status) =>
    `Couldn't download the file (${status}). Try saving it and uploading it on synthid.com.`,
  tooLarge: (mb) => `This file is larger than ${mb} MB. Try a smaller file.`,
  empty: "The file is empty.",
  unsupportedUrl: "This file's address can't be downloaded. Try saving it and uploading it on synthid.com.",
  badDataUrl: "Couldn't read this embedded file. Try saving it and uploading it on synthid.com.",
  blobFailed: "Couldn't read this file from the page. Try saving it and uploading it on synthid.com.",
  working: "Getting the file…",
};

class Notice extends Error {
  constructor(message, state = "error") {
    super(message);
    this.state = state;
  }
}

// ---------------------------------------------------------------------------
// Permission cache: menus.onClicked must call permissions.request() before any
// await, so it needs a synchronous answer to "is this origin granted already?".

const grantCache = { loaded: false, all: false, patterns: [] };

function refreshGrantCache() {
  return browser.permissions.getAll().then((perms) => {
    const origins = perms.origins || [];
    grantCache.all = origins.some((o) => o === "<all_urls>" || o === "*://*/*");
    grantCache.patterns = origins.map(parsePattern).filter(Boolean);
    grantCache.loaded = true;
  }, (e) => console.warn("SynthID Check: permissions.getAll failed", e));
}

function parsePattern(pattern) {
  const m = /^(\*|https?):\/\/([^/]+)\//.exec(pattern);
  return m ? { scheme: m[1], host: m[2] } : null;
}

function isKnownGranted(url) {
  if (grantCache.all) return true;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.slice(0, -1);
  return grantCache.patterns.some((p) => {
    if (p.scheme !== "*" && p.scheme !== scheme) return false;
    if (p.host === "*") return true;
    if (p.host.startsWith("*.")) {
      const base = p.host.slice(2);
      return u.hostname === base || u.hostname.endsWith("." + base);
    }
    return p.host === u.hostname;
  });
}

refreshGrantCache();
browser.permissions.onAdded.addListener(refreshGrantCache);
browser.permissions.onRemoved.addListener(refreshGrantCache);

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

function hostOf(url) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

async function getSettings() {
  try {
    return await browser.storage.sync.get(DEFAULT_SETTINGS);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// Notices run one at a time so a late "working" notice can't cover an error.
let noticeQueue = Promise.resolve();

function notify(tabId, notice) {
  noticeQueue = noticeQueue.then(() => showNotice(tabId, notice));
  return noticeQueue;
}

function hideNotice(tabId) {
  noticeQueue = noticeQueue.then(() => hideBanner(tabId));
  return noticeQueue;
}

async function showNotice(tabId, notice) {
  if (tabId == null || tabId < 0) return;
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ["src/content/banner.js"] });
    await browser.scripting.executeScript({
      target: { tabId },
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
      func: () => {
        if (globalThis.SynthIDBanner) SynthIDBanner.hide();
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

function createMenus() {
  return browser.menus.removeAll().then(() => {
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
  });
}

browser.runtime.onInstalled.addListener(() => {
  createMenus();
});
browser.runtime.onStartup.addListener(() => {
  createMenus();
});

browser.menus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null || tab.id < 0) return;
  if (info.menuItemId === "check-media") onCheckMedia(info, tab);
  else if (info.menuItemId === "find-media") onFindMedia(info, tab);
});

function onCheckMedia(info, tab) {
  const url = info.srcUrl;
  const frameId = info.frameId ?? 0;
  const ctx = { tab, frameId, frameUrl: info.frameUrl || info.pageUrl || tab.url };

  // No usable URL (or a blob: URL): let resolve.js inspect the element instead.
  if (!url || /^blob:/i.test(url)) {
    onFindMedia(info, tab);
    return;
  }

  const media = { kind: info.mediaType || "image", url, isBlob: false, isMediaSource: false };

  if (isHttp(url) && !isKnownGranted(url) && !sameOrigin(url, ctx.frameUrl)) {
    const pattern = Media.originPattern(url);
    // Must run synchronously inside the click handler. If the origin is
    // already granted (cache not loaded yet), this resolves true at once.
    browser.permissions.request({ origins: [pattern] }).then(
      (granted) => {
        if (granted) acquire(media, ctx);
        else notify(tab.id, { state: "warn", message: TEXT.declined(hostOf(url)) });
      },
      (e) => {
        console.warn("SynthID Check: permissions.request failed", e);
        acquire(media, ctx);
      },
    );
    return;
  }

  acquire(media, ctx);
}

async function onFindMedia(info, tab) {
  const frameId = info.frameId ?? 0;
  const ctx = { tab, frameId, frameUrl: info.frameUrl || info.pageUrl || tab.url };
  let media = null;
  try {
    await injectResolve(tab.id, frameId);
    const [res] = await browser.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId] },
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
  acquire(media, ctx);
}

// ---------------------------------------------------------------------------
// Toolbar button / shortcut: pick mode

browser.action.onClicked.addListener(async (tab) => {
  try {
    await browser.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      files: ["src/content/resolve.js", "src/content/picker.js"],
    });
    await browser.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: () => {
        SynthIDPicker.start();
      },
    });
  } catch (e) {
    console.warn("SynthID Check: can't start the picker on this page", e);
  }
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
    if (file) {
      const checked = validate(file, media.url);
      await openSynthId(checked, sourceUrlFor(media, ctx), ctx.tab);
    } // else: deferred to the grant page.
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

  const pattern = Media.originPattern(url);
  let granted = isKnownGranted(url);
  if (!granted) {
    try {
      granted = await browser.permissions.contains({ origins: [pattern] });
    } catch {
      granted = false;
    }
  }
  if (granted) return fetchInBackground(url);

  // activeTab covers the page's own origin, so fetch from inside the page.
  if (sameOrigin(url, ctx.frameUrl)) {
    const result = await fetchInFrame(url, ctx).catch((e) => {
      console.warn("SynthID Check: in-page fetch unavailable", e);
      return null;
    });
    if (result) return result;
  }

  await openGrantPage(media, ctx, pattern);
  return null;
}

async function fetchInBackground(url) {
  let res;
  try {
    res = await fetch(url, { credentials: "include", cache: "force-cache" });
  } catch {
    throw new Notice(TEXT.fetchFailed("network error"));
  }
  if (!res.ok) throw new Notice(TEXT.fetchFailed(res.status));
  const length = Number(res.headers.get("content-length"));
  if (length > Media.MAX_BYTES) throw new Notice(TEXT.tooLarge(Media.MAX_BYTES / 1048576));
  const blob = await res.blob();
  return { blob, type: blob.type || res.headers.get("content-type") || "", url: res.url || url };
}

// Returns null when the script can't run in the frame (caller falls back).
async function fetchInFrame(url, ctx) {
  const [res] = await browser.scripting.executeScript({
    target: { tabId: ctx.tab.id, frameIds: [ctx.frameId] },
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
      func: (u) => SynthIDResolve.readBlobUrl(u),
      args: [media.url],
    });
    out = res && res.result;
  } catch (e) {
    console.warn("SynthID Check: readBlobUrl failed", e);
  }
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

function openSynthId(file, sourceUrl, sourceTab) {
  const run = (async () => {
    const settings = await getSettings();
    const newTab = await browser.tabs.create({
      url: SYNTHID_URL,
      index: sourceTab.index + 1,
      openerTabId: sourceTab.id,
      active: settings.openInForeground !== false,
    });
    await Pending.put({
      tabId: newTab.id,
      blob: file.blob,
      name: file.name,
      type: file.type,
      sourceUrl,
      createdAt: Date.now(),
      autoAttach: true,
      attachedAt: null,
      signInSeen: false,
    });
  })();
  openInFlight = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Grant page: used when the permission couldn't be requested inside a click.

const grantRequests = new Map();

async function openGrantPage(media, ctx, pattern) {
  const requestId = crypto.randomUUID();
  const entry = {
    media: { kind: media.kind, url: media.url, isBlob: false, isMediaSource: false },
    tabId: ctx.tab.id,
    frameId: ctx.frameId,
    frameUrl: ctx.frameUrl,
    pattern,
    createdAt: Date.now(),
  };
  grantRequests.set(requestId, entry);
  try {
    await pruneGrantRequests();
    await browser.storage.session.set({ [GRANT_KEY_PREFIX + requestId]: entry });
  } catch (e) {
    console.warn("SynthID Check: storage.session unavailable", e);
  }
  const params = new URLSearchParams({ origin: pattern, id: requestId });
  await browser.tabs.create({
    url: browser.runtime.getURL(GRANT_PAGE) + "?" + params,
    index: ctx.tab.index + 1,
    openerTabId: ctx.tab.id,
    active: true,
  });
}

async function pruneGrantRequests() {
  const all = await browser.storage.session.get(null);
  const now = Date.now();
  const stale = Object.keys(all).filter(
    (k) => k.startsWith(GRANT_KEY_PREFIX) && !(now - (all[k] && all[k].createdAt) < GRANT_TTL_MS),
  );
  if (stale.length) await browser.storage.session.remove(stale);
}

async function takeGrantRequest(requestId) {
  const key = GRANT_KEY_PREFIX + requestId;
  let entry = grantRequests.get(requestId) || null;
  grantRequests.delete(requestId);
  try {
    if (!entry) entry = (await browser.storage.session.get(key))[key] || null;
    await browser.storage.session.remove(key);
  } catch {
    // Memory copy is enough.
  }
  if (entry && Date.now() - entry.createdAt > GRANT_TTL_MS) return null;
  return entry;
}

async function onGranted(requestId) {
  if (typeof requestId !== "string") return { ok: false };
  const entry = await takeGrantRequest(requestId);
  if (!entry) return { ok: false };
  const granted = await browser.permissions.contains({ origins: [entry.pattern] }).catch(() => false);
  if (!granted) return { ok: false };
  let tab;
  try {
    tab = await browser.tabs.get(entry.tabId);
  } catch {
    return { ok: false };
  }
  acquire(entry.media, { tab, frameId: entry.frameId, frameUrl: entry.frameUrl });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Messages

function isFromSynthId(sender) {
  return sender.tab && typeof sender.url === "string" && sender.url.startsWith(SYNTHID_URL);
}

function isFromGrantPage(sender) {
  return typeof sender.url === "string" && sender.url.startsWith(browser.runtime.getURL(GRANT_PAGE));
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
        const ctx = { tab: sender.tab, frameId: sender.frameId ?? 0, frameUrl: sender.url || sender.tab.url };
        if (msg.media && msg.media.url) acquire(msg.media, ctx);
        else notify(sender.tab.id, { state: "info", message: TEXT.nothingFound });
      }
      return undefined;

    case "synthid:granted":
      if (!isFromGrantPage(sender)) return Promise.resolve({ ok: false });
      return onGranted(msg.requestId).catch((e) => {
        console.warn("SynthID Check: resuming after grant failed", e);
        return { ok: false };
      });

    default:
      return undefined;
  }
});

// ---------------------------------------------------------------------------
// Cleanup

browser.tabs.onRemoved.addListener((tabId) => {
  Pending.remove(tabId).catch(() => {});
});

Pending.purgeExpired().catch((e) => console.warn("SynthID Check: purge failed", e));
