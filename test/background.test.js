"use strict";

// Integration tests for the background event page. The manifest's three
// background scripts run in a vm context (one shared global, like Firefox's
// event page) against a hand-written mock `browser` and a fake IndexedDB.

const { test } = require("node:test");
const strictAssert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");

// Objects built inside the vm context have that realm's Object.prototype, which
// strict deep equality would flag; compare their plain-JSON shape instead.
const assert = Object.assign((...args) => strictAssert(...args), strictAssert, {
  deepEqual(actual, expected, message) {
    strictAssert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), expected, message);
  },
});

const ROOT = path.join(__dirname, "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const SCRIPTS = MANIFEST.background.scripts;

const EXT_ID = "@synthid-check";
const EXT_BASE = "moz-extension://test-uuid/";
const POPUP_URL = EXT_BASE + "src/popup/popup.html";
const SYNTHID_URL = "https://synthid.com/";
const SYNTHID_PATTERN = "https://synthid.com/*";
const ALL_URLS = "<all_urls>";
const ALL_SITES_REQUEST = { origins: [ALL_URLS] };

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 250, 251]);
const CDN_PNG = "https://cdn.example.com/img/cat.png";
const PAGE_URL = "https://example.com/page";
const SETTINGS_HINT = "Turn it back on in its settings: click the SynthID Check button in the toolbar, then Settings.";

// ---------------------------------------------------------------------------
// Mock browser

function makeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    // Calls every listener synchronously, like the browser does.
    fire: (...args) => listeners.map((l) => l(...args)),
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, what, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) assert.fail(`Timed out waiting for ${what}`);
    await tick();
  }
}

function matchesPattern(pattern, granted) {
  return granted.has("<all_urls>") || granted.has(pattern);
}

function makeEnv(opts = {}) {
  const calls = {
    menusCreate: [],
    menusRemoveAll: 0,
    menusDuplicate: [],
    permissionsRequest: [],
    permissionsContains: [],
    executeScript: [],
    tabsCreate: [],
    fetch: [],
    consoleWarn: [],
    consoleError: [],
  };
  // Default install: access to all websites is granted up front.
  const granted = new Set(opts.granted || []);
  if (opts.allSites !== false) granted.add(ALL_URLS);
  if (opts.synthidGranted !== false) granted.add(SYNTHID_PATTERN);

  const env = {
    calls,
    granted,
    createdTabs: [],
    menuIds: new Set(),
    // Optional hook: delay tabs.create's resolution (after the tab exists).
    createDelay: null,
    tabs: new Map(),
    nextTabId: 100,
    syncStorage: { ...(opts.syncStorage || {}) },
    requestResult: opts.requestResult ?? true, // what permissions.request resolves to
    inListener: false,
    // Per-test scripted behaviour.
    scriptHandler: () => [{ result: undefined }],
    fetchHandler: async () => {
      throw new TypeError("NetworkError: no fetch scripted");
    },
    getAllPromises: [],
  };

  const events = {
    menusOnClicked: makeEvent(),
    onInstalled: makeEvent(),
    onStartup: makeEvent(),
    onMessage: makeEvent(),
    commandsOnCommand: makeEvent(),
    permissionsOnAdded: makeEvent(),
    permissionsOnRemoved: makeEvent(),
    tabsOnRemoved: makeEvent(),
    storageOnChanged: makeEvent(),
  };
  env.events = events;
  // In-memory scripting.registerContentScripts registry (id -> definition) plus a call log.
  env.registeredScripts = new Map();
  env.scriptingLog = [];
  // Optional hook: delay getRegisteredContentScripts' answer (to force overlapping syncs).
  env.registryDelay = null;

  env.addTab = (tab) => {
    const full = { id: 1, windowId: 1, index: 0, url: PAGE_URL, incognito: false, active: true, ...tab };
    env.tabs.set(full.id, full);
    return full;
  };

  // Like the user toggling site access in about:addons: the browser fires the event.
  env.grant = async (pattern) => {
    granted.add(pattern);
    events.permissionsOnAdded.fire({ origins: [pattern] });
    await Promise.all(env.getAllPromises);
    await tick();
  };
  env.revoke = async (pattern) => {
    granted.delete(pattern);
    events.permissionsOnRemoved.fire({ origins: [pattern] });
    await Promise.all(env.getAllPromises);
    await tick();
  };

  const browser = {
    runtime: {
      id: EXT_ID,
      getURL: (p) => EXT_BASE + p,
      onInstalled: events.onInstalled,
      onStartup: events.onStartup,
      onMessage: events.onMessage,
      openOptionsPage: async () => {
        calls.openOptionsPage = (calls.openOptionsPage || 0) + 1;
      },
    },
    menus: {
      removeAll: async () => {
        calls.menusRemoveAll++;
        env.menuIds.clear();
      },
      create: (props) => {
        calls.menusCreate.push(props);
        if (env.menuIds.has(props.id)) calls.menusDuplicate.push(props.id); // runtime.lastError in Firefox
        env.menuIds.add(props.id);
        return props.id;
      },
      onClicked: events.menusOnClicked,
    },
    commands: { onCommand: events.commandsOnCommand },
    permissions: {
      request: (perms) => {
        calls.permissionsRequest.push({ perms, synchronous: env.inListener });
        if (env.requestResult) for (const o of perms.origins || []) granted.add(o);
        return Promise.resolve(env.requestResult);
      },
      contains: async (perms) => {
        calls.permissionsContains.push(perms);
        return (perms.origins || []).every((o) => matchesPattern(o, granted));
      },
      getAll: () => {
        const p = Promise.resolve({ permissions: [], origins: [...granted] });
        env.getAllPromises.push(p);
        return p;
      },
      onAdded: events.permissionsOnAdded,
      onRemoved: events.permissionsOnRemoved,
    },
    scripting: {
      getRegisteredContentScripts: async (filter = {}) => {
        env.scriptingLog.push("get");
        const found = [...env.registeredScripts.values()].filter((s) => !filter.ids || filter.ids.includes(s.id));
        if (env.registryDelay) await env.registryDelay();
        return structuredClone(found);
      },
      registerContentScripts: async (scripts) => {
        env.scriptingLog.push("register");
        for (const s of scripts) {
          if (env.registeredScripts.has(s.id)) throw new Error(`Content script with id "${s.id}" is already registered`);
        }
        for (const s of scripts) env.registeredScripts.set(s.id, structuredClone(s));
      },
      unregisterContentScripts: async (filter = {}) => {
        env.scriptingLog.push("unregister");
        for (const id of filter.ids || [...env.registeredScripts.keys()]) {
          if (!env.registeredScripts.has(id)) throw new Error(`Content script with id "${id}" does not exist`);
          env.registeredScripts.delete(id);
        }
      },
      updateContentScripts: async (scripts) => {
        env.scriptingLog.push("update");
        for (const s of scripts) {
          if (!env.registeredScripts.has(s.id)) throw new Error(`Content script with id "${s.id}" does not exist`);
        }
        for (const s of scripts) env.registeredScripts.set(s.id, { ...env.registeredScripts.get(s.id), ...structuredClone(s) });
      },
      executeScript: async (details) => {
        calls.executeScript.push(details);
        return env.scriptHandler(details);
      },
    },
    tabs: {
      query: async () => [...env.tabs.values()].filter((t) => t.active).slice(-1),
      create: async (props) => {
        calls.tabsCreate.push(props);
        if (opts.failOpenerTabId && props.openerTabId !== undefined) {
          throw new Error("Invalid tab ID: openerTabId in another window");
        }
        const opener = env.tabs.get(props.openerTabId);
        const tab = env.addTab({
          id: env.nextTabId++,
          windowId: props.windowId ?? 1,
          index: props.index ?? 0,
          url: props.url,
          active: props.active !== false,
          incognito: opener ? Boolean(opener.incognito) : false,
        });
        env.createdTabs.push(tab);
        if (env.createDelay) await env.createDelay(calls.tabsCreate.length);
        return tab;
      },
      get: async (id) => {
        const tab = env.tabs.get(id);
        if (!tab) throw new Error(`Invalid tab ID: ${id}`);
        return tab;
      },
      remove: async () => {},
      getCurrent: async () => undefined,
      onRemoved: events.tabsOnRemoved,
    },
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, ...env.syncStorage }),
      },
      onChanged: events.storageOnChanged,
    },
  };
  env.browser = browser;

  env.indexedDB = new IDBFactory();

  env.send = async (msg, sender) => {
    const results = events.onMessage.fire(msg, sender);
    return results[0];
  };
  env.synthidSender = (tabId, url = SYNTHID_URL) => ({ id: EXT_ID, url, tab: { id: tabId } });

  // Fire menus.onClicked while flagging that we are inside the listener call.
  env.click = (info, tab) => {
    env.inListener = true;
    try {
      events.menusOnClicked.fire(info, tab);
    } finally {
      env.inListener = false;
    }
  };

  // Fire commands.onCommand while flagging that we are inside the listener call.
  env.command = (name, tab) => {
    env.inListener = true;
    try {
      events.commandsOnCommand.fire(name, tab);
    } finally {
      env.inListener = false;
    }
  };

  env.synthidTabs = () => env.createdTabs.filter((t) => t.url === SYNTHID_URL);

  const consoleMock = {
    log() {},
    info() {},
    debug() {},
    warn: (...a) => calls.consoleWarn.push(a),
    error: (...a) => calls.consoleError.push(a),
  };

  const sandbox = {
    browser,
    fetch: (url, init) => {
      calls.fetch.push({ url, init });
      return env.fetchHandler(url, init);
    },
    Blob,
    Response,
    AbortController,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    crypto: globalThis.crypto,
    structuredClone,
    console: consoleMock,
    setTimeout,
    clearTimeout,
    indexedDB: env.indexedDB,
    IDBKeyRange,
  };
  env.context = vm.createContext(sandbox);
  return env;
}

// Loads the manifest's background scripts into a fresh context, in order.
async function loadBackground(opts) {
  const env = makeEnv(opts);
  for (const rel of SCRIPTS) {
    const file = path.join(ROOT, rel);
    new vm.Script(fs.readFileSync(file, "utf8"), { filename: file }).runInContext(env.context);
  }
  // Let the startup permissions.getAll() refresh settle so the access cache is warm.
  await Promise.all(env.getAllPromises);
  await tick();
  return env;
}

// ---------------------------------------------------------------------------
// Helpers

function pngResponse(bytes = PNG, type = "image/png", extraHeaders = {}) {
  return new Response(bytes, { status: 200, headers: { "content-type": type, ...extraHeaders } });
}

async function bytesOf(blob) {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

function sourceTab(overrides = {}) {
  return { id: 5, windowId: 3, index: 2, url: PAGE_URL, incognito: false, ...overrides };
}

function imageClick(srcUrl, overrides = {}) {
  return {
    menuItemId: "check-media",
    srcUrl,
    pageUrl: PAGE_URL,
    frameId: 0,
    mediaType: "image",
    ...overrides,
  };
}

async function diskRecords(env) {
  const db = await new Promise((resolve, reject) => {
    const r = env.indexedDB.open("synthid-check", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("pending", { keyPath: "tabId" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction("pending", "readonly").objectStore("pending").getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

async function getPending(env, tabId) {
  return env.send({ type: "synthid:getPending" }, env.synthidSender(tabId));
}

// Runs a data: URL check so a pending record exists; returns the synthid.com tab.
async function seedPending(env, tab) {
  env.addTab(tab);
  const dataUrl = "data:image/png;base64," + Buffer.from(PNG).toString("base64");
  env.click(imageClick(dataUrl), tab);
  await waitFor(() => env.synthidTabs().length === 1, "synthid.com tab");
  return env.synthidTabs()[0];
}

// Scripted executeScript for the find-media path.
function findMediaScript(media) {
  return (details) => {
    if (details.func) return [{ result: media }];
    return [{ result: undefined }];
  };
}

function bannerCalls(env, tabId) {
  return env.calls.executeScript.filter(
    (d) => d.target.tabId === tabId && d.func && d.args && d.args[0] && typeof d.args[0].message === "string",
  );
}

// ---------------------------------------------------------------------------
// 1. Menus

test("onInstalled creates the two menu items with the contract ids and contexts", async () => {
  const env = await loadBackground();
  assert.equal(env.events.onInstalled.listeners.length, 1);
  env.events.onInstalled.fire({ reason: "install" });
  await waitFor(() => env.calls.menusCreate.length === 2, "two menus.create calls");
  assert.equal(env.calls.menusRemoveAll, 1);
  assert.deepEqual(env.calls.menusCreate, [
    { id: "check-media", title: "Check with SynthID", contexts: ["image", "video", "audio"] },
    { id: "find-media", title: "Find media under the cursor and check with SynthID", contexts: ["page", "frame", "link"] },
  ]);
});

// ---------------------------------------------------------------------------
// 2. Default install: access to all websites is granted, no prompts

test("default install: a cross-origin image is fetched in the background without any permission request", async () => {
  const env = await loadBackground();
  env.fetchHandler = async () => pngResponse();
  const tab = env.addTab(sourceTab());

  env.click(imageClick(CDN_PNG), tab);
  await waitFor(() => env.calls.tabsCreate.length === 1, "tabs.create");
  // Racing like a fast-loading tab: ask before the pending record is written.
  const newTab = env.createdTabs[0];
  const reply = await getPending(env, newTab.id);

  assert.equal(env.calls.permissionsRequest.length, 0, "permissions.request must not be called");
  assert.equal(env.calls.fetch.length, 1);
  assert.equal(env.calls.fetch[0].url, CDN_PNG);
  assert.equal(env.calls.fetch[0].init.credentials, "include");
  assert.deepEqual(env.calls.tabsCreate[0], {
    url: SYNTHID_URL,
    active: true,
    windowId: 3,
    index: 3,
    openerTabId: 5,
  });

  assert.equal(reply.found, true);
  assert.equal(reply.name, "cat.png");
  assert.equal(reply.type, "image/png");
  assert.equal(reply.sourceUrl, CDN_PNG);
  assert.equal(reply.autoAttach, true);
  assert.equal(reply.signInSeen, false);
  assert.deepEqual(await bytesOf(reply.blob), Array.from(PNG));

  const rows = await diskRecords(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tabId, newTab.id);
  assert.deepEqual(env.calls.consoleError, []);
});

test("openInForeground=false opens synthid.com in the background", async () => {
  const env = await loadBackground({ syncStorage: { openInForeground: false } });
  env.fetchHandler = async () => pngResponse();
  const tab = env.addTab(sourceTab());
  env.click(imageClick(CDN_PNG), tab);
  await waitFor(() => env.calls.tabsCreate.length === 1, "tabs.create");
  assert.equal(env.calls.tabsCreate[0].active, false);
});

test("default install: find-media with a cross-origin result fetches in the background, no request", async () => {
  const env = await loadBackground();
  env.scriptHandler = findMediaScript({ kind: "image", url: CDN_PNG, isBlob: false, isMediaSource: false });
  env.fetchHandler = async () => pngResponse();
  const tab = env.addTab(sourceTab());
  env.click({ menuItemId: "find-media", pageUrl: PAGE_URL, frameId: 0, targetElementId: 42 }, tab);
  await waitFor(() => env.synthidTabs().length === 1, "synthid tab");

  assert.equal(env.calls.permissionsRequest.length, 0);
  assert.equal(env.calls.fetch.length, 1);
  assert.equal(env.calls.fetch[0].url, CDN_PNG);
  // The find-media script was run in the clicked frame with the target element id.
  const finder = env.calls.executeScript.find((d) => d.func);
  assert.deepEqual(finder.target, { tabId: 5, frameIds: [0] });
  assert.deepEqual(finder.args, [42]);
  const synth = env.calls.tabsCreate[0];
  assert.deepEqual(synth, { url: SYNTHID_URL, active: true, windowId: 3, index: 3, openerTabId: 5 });
  const pending = await getPending(env, env.synthidTabs()[0].id);
  assert.equal(pending.found, true);
  assert.equal(pending.sourceUrl, CDN_PNG);
  assert.deepEqual(await bytesOf(pending.blob), Array.from(PNG));
});

for (const variant of [
  {
    name: "check-media without srcUrl",
    info: { menuItemId: "check-media", pageUrl: PAGE_URL, frameId: 0, targetElementId: 42, mediaType: "image" },
  },
  {
    name: "check-media with a blob: srcUrl",
    info: { menuItemId: "check-media", srcUrl: "blob:https://example.com/xyz", pageUrl: PAGE_URL, frameId: 0, targetElementId: 42 },
  },
]) {
  test(`${variant.name} falls back to finding the media, with no grant page`, async () => {
    const env = await loadBackground();
    env.scriptHandler = findMediaScript({ kind: "image", url: CDN_PNG, isBlob: false, isMediaSource: false });
    env.fetchHandler = async () => pngResponse();
    const tab = env.addTab(sourceTab());
    env.click(variant.info, tab);
    await waitFor(() => env.synthidTabs().length === 1, "synthid tab");
    assert.equal(env.calls.permissionsRequest.length, 0);
    assert.equal(env.calls.tabsCreate.length, 1);
    assert.equal(env.calls.tabsCreate[0].url, SYNTHID_URL);
    assert.equal(env.calls.fetch[0].url, CDN_PNG);
  });
}

// ---------------------------------------------------------------------------
// 3. Site access revoked (Firefox lets users remove <all_urls> after install)

test("access revoked: check-media requests <all_urls> synchronously inside the click, then proceeds when granted", async () => {
  const env = await loadBackground({ allSites: false });
  env.fetchHandler = async () => pngResponse();
  const tab = env.addTab(sourceTab());

  env.inListener = true;
  env.events.menusOnClicked.fire(imageClick(CDN_PNG), tab);
  // Straight after the listener returned, with no microtask having run yet:
  const synchronousCalls = env.calls.permissionsRequest.length;
  env.inListener = false;

  assert.equal(synchronousCalls, 1, "permissions.request must be called before any await");
  assert.equal(env.calls.permissionsRequest[0].synchronous, true);
  assert.deepEqual(env.calls.permissionsRequest[0].perms, ALL_SITES_REQUEST);
  assert.equal(env.calls.fetch.length, 0, "no fetch before the grant resolves");

  await waitFor(() => env.createdTabs.length === 1, "synthid tab after grant");
  assert.equal(env.calls.permissionsRequest.length, 1, "asked exactly once");
  assert.equal(env.calls.fetch.length, 1);
  assert.equal(env.calls.fetch[0].url, CDN_PNG);
  const reply = await getPending(env, env.createdTabs[0].id);
  assert.equal(reply.found, true);
  assert.deepEqual(await bytesOf(reply.blob), Array.from(PNG));
  assert.equal(env.calls.tabsCreate.length, 1);
});

test("access revoked: find-media also requests <all_urls> synchronously, then proceeds when granted", async () => {
  const env = await loadBackground({ allSites: false });
  env.scriptHandler = findMediaScript({ kind: "image", url: CDN_PNG, isBlob: false, isMediaSource: false });
  env.fetchHandler = async () => pngResponse();
  const tab = env.addTab(sourceTab());

  env.click({ menuItemId: "find-media", pageUrl: PAGE_URL, frameId: 0, targetElementId: 42 }, tab);
  assert.equal(env.calls.permissionsRequest.length, 1);
  assert.equal(env.calls.permissionsRequest[0].synchronous, true);
  assert.deepEqual(env.calls.permissionsRequest[0].perms, ALL_SITES_REQUEST);

  await waitFor(() => env.synthidTabs().length === 1, "synthid tab");
  assert.equal(env.calls.permissionsRequest.length, 1);
  assert.equal(env.calls.fetch[0].url, CDN_PNG);
  assert.equal(env.calls.tabsCreate.length, 1);
});

test("access revoked and declined: a cross-origin image gets the access notice, no tab and no grant page", async () => {
  const env = await loadBackground({ allSites: false, requestResult: false });
  const tab = env.addTab(sourceTab());
  env.click(imageClick(CDN_PNG), tab);
  assert.equal(env.calls.permissionsRequest.length, 1);

  await waitFor(() => bannerCalls(env, 5).length === 1, "access notice");
  const [notice] = bannerCalls(env, 5);
  assert.equal(notice.args[0].state, "warn");
  assert.equal(
    notice.args[0].message,
    `SynthID Check needs access to websites to download this file. ${SETTINGS_HINT}`,
  );
  assert.deepEqual(notice.args[0].actions, []);
  assert.equal(env.calls.fetch.length, 0);
  assert.equal(env.calls.tabsCreate.length, 0, "no synthid.com tab and no grant page");
  assert.equal(env.calls.permissionsRequest.length, 1, "no second request outside the click");
});

test("access revoked and declined: a same-origin image is still fetched inside the page (activeTab)", async () => {
  const env = await loadBackground({ allSites: false, requestResult: false });
  env.fetchHandler = async () => pngResponse();
  const tab = env.addTab(sourceTab());
  env.scriptHandler = (d) =>
    d.func
      ? [{ result: { ok: true, blob: new Blob([PNG], { type: "image/png" }), type: "image/png", url: "https://example.com/a.png" } }]
      : [{}];
  env.click(imageClick("https://example.com/a.png"), tab);
  await waitFor(() => env.createdTabs.length === 1, "synthid tab");

  assert.equal(env.calls.fetch.length, 0, "no background fetch without access");
  const inPage = env.calls.executeScript.find((d) => d.func);
  assert.deepEqual(inPage.target, { tabId: 5, frameIds: [0] });
  assert.deepEqual(inPage.args[0], "https://example.com/a.png");
  assert.equal(env.calls.tabsCreate.length, 1);
  assert.equal(env.calls.tabsCreate[0].url, SYNTHID_URL);
  const reply = await getPending(env, env.createdTabs[0].id);
  assert.equal(reply.found, true);
  assert.equal(reply.name, "a.png");
  assert.deepEqual(await bytesOf(reply.blob), Array.from(PNG));
  assert.deepEqual(bannerCalls(env, 5), []);
});

test("access revoked and declined: an image in a same-origin top page but a cross-origin frame is fetched in the top frame", async () => {
  const env = await loadBackground({ allSites: false, requestResult: false });
  const tab = env.addTab(sourceTab());
  env.scriptHandler = (d) =>
    d.func
      ? [{ result: { ok: true, blob: new Blob([PNG], { type: "image/png" }), type: "image/png", url: "https://example.com/a.png" } }]
      : [{}];
  env.click(
    imageClick("https://example.com/a.png", { frameId: 7, frameUrl: "https://ads.example.net/frame" }),
    tab,
  );
  await waitFor(() => env.createdTabs.length === 1, "synthid tab");
  const inPage = env.calls.executeScript.find((d) => d.func);
  assert.deepEqual(inPage.target, { tabId: 5, frameIds: [0] });
});

test("access revoked and declined: picking cross-origin media gets the access notice and requests nothing", async () => {
  const env = await loadBackground({ allSites: false, requestResult: false });
  const tab = env.addTab(sourceTab());
  const media = { kind: "image", url: CDN_PNG, isBlob: false, isMediaSource: false };
  await env.send({ type: "synthid:picked", media }, { id: EXT_ID, url: PAGE_URL, tab, frameId: 0 });
  await waitFor(() => bannerCalls(env, 5).length === 1, "access notice");
  assert.match(bannerCalls(env, 5)[0].args[0].message, /needs access to websites to download this file/);
  assert.equal(env.calls.permissionsRequest.length, 0, "not a user-action handler");
  assert.equal(env.calls.tabsCreate.length, 0);
  assert.equal(env.calls.fetch.length, 0);
});

test("access granted via the browser mid-session: picked media is fetched, found through contains() even if the cache missed it", async () => {
  const env = await loadBackground({ allSites: false });
  env.fetchHandler = async () => pngResponse();
  const tab = env.addTab(sourceTab());
  // Granted without the extension seeing the event (e.g. the event page was asleep).
  env.granted.add(ALL_URLS);
  const media = { kind: "image", url: CDN_PNG, isBlob: false, isMediaSource: false };
  await env.send({ type: "synthid:picked", media }, { id: EXT_ID, url: PAGE_URL, tab, frameId: 0 });
  await waitFor(() => env.synthidTabs().length === 1, "synthid tab");
  assert.equal(env.calls.permissionsRequest.length, 0);
  assert.equal(env.calls.fetch.length, 1);
});

test("permissions.onRemoved for <all_urls> updates the cache: the next click requests access", async () => {
  const env = await loadBackground();
  env.fetchHandler = async () => pngResponse();
  const tab = env.addTab(sourceTab());
  await env.revoke(ALL_URLS);
  env.click(imageClick(CDN_PNG), tab);
  assert.equal(env.calls.permissionsRequest.length, 1);
  assert.equal(env.calls.permissionsRequest[0].synchronous, true);
  assert.deepEqual(env.calls.permissionsRequest[0].perms, ALL_SITES_REQUEST);
  await waitFor(() => env.createdTabs.length === 1, "synthid tab");
});

test("permissions.onAdded for <all_urls> updates the cache: a later click skips the request", async () => {
  const env = await loadBackground({ allSites: false });
  env.fetchHandler = async () => pngResponse();
  const tab = env.addTab(sourceTab());
  await env.grant(ALL_URLS);
  env.click(imageClick(CDN_PNG), tab);
  assert.equal(env.calls.permissionsRequest.length, 0);
  await waitFor(() => env.createdTabs.length === 1, "synthid tab");
});

test("removing an unrelated permission leaves the cache alone", async () => {
  const env = await loadBackground();
  env.fetchHandler = async () => pngResponse();
  const tab = env.addTab(sourceTab());
  env.granted.add("https://cdn.example.com/*");
  await env.revoke("https://cdn.example.com/*");
  env.click(imageClick(CDN_PNG), tab);
  assert.equal(env.calls.permissionsRequest.length, 0);
  await waitFor(() => env.createdTabs.length === 1, "synthid tab");
});

// ---------------------------------------------------------------------------
// 4. data: URL

test("a data: URL image is decoded locally without fetch or permission request", async () => {
  const env = await loadBackground();
  const tab = env.addTab(sourceTab());
  const dataUrl = "data:image/png;base64," + Buffer.from(PNG).toString("base64");
  env.click(imageClick(dataUrl), tab);
  await waitFor(() => env.createdTabs.length === 1, "synthid tab");

  assert.equal(env.calls.fetch.length, 0);
  assert.equal(env.calls.permissionsRequest.length, 0);
  const reply = await getPending(env, env.createdTabs[0].id);
  assert.equal(reply.found, true);
  assert.equal(reply.type, "image/png");
  assert.equal(reply.name, "synthid-check.png");
  assert.equal(reply.sourceUrl, PAGE_URL);
  assert.deepEqual(await bytesOf(reply.blob), Array.from(PNG));
});

test("a malformed data: URL shows a notice", async () => {
  const env = await loadBackground();
  const tab = env.addTab(sourceTab());
  env.click(imageClick("data:image/png;base64,@@@not-base64@@@"), tab);
  await waitFor(() => bannerCalls(env, 5).length === 1, "notice");
  assert.match(bannerCalls(env, 5)[0].args[0].message, /embedded file/);
  assert.equal(env.createdTabs.length, 0);
});

// ---------------------------------------------------------------------------
// 5. Rejected files

test("an unsupported response type opens no synthid tab and injects a notice into the source tab", async () => {
  const env = await loadBackground();
  env.fetchHandler = async () =>
    new Response("<html>login</html>", { headers: { "content-type": "text/html; charset=utf-8" } });
  const tab = env.addTab(sourceTab());
  env.click(imageClick(CDN_PNG), tab);

  await waitFor(() => bannerCalls(env, 5).length === 1, "unsupported notice");
  assert.equal(env.calls.tabsCreate.length, 0);

  // The banner library is injected first, then the show() call.
  const sourceCalls = env.calls.executeScript.filter((d) => d.target.tabId === 5);
  assert.deepEqual(sourceCalls[0].files, ["src/content/banner.js"]);
  const shown = bannerCalls(env, 5)[0].args[0];
  assert.equal(shown.state, "warn");
  assert.equal(shown.title, "SynthID Check");
  assert.match(shown.message, /This file is text\/html\./);
});

test("an octet-stream response with an image extension is accepted and re-typed from the extension", async () => {
  const env = await loadBackground();
  env.fetchHandler = async () => pngResponse(PNG, "application/octet-stream");
  const tab = env.addTab(sourceTab());
  env.click(imageClick(CDN_PNG), tab);
  await waitFor(() => env.createdTabs.length === 1, "synthid tab");
  const reply = await getPending(env, env.createdTabs[0].id);
  assert.equal(reply.type, "image/png");
  assert.equal(reply.name, "cat.png");
  assert.equal(reply.blob.type, "image/png");
});

test("HTTP errors, empty bodies and oversized files show notices", async () => {
  const cases = [
    [() => new Response("nope", { status: 404 }), /Couldn't download the file \(404\)/],
    [() => pngResponse(new Uint8Array(0)), /The file is empty/],
    [() => pngResponse(PNG, "image/png", { "content-length": String(300 * 1024 * 1024) }), /larger than 200 MB/],
  ];
  for (const [make, expected] of cases) {
    const env = await loadBackground();
    env.fetchHandler = async () => make();
    const tab = env.addTab(sourceTab());
    env.click(imageClick(CDN_PNG), tab);
    await waitFor(() => bannerCalls(env, 5).length === 1, `notice for ${expected}`);
    assert.match(bannerCalls(env, 5)[0].args[0].message, expected);
    assert.equal(env.calls.tabsCreate.length, 0);
  }
});

test("without synthid.com host access nothing is opened and the user is told", async () => {
  // Only reachable with access revoked: all-sites access includes synthid.com.
  const env = await loadBackground({ allSites: false, synthidGranted: false, requestResult: false });
  env.scriptHandler = (d) =>
    d.func
      ? [{ result: { ok: true, blob: new Blob([PNG], { type: "image/png" }), type: "image/png", url: "https://example.com/a.png" } }]
      : [{}];
  const tab = env.addTab(sourceTab());
  env.click(imageClick("https://example.com/a.png"), tab);
  await waitFor(() => bannerCalls(env, 5).length === 1, "access notice");
  const notice = bannerCalls(env, 5)[0].args[0];
  assert.equal(
    notice.message,
    `SynthID Check needs access to synthid.com to attach the file. ${SETTINGS_HINT}`,
  );
  assert.equal(notice.state, "warn");
  assert.deepEqual(notice.actions, []);
  assert.equal(env.calls.tabsCreate.length, 0);
});

test("if openerTabId is rejected, synthid.com is opened as a plain tab in the same window", async () => {
  const env = await loadBackground({ failOpenerTabId: true });
  env.fetchHandler = async () => pngResponse();
  const tab = env.addTab(sourceTab());
  env.click(imageClick(CDN_PNG), tab);
  await waitFor(() => env.createdTabs.length === 1, "fallback tab");
  assert.equal(env.calls.tabsCreate.length, 2);
  assert.deepEqual(env.calls.tabsCreate[1], { url: SYNTHID_URL, active: true, windowId: 3 });
  const reply = await getPending(env, env.createdTabs[0].id);
  assert.equal(reply.found, true);
});

// ---------------------------------------------------------------------------
// 6. Messages

test("getPending from a non-synthid sender is rejected", async () => {
  const env = await loadBackground();
  const newTab = await seedPending(env, sourceTab());
  const id = newTab.id;

  const evil = await env.send({ type: "synthid:getPending" }, env.synthidSender(id, "https://evil.example/"));
  assert.deepEqual(evil, { found: false });
  const lookalike = await env.send(
    { type: "synthid:getPending" },
    env.synthidSender(id, "https://synthid.com.evil.example/"),
  );
  assert.deepEqual(lookalike, { found: false });
  const noTab = await env.send({ type: "synthid:getPending" }, { id: EXT_ID, url: SYNTHID_URL });
  assert.deepEqual(noTab, { found: false });
  // A message from another extension is ignored entirely (no reply).
  const foreign = await env.send({ type: "synthid:getPending" }, { ...env.synthidSender(id), id: "other@ext" });
  assert.equal(foreign, undefined);
  // Unknown / malformed messages are ignored.
  assert.equal(await env.send({ type: "nope" }, env.synthidSender(id)), undefined);
  assert.equal(await env.send(null, env.synthidSender(id)), undefined);

  // The real sender still gets the file.
  assert.equal((await getPending(env, id)).found, true);
  // A synthid tab without a record just gets found:false.
  assert.deepEqual(await getPending(env, 4242), { found: false });
});

test("synthid:attached sets autoAttach to signInRequired and records the sign-in state", async () => {
  const env = await loadBackground();
  const id = (await seedPending(env, sourceTab())).id;
  assert.equal((await getPending(env, id)).autoAttach, true);

  const ok = await env.send({ type: "synthid:attached", signInRequired: false }, env.synthidSender(id));
  assert.deepEqual(ok, { ok: true });
  let reply = await getPending(env, id);
  assert.equal(reply.autoAttach, false);
  assert.equal(reply.signInSeen, false);
  assert.equal(typeof (await diskRecords(env))[0].attachedAt, "number");

  await env.send({ type: "synthid:attached", signInRequired: true }, env.synthidSender(id));
  reply = await getPending(env, id);
  assert.equal(reply.autoAttach, true);
  assert.equal(reply.signInSeen, true);

  // signInSeen is sticky, autoAttach follows the latest flag.
  await env.send({ type: "synthid:attached", signInRequired: false }, env.synthidSender(id));
  reply = await getPending(env, id);
  assert.equal(reply.autoAttach, false);
  assert.equal(reply.signInSeen, true);
});

test("attached and clear from a non-synthid sender are refused and change nothing", async () => {
  const env = await loadBackground();
  const id = (await seedPending(env, sourceTab())).id;
  const evil = env.synthidSender(id, "https://evil.example/");
  assert.deepEqual(await env.send({ type: "synthid:attached", signInRequired: false }, evil), { ok: false });
  assert.deepEqual(await env.send({ type: "synthid:clear" }, evil), { ok: false });
  const reply = await getPending(env, id);
  assert.equal(reply.found, true);
  assert.equal(reply.autoAttach, true);
});

test("synthid:clear removes the pending record", async () => {
  const env = await loadBackground();
  const id = (await seedPending(env, sourceTab())).id;
  assert.deepEqual(await env.send({ type: "synthid:clear" }, env.synthidSender(id)), { ok: true });
  assert.deepEqual(await getPending(env, id), { found: false });
  assert.deepEqual(await diskRecords(env), []);
});

test("closing the synthid.com tab removes the pending record", async () => {
  const env = await loadBackground();
  const id = (await seedPending(env, sourceTab())).id;
  assert.equal((await diskRecords(env)).length, 1);
  env.events.tabsOnRemoved.fire(id, { windowId: 3, isWindowClosing: false });
  await waitFor(async () => (await diskRecords(env)).length === 0, "record removed");
  assert.deepEqual(await getPending(env, id), { found: false });
});

test("records are keyed by tab: another synthid tab cannot read them", async () => {
  const env = await loadBackground();
  const id = (await seedPending(env, sourceTab())).id;
  assert.deepEqual(await getPending(env, id + 1), { found: false });
});

test("expired records are not returned and are deleted", async () => {
  const env = await loadBackground();
  const id = (await seedPending(env, sourceTab())).id;
  const tenMinutesFifteenSeconds = 10 * 60 * 1000 + 15000;
  // Age the stored record instead of faking the clock.
  const db = await new Promise((resolve, reject) => {
    const r = env.indexedDB.open("synthid-check", 1);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction("pending", "readwrite");
    const store = tx.objectStore("pending");
    const g = store.get(id);
    g.onsuccess = () => store.put({ ...g.result, createdAt: Date.now() - tenMinutesFifteenSeconds });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  assert.deepEqual(await getPending(env, id), { found: false });
  assert.deepEqual(await diskRecords(env), []);
});

// ---------------------------------------------------------------------------
// 7. Private windows

test("private window media never reaches IndexedDB but getPending still returns it", async () => {
  const env = await loadBackground();
  env.fetchHandler = async () => pngResponse();
  const tab = env.addTab(sourceTab({ incognito: true }));
  env.click(imageClick(CDN_PNG), tab);
  await waitFor(() => env.createdTabs.length === 1, "synthid tab");
  const id = env.createdTabs[0].id;

  const reply = await getPending(env, id);
  assert.equal(reply.found, true);
  assert.equal(reply.name, "cat.png");
  assert.deepEqual(await bytesOf(reply.blob), Array.from(PNG));
  assert.deepEqual(await diskRecords(env), [], "nothing may be written to disk in a private window");

  // The rest of the lifecycle works against the in-memory record too.
  await env.send({ type: "synthid:attached", signInRequired: false }, env.synthidSender(id));
  assert.equal((await getPending(env, id)).autoAttach, false);
  assert.deepEqual(await diskRecords(env), []);

  env.events.tabsOnRemoved.fire(id, {});
  await waitFor(async () => (await getPending(env, id)).found === false, "memory record removed");
});

test("private window data: URL media also stays out of IndexedDB", async () => {
  const env = await loadBackground();
  const newTab = await seedPending(env, sourceTab({ incognito: true }));
  assert.equal((await getPending(env, newTab.id)).found, true);
  assert.deepEqual(await diskRecords(env), []);
  assert.deepEqual(await env.send({ type: "synthid:clear" }, env.synthidSender(newTab.id)), { ok: true });
  assert.deepEqual(await getPending(env, newTab.id), { found: false });
});

// ---------------------------------------------------------------------------
// 8. find-media

test("find-media on a page whose media is same-origin still works when the background fetch is unavailable", async () => {
  const env = await loadBackground({ allSites: false, requestResult: false });
  const media = { kind: "image", url: "https://example.com/a.png", isBlob: false, isMediaSource: false };
  env.scriptHandler = (d) => {
    if (!d.func) return [{}];
    if (d.args && d.args[0] === 42) return [{ result: media }];
    return [{ result: { ok: true, blob: new Blob([PNG], { type: "image/png" }), type: "image/png", url: media.url } }];
  };
  const tab = env.addTab(sourceTab());
  env.click({ menuItemId: "find-media", pageUrl: PAGE_URL, frameId: 0, targetElementId: 42 }, tab);
  await waitFor(() => env.synthidTabs().length === 1, "synthid tab");
  assert.equal(env.calls.fetch.length, 0);
  assert.ok(!env.calls.tabsCreate.some((p) => p.url !== SYNTHID_URL));
});

test("find-media that finds nothing shows the nothing-found notice", async () => {
  const env = await loadBackground();
  env.scriptHandler = findMediaScript(null);
  const tab = env.addTab(sourceTab());
  env.click({ menuItemId: "find-media", pageUrl: PAGE_URL, frameId: 0 }, tab);
  await waitFor(() => bannerCalls(env, 5).length === 1, "notice");
  const shown = bannerCalls(env, 5)[0].args[0];
  assert.equal(shown.state, "info");
  assert.match(shown.message, /No image, video or audio found/);
  assert.equal(env.calls.tabsCreate.length, 0);
});

test("synthid:granted messages are ignored: there is no grant page any more", async () => {
  const env = await loadBackground({ allSites: false, requestResult: false });
  env.fetchHandler = async () => pngResponse();
  const senders = [
    { id: EXT_ID, url: EXT_BASE + "src/grant/grant.html", tab: { id: 999 } },
    env.synthidSender(7),
    { id: EXT_ID, url: "https://evil.example/", tab: { id: 7 } },
    { id: EXT_ID, url: POPUP_URL },
  ];
  for (const sender of senders) {
    assert.equal(await env.send({ type: "synthid:granted", requestId: "abc" }, sender), undefined);
  }
  assert.equal(env.events.onMessage.listeners.length, 1);
  await tick();
  assert.equal(env.calls.fetch.length, 0);
  assert.equal(env.calls.tabsCreate.length, 0);
  assert.equal(env.calls.executeScript.length, 0);
  assert.equal(env.calls.permissionsRequest.length, 0);
});

test("a cross-origin network failure shows one notice and does not loop or request anything", async () => {
  const env = await loadBackground();
  // Background fetch fails at the network level (default handler throws).
  const tab = env.addTab(sourceTab());
  env.click(imageClick(CDN_PNG), tab);
  await waitFor(() => bannerCalls(env, 5).length === 1, "network error notice");
  assert.match(bannerCalls(env, 5)[0].args[0].message, /Couldn't download the file \(network error\)/);
  await tick();
  assert.equal(env.calls.fetch.length, 1);
  assert.equal(env.calls.permissionsRequest.length, 0);
  assert.equal(env.calls.tabsCreate.length, 0);
  assert.equal(bannerCalls(env, 5).length, 1);
});

// ---------------------------------------------------------------------------
// Toolbar picker

function assertPickerInjected(env, tabId) {
  assert.deepEqual(env.calls.executeScript[0].files, ["src/content/resolve.js", "src/content/picker.js"]);
  assert.deepEqual(env.calls.executeScript[0].target, { tabId, frameIds: [0] });
  assert.equal(env.calls.executeScript[0].injectImmediately, true);
  assert.equal(typeof env.calls.executeScript[1].func, "function");
}

test("popup's Pick media button starts the picker; synthid:picked then resumes the check", async () => {
  const env = await loadBackground();
  env.fetchHandler = async () => pngResponse();
  const tab = env.addTab(sourceTab());
  const reply = await env.send({ type: "synthid:startPicker", tabId: tab.id }, { id: EXT_ID, url: POPUP_URL });
  assert.deepEqual(reply, { ok: true });
  assert.equal(env.calls.executeScript.length, 2);
  assertPickerInjected(env, 5);

  const media = { kind: "image", url: CDN_PNG, isBlob: false, isMediaSource: false };
  const sender = { id: EXT_ID, url: PAGE_URL, tab, frameId: 0 };
  assert.equal(await env.send({ type: "synthid:picked", media }, sender), undefined);
  await waitFor(() => env.synthidTabs().length === 1, "synthid tab");
  assert.equal((await getPending(env, env.synthidTabs()[0].id)).found, true);
});

test("synthid:startPicker is refused unless it comes from the popup", async () => {
  const env = await loadBackground();
  const tab = env.addTab(sourceTab());
  for (const sender of [
    { id: EXT_ID, url: PAGE_URL, tab, frameId: 0 },
    { id: EXT_ID, url: EXT_BASE + "src/options/options.html" },
    { id: "other@ext", url: POPUP_URL },
  ]) {
    const reply = await env.send({ type: "synthid:startPicker", tabId: tab.id }, sender);
    assert.notEqual(reply?.ok, true);
  }
  assert.deepEqual(await env.send({ type: "synthid:startPicker" }, { id: EXT_ID, url: POPUP_URL }), { ok: false });
  assert.equal(env.calls.executeScript.length, 0);
});

test("synthid:startPicker replies ok:false when the page blocks injection", async () => {
  const env = await loadBackground();
  const tab = env.addTab(sourceTab());
  env.scriptHandler = () => {
    throw new Error("Missing host permission for the tab");
  };
  const reply = await env.send({ type: "synthid:startPicker", tabId: tab.id }, { id: EXT_ID, url: POPUP_URL });
  assert.deepEqual(reply, { ok: false });
});

test("the start-picker shortcut starts the picker in the given tab, or the active tab", async () => {
  const env = await loadBackground();
  const tab = env.addTab(sourceTab());
  env.events.commandsOnCommand.fire("start-picker", tab);
  await waitFor(() => env.calls.executeScript.length === 2, "picker injection");
  assertPickerInjected(env, 5);

  env.calls.executeScript.length = 0;
  env.events.commandsOnCommand.fire("start-picker");
  await waitFor(() => env.calls.executeScript.length === 2, "picker injection via active tab");
  assertPickerInjected(env, 5);

  env.calls.executeScript.length = 0;
  env.events.commandsOnCommand.fire("_execute_action", tab);
  await tick();
  assert.equal(env.calls.executeScript.length, 0);
});

test("start-picker shortcut with access revoked requests <all_urls> synchronously and still starts the picker", async () => {
  const env = await loadBackground({ allSites: false, requestResult: false });
  const tab = env.addTab(sourceTab());
  env.inListener = true;
  env.events.commandsOnCommand.fire("start-picker", tab);
  const synchronousCalls = env.calls.permissionsRequest.length;
  env.inListener = false;
  assert.equal(synchronousCalls, 1, "permissions.request must be called before any await");
  assert.equal(env.calls.permissionsRequest[0].synchronous, true);
  assert.deepEqual(env.calls.permissionsRequest[0].perms, ALL_SITES_REQUEST);

  // Declined, but pick mode is not blocked.
  await waitFor(() => env.calls.executeScript.length === 2, "picker injection");
  assertPickerInjected(env, 5);

  // Also when the tab has to be looked up first (an await before injection).
  env.calls.permissionsRequest.length = 0;
  env.calls.executeScript.length = 0;
  env.command("start-picker");
  assert.equal(env.calls.permissionsRequest.length, 1);
  assert.equal(env.calls.permissionsRequest[0].synchronous, true);
  await waitFor(() => env.calls.executeScript.length === 2, "picker injection via active tab");
});

test("start-picker shortcut with access granted, and other commands, request nothing", async () => {
  const env = await loadBackground();
  const tab = env.addTab(sourceTab());
  env.command("start-picker", tab);
  await waitFor(() => env.calls.executeScript.length === 2, "picker injection");
  env.command("_execute_action", tab);
  await tick();
  assert.equal(env.calls.permissionsRequest.length, 0);

  const revoked = await loadBackground({ allSites: false });
  revoked.command("_execute_action", revoked.addTab(sourceTab()));
  await tick();
  assert.equal(revoked.calls.permissionsRequest.length, 0);
});

test("synthid:picked with nothing shows the nothing-found notice", async () => {
  const env = await loadBackground();
  const tab = env.addTab(sourceTab());
  await env.send({ type: "synthid:picked", media: null }, { id: EXT_ID, url: PAGE_URL, tab, frameId: 0 });
  await waitFor(() => bannerCalls(env, 5).length === 1, "notice");
  assert.match(bannerCalls(env, 5)[0].args[0].message, /No image, video or audio found/);
});

// ---------------------------------------------------------------------------
// 9. Startup

test("onStartup recreates the menus and clears every pending record, disk and private", async () => {
  const env = await loadBackground();
  env.fetchHandler = async () => pngResponse();
  const normal = await seedPending(env, sourceTab({ id: 5 }));
  // A second, private record held in memory.
  const privateTab = env.addTab(sourceTab({ id: 6, incognito: true }));
  env.click(imageClick(CDN_PNG), privateTab);
  await waitFor(() => env.synthidTabs().length === 2, "second synthid tab");
  const priv = env.synthidTabs()[1];
  assert.equal((await diskRecords(env)).length, 1);
  assert.equal((await getPending(env, priv.id)).found, true);

  env.events.onStartup.fire();
  await waitFor(() => env.calls.menusCreate.length === 2, "menus recreated");
  assert.equal(env.calls.menusRemoveAll, 1);
  await waitFor(async () => (await diskRecords(env)).length === 0, "disk records cleared");
  assert.deepEqual(await getPending(env, normal.id), { found: false });
  assert.deepEqual(await getPending(env, priv.id), { found: false });
});

test("loading the event page purges expired records but keeps fresh ones", async () => {
  // Pre-populate the DB the way an earlier event-page run would have.
  const env = makeEnv();
  const seed = (id, createdAt) =>
    new Promise((resolve, reject) => {
      const r = env.indexedDB.open("synthid-check", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("pending", { keyPath: "tabId" });
      r.onsuccess = () => {
        const db = r.result;
        const tx = db.transaction("pending", "readwrite");
        tx.objectStore("pending").put({ tabId: id, createdAt, name: "x.png", type: "image/png", blob: new Blob([PNG]) });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  await seed(11, Date.now() - 60 * 60 * 1000);
  await seed(12, Date.now());
  for (const rel of SCRIPTS) {
    const file = path.join(ROOT, rel);
    new vm.Script(fs.readFileSync(file, "utf8"), { filename: file }).runInContext(env.context);
  }
  await waitFor(async () => (await diskRecords(env)).map((r) => r.tabId).join() === "12", "expired purged");
});

// ---------------------------------------------------------------------------
// More acquire paths

test("a blob: image from the picker is read inside the source frame", async () => {
  const env = await loadBackground();
  const tab = env.addTab(sourceTab());
  env.scriptHandler = (d) => {
    if (d.files) return [{}];
    return [{ result: { ok: true, blob: new Blob([PNG], { type: "image/png" }), type: "image/png" } }];
  };
  const media = { kind: "image", url: "blob:https://example.com/abc", isBlob: true, isMediaSource: false };
  await env.send({ type: "synthid:picked", media }, { id: EXT_ID, url: PAGE_URL, tab, frameId: 0 });
  await waitFor(() => env.synthidTabs().length === 1, "synthid tab");
  const read = env.calls.executeScript.find((d) => d.func);
  assert.deepEqual(read.target, { tabId: 5, frameIds: [0] });
  assert.deepEqual(read.args, ["blob:https://example.com/abc"]);
  assert.equal(env.calls.fetch.length, 0);
  const reply = await getPending(env, env.synthidTabs()[0].id);
  assert.equal(reply.sourceUrl, PAGE_URL);
  assert.equal(reply.name, "synthid-check.png");
  assert.deepEqual(await bytesOf(reply.blob), Array.from(PNG));
});

test("an unreadable blob: video and a MediaSource video both get the streaming notice", async () => {
  for (const media of [
    { kind: "video", url: "blob:https://example.com/v", isBlob: true, isMediaSource: false },
    { kind: "video", url: "https://example.com/v.mp4", isBlob: false, isMediaSource: true },
  ]) {
    const env = await loadBackground();
    const tab = env.addTab(sourceTab());
    env.scriptHandler = (d) => (d.files ? [{}] : [{ result: { ok: false, error: "TypeError: failed" } }]);
    await env.send({ type: "synthid:picked", media }, { id: EXT_ID, url: PAGE_URL, tab, frameId: 0 });
    await waitFor(() => bannerCalls(env, 5).length === 1, "streaming notice");
    assert.match(bannerCalls(env, 5)[0].args[0].message, /streaming video/);
    assert.equal(bannerCalls(env, 5)[0].args[0].state, "warn");
    assert.equal(env.calls.tabsCreate.length, 0);
  }
});

test("a file that streams past the size cap without content-length is aborted", async () => {
  const env = await loadBackground();
  env.fetchHandler = async (url, init) => ({
    ok: true,
    status: 200,
    url,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "image/png" : null) },
    body: {
      getReader: () => ({
        read: async () => ({ done: false, value: { byteLength: 150 * 1024 * 1024 } }),
      }),
    },
    signal: init.signal,
  });
  const tab = env.addTab(sourceTab());
  env.click(imageClick(CDN_PNG), tab);
  await waitFor(() => bannerCalls(env, 5).length === 1, "too large notice");
  assert.match(bannerCalls(env, 5)[0].args[0].message, /larger than 200 MB/);
  assert.equal(env.calls.tabsCreate.length, 0);
  assert.equal(env.calls.fetch[0].init.signal.aborted, true);
});

test("when the background fetch fails, the same-origin page fetch is the fallback", async () => {
  const env = await loadBackground();
  env.fetchHandler = async () => {
    throw new TypeError("NetworkError");
  };
  env.scriptHandler = (d) =>
    d.func
      ? [{ result: { ok: true, blob: new Blob([PNG], { type: "image/png" }), type: "image/png", url: "https://example.com/a.png" } }]
      : [{}];
  const tab = env.addTab(sourceTab());
  env.click(imageClick("https://example.com/a.png"), tab);
  await waitFor(() => env.synthidTabs().length === 1, "synthid tab");
  assert.equal(env.calls.fetch.length, 1);
  assert.equal((await getPending(env, env.synthidTabs()[0].id)).found, true);
});

test("a cross-origin image whose background fetch fails shows an error and opens nothing", async () => {
  const env = await loadBackground();
  const tab = env.addTab(sourceTab());
  env.click(imageClick(CDN_PNG), tab);
  await waitFor(() => bannerCalls(env, 5).length === 1, "error notice");
  assert.match(bannerCalls(env, 5)[0].args[0].message, /Couldn't download the file/);
  assert.equal(env.calls.tabsCreate.length, 0);
});

test("find-media on a restricted page (executeScript throws) says nothing was found", async () => {
  const env = await loadBackground();
  const tab = env.addTab(sourceTab());
  let n = 0;
  env.scriptHandler = (d) => {
    if (d.files && d.files[0] === "src/content/banner.js") return [{}];
    if (d.args && d.args[0] && d.args[0].message) return [{}];
    n++;
    throw new Error("Missing host permission for the tab");
  };
  env.click({ menuItemId: "find-media", pageUrl: PAGE_URL, frameId: 0 }, tab);
  await waitFor(() => bannerCalls(env, 5).length === 1, "notice");
  assert.ok(n >= 1);
  assert.match(bannerCalls(env, 5)[0].args[0].message, /No image, video or audio found/);
});

test("a slow download shows the working notice, then hides it once synthid.com is opened", async () => {
  const env = await loadBackground();
  env.fetchHandler = () => new Promise((resolve) => setTimeout(() => resolve(pngResponse()), 1000));
  const tab = env.addTab(sourceTab());
  env.click(imageClick(CDN_PNG), tab);
  await waitFor(() => bannerCalls(env, 5).length === 1, "working notice", 2000);
  assert.equal(bannerCalls(env, 5)[0].args[0].state, "working");
  assert.equal(env.createdTabs.length, 0);
  await waitFor(() => env.createdTabs.length === 1, "synthid tab", 3000);
  // hideBanner is a func call with no args.
  await waitFor(
    () => env.calls.executeScript.some((d) => d.target.tabId === 5 && d.func && !d.args),
    "banner hidden",
  );
});

test("a fast download never shows the working notice", async () => {
  const env = await loadBackground();
  env.fetchHandler = async () => pngResponse();
  const tab = env.addTab(sourceTab());
  env.click(imageClick(CDN_PNG), tab);
  await waitFor(() => env.createdTabs.length === 1, "synthid tab");
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(env.calls.executeScript.length, 0);
});

// ---------------------------------------------------------------------------
// Concurrency

test("onInstalled and onStartup firing together do not create duplicate menu items", async () => {
  const env = await loadBackground();
  env.events.onInstalled.fire({ reason: "update" });
  env.events.onStartup.fire();
  await waitFor(() => env.calls.menusRemoveAll >= 1, "menus rebuilt");
  await tick();
  await tick();
  assert.deepEqual(env.calls.menusDuplicate, []);
  assert.deepEqual([...env.menuIds].sort(), ["check-media", "find-media"]);
});

test("two overlapping checks: each synthid tab can read its own file even if the other finished first", async () => {
  const env = await loadBackground();
  const tabA = env.addTab(sourceTab({ id: 5 }));
  const tabB = env.addTab(sourceTab({ id: 6, index: 4 }));
  const dataA = "data:image/png;base64," + Buffer.from(PNG).toString("base64");
  const other = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
  const dataB = "data:image/png;base64," + Buffer.from(other).toString("base64");

  // tabs.create for the first check is slow to resolve; the new tab already exists,
  // and its content script asks for the file in the meantime.
  let releaseA;
  const gateA = new Promise((resolve) => (releaseA = resolve));
  env.createDelay = (n) => (n === 1 ? gateA : undefined);

  env.click(imageClick(dataA), tabA);
  await waitFor(() => env.createdTabs.length === 1, "first synthid tab");
  const idA = env.createdTabs[0].id;
  env.click(imageClick(dataB, { pageUrl: PAGE_URL }), tabB);
  await waitFor(() => env.createdTabs.length === 2, "second synthid tab");
  const idB = env.createdTabs[1].id;

  const earlyA = getPending(env, idA); // asked while A's put() has not happened yet
  const earlyB = getPending(env, idB);
  // Long enough for an unfixed background to answer A with found:false.
  await new Promise((resolve) => setTimeout(resolve, 100));
  releaseA();
  const replyB = await earlyB;
  assert.equal(replyB.found, true);
  assert.deepEqual(await bytesOf(replyB.blob), Array.from(other));

  const replyA = await earlyA;
  assert.equal(replyA.found, true, "the first tab's file must not be reported missing");
  assert.deepEqual(await bytesOf(replyA.blob), Array.from(PNG));
});

// ---------------------------------------------------------------------------
// Drop zone

const DROP_ZONE_DEFINITION = {
  id: "drop-zone",
  matches: ["<all_urls>"],
  excludeMatches: [SYNTHID_PATTERN],
  js: ["src/content/resolve.js", "src/content/dropzone.js"],
  allFrames: true,
  runAt: "document_start",
};

test("drop zone: registered on load with the exact definition by default", async () => {
  const env = await loadBackground();
  await waitFor(() => env.registeredScripts.size === 1, "registration");
  assert.deepEqual([...env.registeredScripts.values()], [DROP_ZONE_DEFINITION]);
  assert.deepEqual(env.scriptingLog.filter((x) => x !== "get"), ["register"]);
});

test("drop zone: the registered files exist", async () => {
  const env = await loadBackground();
  await waitFor(() => env.registeredScripts.size === 1, "registration");
  for (const f of env.registeredScripts.get("drop-zone").js) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test("drop zone: not registered when the setting is off", async () => {
  const env = await loadBackground({ syncStorage: { dropZone: false } });
  await tick();
  assert.equal(env.registeredScripts.size, 0);
  assert.deepEqual(env.scriptingLog.filter((x) => x !== "get"), []);
});

test("drop zone: storage changes register and unregister it", async () => {
  const env = await loadBackground({ syncStorage: { dropZone: false } });
  assert.equal(env.registeredScripts.size, 0);

  env.syncStorage.dropZone = true;
  env.events.storageOnChanged.fire({ dropZone: { oldValue: false, newValue: true } }, "sync");
  await waitFor(() => env.registeredScripts.size === 1, "registration after enabling");
  assert.deepEqual([...env.registeredScripts.values()], [DROP_ZONE_DEFINITION]);

  env.syncStorage.dropZone = false;
  env.events.storageOnChanged.fire({ dropZone: { oldValue: true, newValue: false } }, "sync");
  await waitFor(() => env.registeredScripts.size === 0, "unregistration after disabling");
  assert.equal(env.calls.consoleWarn.length, 0);
});

test("drop zone: unrelated storage changes and other areas are ignored", async () => {
  const env = await loadBackground();
  await waitFor(() => env.registeredScripts.size === 1, "registration");
  env.syncStorage.dropZone = false;
  env.events.storageOnChanged.fire({ openInForeground: { newValue: false } }, "sync");
  env.events.storageOnChanged.fire({ dropZone: { newValue: false } }, "local");
  await tick();
  await tick();
  assert.equal(env.registeredScripts.size, 1);
});

test("drop zone: enabling when already registered does not register twice or warn", async () => {
  const env = await loadBackground();
  await waitFor(() => env.registeredScripts.size === 1, "registration");
  env.events.storageOnChanged.fire({ dropZone: { oldValue: true, newValue: true } }, "sync");
  await tick();
  await tick();
  assert.equal(env.scriptingLog.filter((x) => x === "register").length, 1);
  assert.equal(env.calls.consoleWarn.length, 0);
});

test("drop zone: onInstalled refreshes an already registered script with updateContentScripts", async () => {
  const env = await loadBackground();
  await waitFor(() => env.registeredScripts.size === 1, "registration");
  // Simulate a stale definition left over from the previous version.
  env.registeredScripts.set("drop-zone", { ...DROP_ZONE_DEFINITION, js: ["src/content/old.js"] });
  env.events.onInstalled.fire({ reason: "update" });
  await waitFor(() => env.scriptingLog.includes("update"), "update");
  await tick();
  assert.deepEqual([...env.registeredScripts.values()], [DROP_ZONE_DEFINITION]);
  assert.equal(env.scriptingLog.filter((x) => x === "register").length, 1);
});

test("drop zone: onInstalled registers it when not yet registered, and leaves it off when disabled", async () => {
  const env = await loadBackground({ syncStorage: { dropZone: false } });
  env.events.onInstalled.fire({ reason: "install" });
  await tick();
  await tick();
  assert.equal(env.registeredScripts.size, 0);

  env.syncStorage.dropZone = true;
  env.events.onInstalled.fire({ reason: "update" });
  await waitFor(() => env.registeredScripts.size === 1, "registration");
  assert.equal(env.scriptingLog.includes("update"), false);
});

test("drop zone: overlapping syncs register it only once", async () => {
  const env = makeEnv();
  let release;
  const gate = new Promise((r) => (release = r));
  env.registryDelay = () => gate;
  for (const rel of SCRIPTS) {
    const file = path.join(ROOT, rel);
    new vm.Script(fs.readFileSync(file, "utf8"), { filename: file }).runInContext(env.context);
  }
  // The load-time sync is stuck in its registry lookup; pile more on top.
  env.events.onInstalled.fire({ reason: "install" });
  env.events.storageOnChanged.fire({ dropZone: { newValue: true } }, "sync");
  env.events.storageOnChanged.fire({ dropZone: { newValue: true } }, "sync");
  await tick();
  assert.equal(env.scriptingLog.filter((x) => x === "get").length, 1, "later syncs wait for the first");
  release();
  await waitFor(() => env.registeredScripts.size === 1, "registration");
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(env.scriptingLog.filter((x) => x === "register").length, 1);
  assert.equal(env.registeredScripts.size, 1);
  assert.equal(env.calls.consoleWarn.length, 0, JSON.stringify(env.calls.consoleWarn));
});

test("drop zone: a failing registration is logged and later syncs still work", async () => {
  const env = await loadBackground({ syncStorage: { dropZone: false } });
  const original = env.browser.scripting.registerContentScripts;
  env.browser.scripting.registerContentScripts = async () => {
    throw new Error("boom");
  };
  env.syncStorage.dropZone = true;
  env.events.storageOnChanged.fire({ dropZone: { newValue: true } }, "sync");
  await waitFor(() => env.calls.consoleWarn.length === 1, "warning");
  env.browser.scripting.registerContentScripts = original;
  env.events.storageOnChanged.fire({ dropZone: { newValue: true } }, "sync");
  await waitFor(() => env.registeredScripts.size === 1, "registration");
});

test("synthid:dropped opens synthid.com with the dropped file", async () => {
  const env = await loadBackground();
  const tab = env.addTab(sourceTab());
  env.fetchHandler = async () => pngResponse();
  const media = { kind: "image", url: CDN_PNG, isBlob: false, isMediaSource: false };
  assert.equal(await env.send({ type: "synthid:dropped", media }, { id: EXT_ID, url: PAGE_URL, tab, frameId: 0 }), undefined);
  await waitFor(() => env.synthidTabs().length === 1, "synthid tab");
  assert.equal(env.calls.fetch[0].url, CDN_PNG);
  const reply = await getPending(env, env.synthidTabs()[0].id);
  assert.equal(reply.found, true);
  assert.equal(reply.sourceUrl, CDN_PNG);
  assert.equal(reply.name, "cat.png");
  assert.deepEqual(await bytesOf(reply.blob), Array.from(PNG));
});

test("synthid:dropped reads a blob: image in the frame that sent it", async () => {
  const env = await loadBackground();
  const tab = env.addTab(sourceTab());
  env.scriptHandler = (d) => {
    if (d.files) return [{}];
    return [{ result: { ok: true, blob: new Blob([PNG], { type: "image/png" }), type: "image/png" } }];
  };
  const media = { kind: "image", url: "blob:https://ads.example.net/abc", isBlob: true, isMediaSource: false };
  const frameUrl = "https://ads.example.net/frame";
  await env.send({ type: "synthid:dropped", media }, { id: EXT_ID, url: frameUrl, tab, frameId: 7 });
  await waitFor(() => env.synthidTabs().length === 1, "synthid tab");
  const read = env.calls.executeScript.find((d) => d.func);
  assert.deepEqual(read.target, { tabId: 5, frameIds: [7] });
  assert.deepEqual(read.args, ["blob:https://ads.example.net/abc"]);
  assert.equal(env.calls.fetch.length, 0);
  const reply = await getPending(env, env.synthidTabs()[0].id);
  assert.deepEqual(await bytesOf(reply.blob), Array.from(PNG));
});

test("synthid:dropped without a frameId defaults to the top frame", async () => {
  const env = await loadBackground();
  const tab = env.addTab(sourceTab());
  env.scriptHandler = (d) => {
    if (d.files) return [{}];
    return [{ result: { ok: true, blob: new Blob([PNG], { type: "image/png" }), type: "image/png" } }];
  };
  const media = { kind: "image", url: "blob:https://example.com/abc", isBlob: true, isMediaSource: false };
  await env.send({ type: "synthid:dropped", media }, { id: EXT_ID, url: PAGE_URL, tab });
  await waitFor(() => env.synthidTabs().length === 1, "synthid tab");
  assert.deepEqual(env.calls.executeScript.find((d) => d.func).target, { tabId: 5, frameIds: [0] });
});

test("synthid:dropped with no media sends no notice and opens nothing", async () => {
  const env = await loadBackground();
  const tab = env.addTab(sourceTab());
  for (const media of [null, undefined, {}, { url: "" }, { url: 5 }]) {
    await env.send({ type: "synthid:dropped", media }, { id: EXT_ID, url: PAGE_URL, tab, frameId: 0 });
  }
  await env.send({ type: "synthid:dropped", media: { kind: "image", url: CDN_PNG } }, { id: EXT_ID, url: PAGE_URL, frameId: 0 });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(bannerCalls(env, 5).length, 0);
  assert.equal(env.calls.executeScript.length, 0);
  assert.equal(env.calls.tabsCreate.length, 0);
  assert.equal(env.calls.fetch.length, 0);
});

const OPTIONS_URL = EXT_BASE + "src/options/options.html";

test("synthid:syncDropZone from the popup re-syncs the registration and replies ok", async () => {
  const env = await loadBackground({ syncStorage: { dropZone: false } });
  assert.equal(env.registeredScripts.size, 0);
  env.syncStorage.dropZone = true;
  const reply = await env.send({ type: "synthid:syncDropZone" }, { id: EXT_ID, url: POPUP_URL + "?x=1" });
  assert.deepEqual(reply, { ok: true });
  assert.equal(env.registeredScripts.size, 1, "registered by the time the reply arrives");

  env.syncStorage.dropZone = false;
  assert.deepEqual(await env.send({ type: "synthid:syncDropZone" }, { id: EXT_ID, url: POPUP_URL }), { ok: true });
  assert.equal(env.registeredScripts.size, 0);
});

test("synthid:syncDropZone from any other sender is refused and changes nothing", async () => {
  const env = await loadBackground({ syncStorage: { dropZone: false } });
  env.syncStorage.dropZone = true;
  const tab = env.addTab(sourceTab());
  for (const sender of [
    { id: EXT_ID, url: OPTIONS_URL },
    { id: EXT_ID, url: PAGE_URL, tab, frameId: 0 },
    { id: EXT_ID, url: "https://evil.example/src/popup/popup.html" },
    { id: EXT_ID, url: "https://evil.example/" + "src/options/options.html" },
    { id: EXT_ID },
  ]) {
    assert.deepEqual(await env.send({ type: "synthid:syncDropZone" }, sender), { ok: false });
  }
  await tick();
  assert.equal(env.registeredScripts.size, 0);
  assert.deepEqual(env.scriptingLog.filter((x) => x !== "get"), []);
});

test("other notices carry no actions", async () => {
  const env = await loadBackground();
  const tab = env.addTab(sourceTab());
  env.fetchHandler = async () => new Response("x", { status: 500 });
  env.click(imageClick(CDN_PNG), tab);
  await waitFor(() => bannerCalls(env, 5).length === 1, "notice");
  assert.deepEqual(bannerCalls(env, 5)[0].args[0].actions, []);
});

test("synthid:openSettings is gone: unknown message, nothing happens", async () => {
  const env = await loadBackground();
  const tab = env.addTab(sourceTab());
  assert.equal(await env.send({ type: "synthid:openSettings" }, { id: EXT_ID, url: PAGE_URL, tab, frameId: 0 }), undefined);
  assert.equal(env.calls.openOptionsPage, undefined);
});

test("manifest has no options page and every file it references exists", () => {
  assert.equal("options_ui" in MANIFEST, false);
  const files = [
    ...MANIFEST.background.scripts,
    ...MANIFEST.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])]),
    MANIFEST.action.default_popup,
    MANIFEST.action.default_icon,
    ...Object.values(MANIFEST.icons),
  ];
  assert.ok(files.length >= 8);
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});
