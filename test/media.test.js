"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Media = require("../src/lib/media.js");

test("exposes the global and constants", () => {
  assert.equal(globalThis.SynthIDMedia, Media);
  assert.equal(Media.MAX_BYTES, 200 * 1024 * 1024);
  assert.ok(Media.ACCEPTED_EXTENSIONS.includes("heic"));
  assert.equal(Media.MIME_TO_EXTENSION["image/jpeg"], "jpg");
  assert.equal(Media.MIME_TO_EXTENSION["audio/mpeg"], "mp3");
  assert.equal(Media.MIME_TO_EXTENSION["video/quicktime"], "mov");
  for (const ext of Object.values(Media.MIME_TO_EXTENSION)) {
    assert.ok(Media.ACCEPTED_EXTENSIONS.includes(ext), ext);
  }
});

test("extensionFromUrl ignores query and hash", () => {
  assert.equal(Media.extensionFromUrl("https://a.example/img/photo.JPG"), "jpg");
  assert.equal(Media.extensionFromUrl("https://a.example/photo.png?w=200&fmt=webp"), "png");
  assert.equal(Media.extensionFromUrl("https://a.example/clip.mp4#t=10"), "mp4");
  assert.equal(Media.extensionFromUrl("https://a.example/a.b/song.mp3?x=1#y"), "mp3");
  assert.equal(Media.extensionFromUrl("https://a.example/dir.v2/"), "");
  assert.equal(Media.extensionFromUrl("https://a.example/image"), "");
  assert.equal(Media.extensionFromUrl("https://a.example/?file=x.png"), "");
  assert.equal(Media.extensionFromUrl("https://a.example/my%20pic.webp"), "webp");
  assert.equal(Media.extensionFromUrl("blob:https://a.example/123e4567-e89b"), "");
  assert.equal(Media.extensionFromUrl(""), "");
  assert.equal(Media.extensionFromUrl(undefined), "");
});

test("extensionFromUrl uses the MIME for data: URLs", () => {
  assert.equal(Media.extensionFromUrl("data:image/png;base64,iVBORw0KGgo="), "png");
  assert.equal(Media.extensionFromUrl("data:image/jpg;base64,AAAA"), "jpg");
  assert.equal(Media.extensionFromUrl("data:audio/mpeg,abc"), "mp3");
  assert.equal(Media.extensionFromUrl("data:image/svg+xml,<svg/>"), "");
  assert.equal(Media.extensionFromUrl("data:,hello"), "");
});

test("isAcceptedType: accepted MIME types and aliases", () => {
  for (const mime of [
    "image/jpeg", "image/jpg", "image/pjpeg", "IMAGE/PNG", "image/webp; q=1", "image/avif",
    "image/heic", "image/heif", "image/tiff", "image/bmp", "image/gif",
    "audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/flac", "audio/aac", "audio/mp4",
    "video/mp4", "video/quicktime", "video/webm",
  ]) {
    assert.equal(Media.isAcceptedType(mime, ""), true, mime);
  }
});

test("isAcceptedType: falls back to the file name", () => {
  assert.equal(Media.isAcceptedType("application/octet-stream", "photo.jpeg"), true);
  assert.equal(Media.isAcceptedType("", "clip.MOV"), true);
  assert.equal(Media.isAcceptedType(undefined, "song.m4a"), true);
  assert.equal(Media.isAcceptedType("binary/octet-stream", "scan.tif"), true);
});

test("isAcceptedType: rejects other types", () => {
  assert.equal(Media.isAcceptedType("image/svg+xml", "logo.svg"), false);
  assert.equal(Media.isAcceptedType("video/x-matroska", "movie.mkv"), false);
  assert.equal(Media.isAcceptedType("application/pdf", "doc.pdf"), false);
  assert.equal(Media.isAcceptedType("", ""), false);
  assert.equal(Media.isAcceptedType("application/octet-stream", "file"), false);
  assert.equal(Media.isAcceptedType("image/x-icon", "favicon.ico"), false);
  // An HTML page (e.g. a login redirect) is never media, even with a .jpg name.
  assert.equal(Media.isAcceptedType("text/html; charset=utf-8", "photo.jpg"), false);
  assert.equal(Media.isAcceptedType("application/json", "photo.jpg"), false);
});

test("fileNameFor: uses the URL's name and the MIME's extension", () => {
  assert.equal(Media.fileNameFor("https://cdn.example/a/photo.jpg?w=1", "image/jpeg"), "photo.jpg");
  assert.equal(Media.fileNameFor("https://cdn.example/photo.jpeg", "image/jpeg"), "photo.jpeg");
  assert.equal(Media.fileNameFor("https://cdn.example/photo.jpg", "image/webp"), "photo.webp");
  assert.equal(Media.fileNameFor("https://cdn.example/photo", "image/png"), "photo.png");
  assert.equal(Media.fileNameFor("https://cdn.example/clip.mov", "application/octet-stream"), "clip.mov");
  assert.equal(Media.fileNameFor("https://cdn.example/my%20cat.png", "image/png"), "my cat.png");
});

test("fileNameFor: default base name for data:, blob: and empty paths", () => {
  assert.equal(Media.fileNameFor("data:image/png;base64,AAAA", "image/png"), "synthid-check.png");
  assert.equal(Media.fileNameFor("blob:https://x.example/1234-5678", "video/mp4"), "synthid-check.mp4");
  assert.equal(Media.fileNameFor("https://x.example/", "audio/mpeg"), "synthid-check.mp3");
  assert.equal(Media.fileNameFor("", "image/gif"), "synthid-check.gif");
  assert.equal(Media.fileNameFor("https://x.example/", ""), "synthid-check");
});

test("fileNameFor: sanitizes and limits length", () => {
  const evil = Media.fileNameFor("https://x.example/..%2F..%2Fetc%2Fpasswd.png", "image/png");
  assert.ok(!/[\\/]/.test(evil), evil);
  assert.ok(evil.endsWith(".png"));
  assert.ok(!evil.startsWith("."));

  const weird = Media.fileNameFor('https://x.example/a%3Ab%2Ac%3F%22%3C%3E%7C%5Cd.jpg', "image/jpeg");
  assert.ok(!/[\\/:*?"<>|]/.test(weird), weird);
  assert.ok(weird.endsWith(".jpg"));

  const ctrl = Media.fileNameFor("https://x.example/a%00b%0Ac.gif", "image/gif");
  assert.ok(!/[\u0000-\u001f]/.test(ctrl), JSON.stringify(ctrl));

  const long = Media.fileNameFor(`https://x.example/${"a".repeat(300)}.webp`, "image/webp");
  assert.ok(long.length <= 100, String(long.length));
  assert.ok(long.endsWith(".webp"));

  assert.equal(Media.fileNameFor("https://x.example/....png", "image/png"), "synthid-check.png");
});

test("dataUrlToBlob: base64 and percent-encoded", async () => {
  const b64 = Media.dataUrlToBlob("data:image/png;base64,iVBORw0KGgo=");
  assert.ok(b64 instanceof Blob);
  assert.equal(b64.type, "image/png");
  assert.deepEqual(
    [...new Uint8Array(await b64.arrayBuffer())],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );

  const alias = Media.dataUrlToBlob("data:image/jpg;base64,/9j/");
  assert.equal(alias.type, "image/jpeg");

  const text = Media.dataUrlToBlob("data:text/plain;charset=utf-8,a%20b%FF");
  assert.equal(text.type, "text/plain");
  assert.deepEqual([...new Uint8Array(await text.arrayBuffer())], [0x61, 0x20, 0x62, 0xff]);

  const bare = Media.dataUrlToBlob("data:,hi");
  assert.equal(bare.type, "text/plain");
  assert.equal(await bare.text(), "hi");
});

test("dataUrlToBlob: throws on malformed input", () => {
  assert.throws(() => Media.dataUrlToBlob("https://x.example/a.png"));
  assert.throws(() => Media.dataUrlToBlob("data:image/png;base64"));
  assert.throws(() => Media.dataUrlToBlob("data:image/png;base64,@@@"));
  assert.throws(() => Media.dataUrlToBlob(null));
});

test("originPattern", () => {
  assert.equal(Media.originPattern("https://cdn.example.com/a/b.jpg?x=1"), "https://cdn.example.com/*");
  assert.equal(Media.originPattern("http://example.com:8080/x.png"), "http://example.com/*");
  assert.equal(Media.originPattern("HTTPS://Example.COM/x"), "https://example.com/*");
  assert.equal(Media.originPattern("data:image/png;base64,AAAA"), null);
  assert.equal(Media.originPattern("blob:https://example.com/123"), null);
  assert.equal(Media.originPattern("ftp://example.com/a.png"), null);
  assert.equal(Media.originPattern("not a url"), null);
});

test("mimeForExtension and extensionForMime", () => {
  assert.equal(Media.mimeForExtension("JPG"), "image/jpeg");
  assert.equal(Media.mimeForExtension("mov"), "video/quicktime");
  assert.equal(Media.mimeForExtension("svg"), "");
  assert.equal(Media.extensionForMime("image/pjpeg"), "jpg");
  assert.equal(Media.extensionForMime("text/html"), "");
});
