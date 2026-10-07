const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

let dom;
function setup(html) {
  dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: "https://example.com/dir/page.html",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  return dom.window.document;
}
const R = require("../src/content/resolve.js");

beforeEach(() => setup(""));

test("img uses currentSrc, falling back to src", () => {
  const doc = setup('<img id="a" src="a.png" srcset="b.png 2x"><img id="b" src="c.png">');
  const a = doc.getElementById("a");
  Object.defineProperty(a, "currentSrc", { value: "https://example.com/dir/b.png" });
  assert.deepEqual({ ...R.fromElement(a) }, {
    kind: "image", url: "https://example.com/dir/b.png", isBlob: false, isMediaSource: false,
  });
  assert.equal(R.fromElement(doc.getElementById("b")).url, "https://example.com/dir/c.png");
});

test("element property is non-enumerable", () => {
  const doc = setup('<img id="a" src="a.png">');
  const hit = R.fromElement(doc.getElementById("a"));
  assert.equal(hit.element, doc.getElementById("a"));
  assert.deepEqual(Object.keys(hit), ["kind", "url", "isBlob", "isMediaSource"]);
});

test("picture and source resolve to the img", () => {
  const doc = setup('<picture id="p"><source id="s" srcset="x.webp 1x"><img src="/y.jpg"></picture>');
  assert.equal(R.fromElement(doc.getElementById("p")).url, "https://example.com/y.jpg");
  assert.equal(R.fromElement(doc.getElementById("s")).url, "https://example.com/y.jpg");
});

test("picture without img uses source", () => {
  const doc = setup('<picture id="p"><source srcset="x.webp 1x, x2.webp 2x"></picture>');
  assert.equal(R.fromElement(doc.getElementById("p")).url, "https://example.com/dir/x.webp");
});

test("video with source child; poster ignored", () => {
  const doc = setup('<video id="v" poster="p.jpg"><source src="m.mp4" type="video/mp4"></video><video id="w" poster="p.jpg"></video>');
  const hit = R.fromElement(doc.getElementById("v"));
  assert.equal(hit.kind, "video");
  assert.equal(hit.url, "https://example.com/dir/m.mp4");
  assert.equal(R.fromElement(doc.getElementById("w")), null);
});

test("audio and blob/mediasource flags", () => {
  const doc = setup('<audio id="a" src="s.mp3"></audio><video id="v" src="blob:https://example.com/abc"></video>');
  assert.equal(R.fromElement(doc.getElementById("a")).kind, "audio");
  const v = doc.getElementById("v");
  assert.equal(R.fromElement(v).isBlob, true);
  assert.equal(R.fromElement(v).isMediaSource, false);
  Object.defineProperty(v, "srcObject", { value: {} });
  assert.equal(R.fromElement(v).isMediaSource, true);
});

test("svg image href", () => {
  const doc = setup('<svg xmlns="http://www.w3.org/2000/svg"><image id="i" href="v.png"/></svg>');
  assert.equal(R.fromElement(doc.getElementById("i")).url, "https://example.com/dir/v.png");
});

test("background-image on ancestor, quoted and relative", () => {
  const doc = setup('<div style="background-image:url(\'bg.jpg\')"><div><span id="t">x</span></div></div>');
  const hit = R.fromElement(doc.getElementById("t"));
  assert.equal(hit.url, "https://example.com/dir/bg.jpg");
  assert.equal(hit.kind, "image");
});

test("gradient-only background and plain div return null", () => {
  const doc = setup('<div id="g" style="background-image:linear-gradient(red, blue)"></div><div id="n" style="background-image:none"></div><div id="d"></div>');
  assert.equal(R.fromElement(doc.getElementById("g")), null);
  assert.equal(R.fromElement(doc.getElementById("n")), null);
  assert.equal(R.fromElement(doc.getElementById("d")), null);
});

test("overlay div above an img resolves via elementsFromPoint", () => {
  const doc = setup('<img id="i" src="a.png"><div id="o"></div>');
  const img = doc.getElementById("i");
  const o = doc.getElementById("o");
  o.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 50 });
  let seen;
  doc.elementsFromPoint = (x, y) => { seen = [x, y]; return [o, img, doc.body]; };
  assert.equal(R.fromElement(o).url, "https://example.com/dir/a.png");
  assert.deepEqual(seen, [60, 45]);
});

test("fromPoint skips picker overlay", () => {
  const doc = setup('<img id="i" src="a.png"><div id="o" data-synthid-picker="outline"></div>');
  doc.elementsFromPoint = () => [doc.getElementById("o"), doc.getElementById("i")];
  assert.equal(R.fromPoint(1, 1).url, "https://example.com/dir/a.png");
  assert.equal(R.fromElement(doc.getElementById("o")), null);
});

test("readBlobUrl reports failure", async () => {
  const res = await R.readBlobUrl("blob:https://example.com/none");
  assert.equal(res.ok, false);
  assert.equal(typeof res.error, "string");
});
