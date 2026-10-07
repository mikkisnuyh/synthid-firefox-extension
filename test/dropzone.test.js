"use strict";

// Tests for src/content/dropzone.js: loaded fresh into a fresh jsdom window per test
// (it is an IIFE that registers window listeners at load).

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { implForWrapper } = require("jsdom/lib/generated/idl/utils.js");

const RESOLVE_SRC = fs.readFileSync(path.join(__dirname, "../src/content/resolve.js"), "utf8");
const DROPZONE_SRC = fs.readFileSync(path.join(__dirname, "../src/content/dropzone.js"), "utf8");
const NATIVE_IMAGE = "application/x-moz-nativeimage";
const HOST = '[data-synthid-picker="dropzone"]';
const PROBE = '[data-synthid-picker="probe"]';

let dom;
let messages;

afterEach(() => {
  dom?.window.close();
  dom = null;
});

// A mock storage API: sync.get applies defaults over `store`; onChanged keeps its listeners.
function makeStorage(store = {}) {
  const storage = {
    store,
    gets: [],
    listeners: [],
    sync: {
      get: async (defaults) => {
        storage.gets.push(defaults);
        return { ...defaults, ...storage.store };
      },
    },
    onChanged: { addListener: (fn) => storage.listeners.push(fn) },
    change: (changes, area = "sync") => storage.listeners.forEach((fn) => fn(changes, area)),
  };
  return storage;
}

function setup(html = "", { width = 1024, height = 768, load = true, storage = makeStorage() } = {}) {
  dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: "https://example.com/dir/page.html",
    runScripts: "outside-only",
  });
  const w = dom.window;
  messages = [];
  w.browser = { runtime: { sendMessage: (m) => (messages.push(m), Promise.resolve()) }, storage };
  Object.defineProperty(w, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(w, "innerHeight", { value: height, configurable: true });
  w.eval(RESOLVE_SRC);
  if (load) w.eval(DROPZONE_SRC);
  return w;
}

// Events created by scripts are untrusted, and EventTarget.dispatchEvent() resets isTrusted
// to false. So trusted events are dispatched through jsdom's internal impl with the flag set.
function trusted(event) {
  implForWrapper(event).isTrusted = true;
  return event;
}

function dispatchTrusted(target, event) {
  const impl = implForWrapper(target) || target;
  return impl._dispatch(implForWrapper(trusted(event)));
}

function makeEvent(w, type, { target, types, effectAllowed, buttons, clientX = 10, clientY = 10, isTrusted = true, composed = false } = {}) {
  const e = new w.MouseEvent(type, { bubbles: true, composed, cancelable: true, clientX, clientY, buttons: buttons ?? 0 });
  if (types || effectAllowed) {
    Object.defineProperty(e, "dataTransfer", {
      value: { types: types || [], effectAllowed: effectAllowed || "uninitialized", dropEffect: "none" },
    });
  }
  return e;
}

function fire(w, target, type, opts = {}) {
  const e = makeEvent(w, type, opts);
  if (opts.isTrusted === false) target.dispatchEvent(e);
  else dispatchTrusted(target, e);
  return e;
}

// jsdom has no layout: give an element a bounding rect.
function setRect(el, left, top, right, bottom) {
  el.getBoundingClientRect = () => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top });
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const hostEl = (w) => w.document.querySelector(HOST);

// A trusted dragover somewhere else on the page: the pointer left the drag source's area,
// which arms the zone so a drop on it counts.
function arm(w) {
  fire(w, w.document.body, "dragover", { types: [], effectAllowed: "all" });
}

async function startImageDrag(w, selector = "#img") {
  const img = w.document.querySelector(selector);
  const e = fire(w, img, "dragstart");
  await tick();
  return e;
}

const IMG = '<img id="img" src="https://example.com/cat.png">';
const EXPECTED_MEDIA = { kind: "image", url: "https://example.com/cat.png", isBlob: false, isMediaSource: false };

test("trusted-event helper produces isTrusted events", () => {
  const w = setup("", { load: false });
  assert.equal(new w.Event("x").isTrusted, false);
  assert.equal(trusted(new w.Event("x")).isTrusted, true);
  let seen;
  w.document.addEventListener("x", (e) => (seen = e.isTrusted));
  dispatchTrusted(w.document, new w.Event("x"));
  assert.equal(seen, true);
  w.document.dispatchEvent(new w.Event("x"));
  assert.equal(seen, false);
  const pagehide = [];
  w.addEventListener("y", (e) => pagehide.push(e.isTrusted));
  dispatchTrusted(w, new w.Event("y"));
  assert.deepEqual(pagehide, [true]);
});

test("dragging an image shows the zone after a tick, not synchronously", async () => {
  const w = setup(IMG);
  fire(w, w.document.getElementById("img"), "dragstart");
  assert.equal(hostEl(w), null);
  await tick();
  const host = hostEl(w);
  assert.ok(host);
  assert.equal(host.parentNode, w.document.documentElement);
  assert.equal(host.getAttribute("data-synthid-picker"), "dropzone");
  assert.equal(host.shadowRoot, null, "closed shadow root");
});

test("dragging text or a plain link shows nothing", async () => {
  const w = setup('<p id="p">hello</p><a id="a" href="https://example.com/x">link</a>');
  fire(w, w.document.getElementById("p"), "dragstart", { types: ["text/plain"] });
  fire(w, w.document.getElementById("a"), "dragstart", { types: ["text/uri-list", "text/plain"] });
  await tick();
  assert.equal(hostEl(w), null);
});

test("a video drag shows nothing", async () => {
  const w = setup('<video id="v" src="https://example.com/v.mp4"></video>');
  fire(w, w.document.getElementById("v"), "dragstart");
  await tick();
  assert.equal(hostEl(w), null);
});

test("a link drag with the native image type uses the image under the point", async () => {
  const w = setup('<a id="a" href="https://example.com/x"><img id="img" src="https://example.com/cat.png"></a>');
  const img = w.document.getElementById("img");
  w.document.elementsFromPoint = (x, y) => {
    assert.deepEqual([x, y], [33, 44]);
    return [img, w.document.getElementById("a"), w.document.body];
  };
  fire(w, w.document.getElementById("a"), "dragstart", { types: ["text/uri-list", NATIVE_IMAGE], clientX: 33, clientY: 44 });
  await tick();
  assert.ok(hostEl(w));
  // And the drop carries that image.
  arm(w);
  fire(w, hostEl(w), "drop");
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: "synthid:dropped", media: EXPECTED_MEDIA }]);
});

test("native image type with nothing resolvable under the point shows nothing", async () => {
  const w = setup('<a id="a" href="https://example.com/x">x</a>');
  w.document.elementsFromPoint = () => [w.document.getElementById("a"), w.document.body];
  fire(w, w.document.getElementById("a"), "dragstart", { types: [NATIVE_IMAGE] });
  await tick();
  assert.equal(hostEl(w), null);
});

test("an untrusted dragstart is ignored", async () => {
  const w = setup(IMG);
  fire(w, w.document.getElementById("img"), "dragstart", { isTrusted: false });
  await tick();
  assert.equal(hostEl(w), null);
});

test("a dragstart cancelled by the page shows nothing", async () => {
  const w = setup(IMG);
  w.document.getElementById("img").addEventListener("dragstart", (e) => e.preventDefault());
  const e = await startImageDrag(w);
  assert.equal(e.defaultPrevented, true);
  assert.equal(hostEl(w), null);
});

test("a frame smaller than 240x160 shows nothing; exactly 240x160 does", async () => {
  for (const [width, height, shown] of [
    [239, 400, false],
    [400, 159, false],
    [100, 100, false],
    [240, 160, true],
  ]) {
    const w = setup(IMG, { width, height });
    await startImageDrag(w);
    assert.equal(Boolean(hostEl(w)), shown, `${width}x${height}`);
    w.close();
  }
});

test("dragover on the zone is cancelled, gets a drop effect, and never reaches the page", async () => {
  const w = setup(IMG);
  await startImageDrag(w);
  arm(w);
  let pageSaw = 0;
  w.addEventListener("dragover", () => pageSaw++);
  w.addEventListener("dragover", () => pageSaw++, true);
  const over = fire(w, hostEl(w), "dragover", { types: ["text/uri-list"], effectAllowed: "all" });
  assert.equal(over.defaultPrevented, true);
  assert.equal(over.dataTransfer.dropEffect, "copy");
  assert.equal(pageSaw, 0);

  const enter = fire(w, hostEl(w), "dragenter", { types: [], effectAllowed: "move" });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(enter.dataTransfer.dropEffect, "move");
});

test("the drop effect respects effectAllowed", async () => {
  const w = setup(IMG);
  await startImageDrag(w);
  arm(w);
  const expected = { none: "none", copy: "copy", copyMove: "copy", link: "link", linkMove: "link", move: "move", uninitialized: "copy" };
  for (const [allowed, effect] of Object.entries(expected)) {
    const e = fire(w, hostEl(w), "dragover", { types: [], effectAllowed: allowed });
    assert.equal(e.dataTransfer.dropEffect, effect, allowed);
  }
});

test("dragover elsewhere on the page is untouched", async () => {
  const w = setup(IMG + "<div id='other'></div>");
  await startImageDrag(w);
  let pageSaw = 0;
  w.addEventListener("dragover", () => pageSaw++);
  const e = fire(w, w.document.getElementById("other"), "dragover", { types: [], effectAllowed: "all" });
  assert.equal(e.defaultPrevented, false);
  assert.equal(e.dataTransfer.dropEffect, "none");
  assert.equal(pageSaw, 1);
});

test("dragover on the zone does nothing when no zone is shown (no drag)", async () => {
  const w = setup(IMG);
  const probe = w.document.createElement("div");
  probe.setAttribute("data-synthid-picker", "dropzone");
  w.document.body.appendChild(probe);
  const e = fire(w, probe, "dragover", { types: [], effectAllowed: "all" });
  assert.equal(e.defaultPrevented, false);
});

test("untrusted dragover on the zone is not accepted", async () => {
  const w = setup(IMG);
  await startImageDrag(w);
  arm(w);
  const e = fire(w, hostEl(w), "dragover", { types: [], effectAllowed: "all", isTrusted: false });
  assert.equal(e.defaultPrevented, false);
});

test("dropping on the zone sends one synthid:dropped message, removes the zone and hides the drop from the page", async () => {
  const w = setup(IMG);
  await startImageDrag(w);
  arm(w);
  let pageSaw = 0;
  w.addEventListener("drop", () => pageSaw++);
  w.document.addEventListener("drop", () => pageSaw++);
  const drop = fire(w, hostEl(w), "drop");
  assert.equal(drop.defaultPrevented, true);
  assert.equal(pageSaw, 0);
  assert.equal(hostEl(w), null);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: "synthid:dropped", media: EXPECTED_MEDIA }]);

  // The drag is over: a second drop, even on a re-created zone, sends nothing more.
  fire(w, w.document.body, "drop");
  assert.equal(messages.length, 1);
});

test("a rejected sendMessage promise is swallowed", async () => {
  const w = setup(IMG);
  w.browser.runtime.sendMessage = () => Promise.reject(new Error("no receiver"));
  await startImageDrag(w);
  arm(w);
  fire(w, hostEl(w), "drop");
  await tick();
  assert.equal(hostEl(w), null);
});

test("dropping elsewhere hides the zone without sending", async () => {
  const w = setup(IMG + "<div id='other'></div>");
  await startImageDrag(w);
  let pageSaw = 0;
  w.addEventListener("drop", () => pageSaw++);
  const drop = fire(w, w.document.getElementById("other"), "drop");
  assert.equal(drop.defaultPrevented, false, "the page's own drop handling is left alone");
  assert.equal(pageSaw, 1);
  assert.equal(hostEl(w), null);
  assert.deepEqual(messages, []);
});

test("dragend hides the zone", async () => {
  const w = setup(IMG);
  await startImageDrag(w);
  assert.ok(hostEl(w));
  fire(w, w.document.getElementById("img"), "dragend");
  assert.equal(hostEl(w), null);
  assert.deepEqual(messages, []);
});

test("an untrusted dragend does not hide the zone", async () => {
  const w = setup(IMG);
  await startImageDrag(w);
  fire(w, w.document.getElementById("img"), "dragend", { isTrusted: false });
  assert.ok(hostEl(w));
});

test("dragend before the zone shows cancels the pending show", async () => {
  const w = setup(IMG);
  fire(w, w.document.getElementById("img"), "dragstart");
  fire(w, w.document.getElementById("img"), "dragend");
  await tick();
  assert.equal(hostEl(w), null);
});

test("mousemove with no buttons hides the zone; with a button down it stays", async () => {
  const w = setup(IMG);
  await startImageDrag(w);
  fire(w, w.document.body, "mousemove", { buttons: 1 });
  assert.ok(hostEl(w), "buttons 1 keeps it");
  fire(w, w.document.body, "mousemove", { buttons: 0, isTrusted: false });
  assert.ok(hostEl(w), "untrusted move keeps it");
  fire(w, w.document.body, "mousemove", { buttons: 0 });
  assert.equal(hostEl(w), null);
});

test("pagehide hides the zone", async () => {
  const w = setup(IMG);
  await startImageDrag(w);
  dispatchTrusted(w, new w.Event("pagehide"));
  assert.equal(hostEl(w), null);
});

test("an untrusted drop on the zone is ignored", async () => {
  const w = setup(IMG);
  await startImageDrag(w);
  arm(w);
  const drop = fire(w, hostEl(w), "drop", { isTrusted: false });
  assert.equal(drop.defaultPrevented, false);
  assert.ok(hostEl(w));
  assert.deepEqual(messages, []);
});

test("a new drag replaces the previous zone (one host at a time)", async () => {
  const w = setup(IMG + '<img id="img2" src="https://example.com/dog.png">');
  await startImageDrag(w);
  await startImageDrag(w, "#img2");
  assert.equal(w.document.querySelectorAll(HOST).length, 1);
  arm(w);
  fire(w, hostEl(w), "drop");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].media.url, "https://example.com/dog.png");
});

test("SynthIDDropZone.hide removes the zone", async () => {
  const w = setup(IMG);
  await startImageDrag(w);
  w.SynthIDDropZone.hide();
  assert.equal(hostEl(w), null);
  // hide() with the zone already gone is harmless.
  w.SynthIDDropZone.hide();
});

test("loading the script twice is idempotent: one set of listeners", async () => {
  const w = setup(IMG);
  const first = w.SynthIDDropZone;
  w.eval(DROPZONE_SRC);
  assert.equal(w.SynthIDDropZone, first);
  await startImageDrag(w);
  assert.equal(w.document.querySelectorAll(HOST).length, 1);
  arm(w);
  fire(w, hostEl(w), "drop");
  assert.equal(messages.length, 1);
});

test("dragover on the zone before arming is not cancelled and reaches the page", async () => {
  const w = setup(IMG);
  await startImageDrag(w);
  let pageSaw = 0;
  w.addEventListener("dragover", () => pageSaw++);
  const e = fire(w, hostEl(w), "dragover", { types: [], effectAllowed: "all" });
  assert.equal(e.defaultPrevented, false);
  assert.equal(e.dataTransfer.dropEffect, "none");
  assert.equal(pageSaw, 1);
  // Entering elsewhere arms it; then the zone accepts.
  arm(w);
  assert.equal(fire(w, hostEl(w), "dragenter", { types: [], effectAllowed: "all" }).defaultPrevented, true);
});

test("drop on the zone before arming is swallowed, hides the zone and sends nothing", async () => {
  const w = setup(IMG);
  await startImageDrag(w);
  let pageSaw = 0;
  w.addEventListener("drop", () => pageSaw++);
  const drop = fire(w, hostEl(w), "drop");
  assert.equal(drop.defaultPrevented, true);
  assert.equal(pageSaw, 0);
  assert.equal(hostEl(w), null);
  assert.deepEqual(messages, []);
});

test("arming needs a trusted enter/over: an untrusted one elsewhere does not arm", async () => {
  const w = setup(IMG);
  await startImageDrag(w);
  fire(w, w.document.body, "dragover", { isTrusted: false });
  fire(w, hostEl(w), "drop");
  assert.deepEqual(messages, []);
});

test("a new drag resets arming", async () => {
  const w = setup(IMG);
  await startImageDrag(w);
  arm(w);
  await startImageDrag(w);
  fire(w, hostEl(w), "drop");
  assert.deepEqual(messages, []);
});

test("an untrusted pagehide does not hide the zone", async () => {
  const w = setup(IMG);
  await startImageDrag(w);
  w.dispatchEvent(new w.Event("pagehide"));
  assert.ok(hostEl(w));
});

test("a trusted mouseup hides the zone; an untrusted one does not", async () => {
  const w = setup(IMG);
  await startImageDrag(w);
  fire(w, w.document.body, "mouseup", { buttons: 0, isTrusted: false });
  assert.ok(hostEl(w));
  fire(w, w.document.body, "mouseup", { buttons: 0 });
  assert.equal(hostEl(w), null);
});

test("an image inside an open shadow root is found through composedPath", async () => {
  const w = setup('<div id="h"></div>');
  const root = w.document.getElementById("h").attachShadow({ mode: "open" });
  root.innerHTML = '<img id="inner" src="https://example.com/inner.png">';
  const img = root.getElementById("inner");
  dispatchTrusted(img, makeEvent(w, "dragstart", { composed: true }));
  await tick();
  assert.ok(hostEl(w));
  arm(w);
  fire(w, hostEl(w), "drop");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].media.url, "https://example.com/inner.png");
});

test("only http(s), data and blob image URLs show the zone", async () => {
  for (const [url, shown] of [
    ["file:///home/user/cat.png", false],
    ["about:blank", false],
    ["ftp://example.com/cat.png", false],
    ["https://example.com/cat.png", true],
    ["http://example.com/cat.png", true],
    ["data:image/png;base64,AAAA", true],
    ["blob:https://example.com/abc", true],
  ]) {
    const w = setup(`<img id="img" src="${url}">`);
    await startImageDrag(w);
    assert.equal(Boolean(hostEl(w)), shown, url);
    w.close();
  }
});

test("the zone is not shown if the drag ends before the deferred show", async () => {
  const w = setup(IMG);
  fire(w, w.document.getElementById("img"), "dragstart");
  w.SynthIDDropZone.hide();
  await tick();
  assert.equal(hostEl(w), null);
});

// --- Subframes: visible area comes from an IntersectionObserver on a probe element.

function setupFrame({ rect, intersecting = true, noObserver = false }) {
  const parent = new JSDOM("<!doctype html><body></body>", { url: "https://example.com/", runScripts: "outside-only" });
  dom = parent;
  const iframe = parent.window.document.createElement("iframe");
  parent.window.document.body.appendChild(iframe);
  const w = iframe.contentWindow;
  assert.notEqual(w, w.top, "the iframe window is a subframe");
  messages = [];
  w.browser = { runtime: { sendMessage: (m) => (messages.push(m), Promise.resolve()) } };
  Object.defineProperty(w, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(w, "innerHeight", { value: 800, configurable: true });
  const probesSeen = [];
  w.__probes = probesSeen;
  if (!noObserver) {
    w.IntersectionObserver = class {
      constructor(cb) {
        this.cb = cb;
        this.disconnected = false;
      }
      observe(el) {
        probesSeen.push(el.getAttribute("data-synthid-picker"));
        Promise.resolve().then(() => {
          if (!this.disconnected) this.cb([{ isIntersecting: intersecting, intersectionRect: rect }]);
        });
      }
      disconnect() {
        this.disconnected = true;
      }
    };
  }
  w.eval(RESOLVE_SRC);
  w.eval(DROPZONE_SRC);
  w.document.body.innerHTML = IMG;
  return w;
}

const rect = (left, top, right, bottom) => ({ left, top, right, bottom });

test("subframe: not intersecting shows nothing and removes the probe", async () => {
  const w = setupFrame({ rect: rect(0, 0, 0, 0), intersecting: false });
  await startImageDrag(w);
  assert.deepEqual(w.__probes, ["probe"]);
  assert.equal(hostEl(w), null);
  assert.equal(w.document.querySelector(PROBE), null);
});

test("subframe: a visible area below 240x160 shows nothing", async () => {
  for (const r of [rect(0, 0, 239, 500), rect(0, 0, 500, 159)]) {
    const w = setupFrame({ rect: r });
    await startImageDrag(w);
    assert.equal(hostEl(w), null);
    assert.equal(w.document.querySelector(PROBE), null);
    dom.window.close();
  }
});

test("subframe: the visible area is clipped to the viewport", async () => {
  const w = setupFrame({ rect: rect(0, 0, 5000, 100) });
  await startImageDrag(w);
  assert.equal(hostEl(w), null);
});

test("subframe: a big enough visible area shows the zone and removes the probe", async () => {
  const w = setupFrame({ rect: rect(0, 0, 400, 300) });
  await startImageDrag(w);
  assert.ok(hostEl(w));
  assert.equal(w.document.querySelector(PROBE), null);
  arm(w);
  fire(w, hostEl(w), "drop");
  assert.equal(messages.length, 1);
});

test("subframe: hiding before the observer reports shows nothing", async () => {
  const w = setupFrame({ rect: rect(0, 0, 400, 300) });
  fire(w, w.document.getElementById("img"), "dragstart");
  await new Promise((r) => setTimeout(r, 0));
  w.SynthIDDropZone.hide();
  await tick();
  assert.equal(hostEl(w), null);
  assert.equal(w.document.querySelector(PROBE), null);
});

test("subframe without IntersectionObserver falls back to the viewport size", async () => {
  const w = setupFrame({ rect: rect(0, 0, 0, 0), noObserver: true });
  await startImageDrag(w);
  assert.ok(hostEl(w));
});

// --- Corner setting (placement itself isn't observable; only the storage traffic is)

test("the corner setting is read lazily, once, with the top-right default", async () => {
  const storage = makeStorage();
  const w = setup(IMG, { storage });
  assert.equal(storage.gets.length, 0, "nothing read at load");
  await startImageDrag(w);
  await startImageDrag(w);
  assert.deepEqual(JSON.parse(JSON.stringify(storage.gets)), [{ dropZoneCorner: "top-right" }]);
  assert.ok(hostEl(w));
});

test("a non-image drag does not read the corner setting", async () => {
  const storage = makeStorage();
  const w = setup('<p id="p">x</p>', { storage });
  fire(w, w.document.getElementById("p"), "dragstart", { types: ["text/plain"] });
  await tick();
  assert.equal(storage.gets.length, 0);
});

test("storage.onChanged for dropZoneCorner makes the next drag re-read it", async () => {
  const storage = makeStorage();
  const w = setup(IMG, { storage });
  await startImageDrag(w);
  assert.equal(storage.gets.length, 1);
  storage.change({ openInForeground: { newValue: false } });
  storage.change({ dropZoneCorner: { newValue: "bottom-left" } }, "local");
  await startImageDrag(w);
  assert.equal(storage.gets.length, 1, "unrelated changes keep the cache");
  storage.store.dropZoneCorner = "bottom-left";
  storage.change({ dropZoneCorner: { newValue: "bottom-left" } });
  await startImageDrag(w);
  assert.equal(storage.gets.length, 2);
  assert.ok(hostEl(w));
});

test("invalid corner values, a rejecting get and a missing or throwing storage API still show the zone", async () => {
  let storage = makeStorage({ dropZoneCorner: "middle" });
  let w = setup(IMG, { storage });
  await startImageDrag(w);
  assert.ok(hostEl(w), "invalid value");
  w.close();

  storage = makeStorage();
  storage.sync.get = () => Promise.reject(new Error("denied"));
  w = setup(IMG, { storage });
  await startImageDrag(w);
  assert.ok(hostEl(w), "rejecting get");
  w.close();

  storage = makeStorage();
  storage.sync.get = () => {
    throw new Error("sync");
  };
  w = setup(IMG, { storage });
  await startImageDrag(w);
  assert.ok(hostEl(w), "throwing get");
  w.close();

  w = setup(IMG, { storage: undefined });
  delete w.browser.storage;
  await startImageDrag(w);
  assert.ok(hostEl(w), "missing storage (set up after load, read lazily)");
  w.close();

  w = setup(IMG, { load: false });
  delete w.browser.storage;
  w.eval(DROPZONE_SRC);
  await startImageDrag(w);
  assert.ok(hostEl(w), "storage missing at load");
});

// --- Link detection

test("a text link containing an image, dragged by its text, shows nothing", async () => {
  const w = setup('<a id="a" href="https://example.com/x">Some text <img id="img" src="https://example.com/cat.png"></a>');
  w.document.elementsFromPoint = () => [w.document.getElementById("a"), w.document.body];
  fire(w, w.document.getElementById("a"), "dragstart", { types: ["text/uri-list"], clientX: 5, clientY: 5 });
  await tick();
  assert.equal(hostEl(w), null);
});

test("a link whose image rect contains the point shows the zone without the native type", async () => {
  const w = setup('<a id="a" href="https://example.com/x">Some text <img id="img" src="https://example.com/cat.png"></a>');
  setRect(w.document.getElementById("img"), 0, 0, 50, 50);
  fire(w, w.document.getElementById("a"), "dragstart", { types: ["text/uri-list"], clientX: 5, clientY: 5 });
  await tick();
  assert.ok(hostEl(w));
});

test("a span inside the link as dragstart target still finds the link's image by rect", async () => {
  const w = setup('<a id="a" href="https://example.com/x"><span id="s">words</span> <img id="img" src="https://example.com/cat.png"></a>');
  setRect(w.document.getElementById("img"), 0, 0, 50, 50);
  fire(w, w.document.getElementById("s"), "dragstart", { types: ["text/uri-list"], clientX: 5, clientY: 5 });
  await tick();
  assert.ok(hostEl(w));
});

test("a link whose img has pointer-events:none and sr-only text counts when the point is inside the img rect", async () => {
  const w = setup(
    '<a id="a" href="https://example.com/x"><span style="position:absolute;clip:rect(0,0,0,0)">Profile</span>' +
      '<img id="img" style="pointer-events:none" src="https://example.com/cat.png"></a>',
  );
  setRect(w.document.getElementById("img"), 10, 10, 60, 60);
  w.document.elementsFromPoint = () => [w.document.getElementById("a")];
  fire(w, w.document.getElementById("a"), "dragstart", { types: ["text/uri-list"], clientX: 20, clientY: 20 });
  await tick();
  assert.ok(hostEl(w));
  arm(w);
  fire(w, hostEl(w), "drop");
  assert.equal(messages[0].media.url, "https://example.com/cat.png");
});

test("a draggable non-link card containing an image under the point shows nothing", async () => {
  const w = setup('<div id="card" draggable="true"><img id="img" src="https://example.com/cat.png"></div>');
  setRect(w.document.getElementById("img"), 0, 0, 50, 50);
  w.document.elementsFromPoint = () => [w.document.getElementById("img"), w.document.getElementById("card")];
  fire(w, w.document.getElementById("card"), "dragstart", { types: ["text/plain"], clientX: 5, clientY: 5 });
  await tick();
  assert.equal(hostEl(w), null);
});

test("a link with text and an image whose rect misses the point, no native type, shows nothing", async () => {
  const w = setup('<a id="a" href="https://example.com/x">words <img id="img" src="https://example.com/cat.png"></a>');
  setRect(w.document.getElementById("img"), 100, 100, 150, 150);
  fire(w, w.document.getElementById("a"), "dragstart", { types: ["text/uri-list"], clientX: 5, clientY: 5 });
  await tick();
  assert.equal(hostEl(w), null);
});

test("the image rect must have a positive size", async () => {
  const w = setup('<a id="a" href="https://example.com/x">words <img id="img" src="https://example.com/cat.png"></a>');
  setRect(w.document.getElementById("img"), 5, 5, 5, 5);
  fire(w, w.document.getElementById("a"), "dragstart", { types: ["text/uri-list"], clientX: 5, clientY: 5 });
  await tick();
  assert.equal(hostEl(w), null);
});

test("an image under the point but outside the dragged link shows nothing without the native type", async () => {
  const w = setup('<a id="a" href="https://example.com/x">text</a><img id="img" src="https://example.com/cat.png">');
  w.document.elementsFromPoint = () => [w.document.getElementById("img"), w.document.body];
  fire(w, w.document.getElementById("a"), "dragstart", { types: ["text/uri-list"], clientX: 5, clientY: 5 });
  await tick();
  assert.equal(hostEl(w), null);
});

test("a link that is just one image shows the zone even with nothing under the point", async () => {
  const w = setup('<a id="a" href="https://example.com/x"> <img id="img" src="https://example.com/logo.png"> </a>');
  w.document.elementsFromPoint = () => [];
  fire(w, w.document.getElementById("a"), "dragstart", { types: ["text/uri-list"], clientX: 5, clientY: 5 });
  await tick();
  assert.ok(hostEl(w));
  arm(w);
  fire(w, hostEl(w), "drop");
  assert.equal(messages[0].media.url, "https://example.com/logo.png");
});

test("a link with one image and text shows the zone only with the native type", async () => {
  const html = '<a id="a" href="https://example.com/x">words <img id="img" src="https://example.com/logo.png"></a>';
  let w = setup(html);
  w.document.elementsFromPoint = () => [];
  fire(w, w.document.getElementById("a"), "dragstart", { types: ["text/uri-list"], clientX: 5, clientY: 5 });
  await tick();
  assert.equal(hostEl(w), null);
  w.close();

  w = setup(html);
  w.document.elementsFromPoint = () => [];
  fire(w, w.document.getElementById("a"), "dragstart", { types: [NATIVE_IMAGE], clientX: 5, clientY: 5 });
  await tick();
  assert.ok(hostEl(w));
});

test("a text-less link with two images and nothing under the point shows nothing", async () => {
  const w = setup('<a id="a" href="https://example.com/x"><img src="https://example.com/1.png"><img src="https://example.com/2.png"></a>');
  w.document.elementsFromPoint = () => [];
  fire(w, w.document.getElementById("a"), "dragstart", { types: ["text/uri-list"], clientX: 5, clientY: 5 });
  await tick();
  assert.equal(hostEl(w), null);
});

test("a CSS background image under the point shows nothing without the native type", async () => {
  const w = setup('<a id="a" href="https://example.com/x" style="background-image:url(https://example.com/bg.png)">text</a>');
  w.document.elementsFromPoint = () => [w.document.getElementById("a"), w.document.body];
  fire(w, w.document.getElementById("a"), "dragstart", { types: ["text/uri-list"], clientX: 5, clientY: 5 });
  await tick();
  assert.equal(hostEl(w), null);
});

test("with clientX/clientY both 0, the last trusted mousedown point is used", async () => {
  const w = setup('<a id="a" href="https://example.com/x">text <img id="img" src="https://example.com/cat.png"></a>');
  setRect(w.document.getElementById("img"), 15, 25, 60, 60);
  const drag = (x, y) => fire(w, w.document.getElementById("a"), "dragstart", { types: ["text/uri-list"], clientX: x, clientY: y });
  // An untrusted mousedown inside the image is ignored.
  fire(w, w.document.body, "mousedown", { buttons: 1, clientX: 20, clientY: 30, isTrusted: false });
  drag(0, 0);
  await tick();
  assert.equal(hostEl(w), null, "no usable point");

  fire(w, w.document.body, "mousedown", { buttons: 1, clientX: 20, clientY: 30 });
  drag(0, 0);
  await tick();
  assert.ok(hostEl(w), "mousedown point inside the image");

  // Non-zero coordinates win over the mousedown point.
  w.SynthIDDropZone.hide();
  drag(0, 9);
  await tick();
  assert.equal(hostEl(w), null);
});

test("with clientX/clientY 0 and no mousedown, the point is (0, 0)", async () => {
  const w = setup('<a id="a" href="https://example.com/x">text <img id="img" src="https://example.com/cat.png"></a>');
  const img = w.document.getElementById("img");
  setRect(img, 0, 0, 40, 40);
  fire(w, w.document.getElementById("a"), "dragstart", { types: ["text/uri-list"], clientX: 0, clientY: 0 });
  await tick();
  assert.ok(hostEl(w), "(0, 0) is inside the rect");
  w.SynthIDDropZone.hide();
  setRect(img, 1, 1, 40, 40);
  fire(w, w.document.getElementById("a"), "dragstart", { types: ["text/uri-list"], clientX: 0, clientY: 0 });
  await tick();
  assert.equal(hostEl(w), null);
});
