(function () {
  if (globalThis.SynthIDResolve) {
    if (typeof module !== "undefined") module.exports = globalThis.SynthIDResolve;
    return;
  }

  const OVERLAY_SELECTOR = "[data-synthid-picker]";
  const SVG_NS = "http://www.w3.org/2000/svg";

  function isOverlay(el) {
    try {
      return !!(el && el.closest && el.closest(OVERLAY_SELECTOR));
    } catch (e) {
      return false;
    }
  }

  function absolutize(raw) {
    if (!raw) return "";
    raw = String(raw).trim();
    if (!raw) return "";
    try {
      return new URL(raw, globalThis.document.baseURI).href;
    } catch (e) {
      return raw;
    }
  }

  function firstSrcsetUrl(srcset) {
    if (!srcset) return "";
    const first = String(srcset).trim().split(/\s*,\s+|,\s*(?=\S+\s+\d)/)[0] || "";
    return first.trim().split(/\s+/)[0] || "";
  }

  function build(el, kind, rawUrl, extra) {
    const url = absolutize(rawUrl);
    if (!url) return null;
    const isBlob = url.startsWith("blob:");
    const isMediaSource =
      isBlob && (kind === "video" || kind === "audio") && !!(extra && extra.hasSrcObject);
    const out = { kind, url, isBlob, isMediaSource };
    Object.defineProperty(out, "element", {
      value: (extra && extra.rectEl) || el,
      enumerable: false,
    });
    return out;
  }

  function fromImg(img) {
    const raw = img.currentSrc || img.src || img.getAttribute("src") || "";
    return build(img, "image", raw);
  }

  function fromAv(el, kind) {
    let raw = el.currentSrc || el.src || el.getAttribute("src") || "";
    if (!raw) {
      const s = el.querySelector("source[src]");
      if (s) raw = s.getAttribute("src");
    }
    return build(el, kind, raw, { hasSrcObject: !!el.srcObject });
  }

  function fromSource(src) {
    const parent = src.parentElement;
    const ptag = parent && parent.localName;
    if (ptag === "picture") {
      const img = parent.querySelector("img");
      if (img) return fromImg(img);
      return build(parent, "image", src.getAttribute("src") || firstSrcsetUrl(src.getAttribute("srcset")));
    }
    if (ptag === "video" || ptag === "audio") {
      const raw = parent.currentSrc || src.getAttribute("src");
      return build(parent, ptag, raw, { hasSrcObject: !!parent.srcObject });
    }
    return null;
  }

  function mediaFromElement(el) {
    if (!el || el.nodeType !== 1 || isOverlay(el)) return null;
    const tag = el.localName;
    if (el.namespaceURI === SVG_NS) {
      if (tag !== "image") return null;
      const raw = el.getAttribute("href") || el.getAttribute("xlink:href");
      return build(el, "image", raw);
    }
    switch (tag) {
      case "img":
        return fromImg(el);
      case "picture": {
        const img = el.querySelector("img");
        if (img) return fromImg(img);
        const s = el.querySelector("source");
        return s ? fromSource(s) : null;
      }
      case "video":
        return fromAv(el, "video");
      case "audio":
        return fromAv(el, "audio");
      case "source":
        return fromSource(el);
      default:
        return null;
    }
  }

  const URL_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*?))\s*\)/i;

  function parseBackgroundUrl(value) {
    if (!value || value === "none") return "";
    const m = URL_RE.exec(value);
    if (!m) return "";
    const raw = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    return (raw || "").replace(/\\(.)/g, "$1").trim();
  }

  function backgroundFrom(el) {
    let node = el;
    for (let i = 0; node && node.nodeType === 1 && i < 4; i++, node = node.parentElement) {
      if (isOverlay(node)) return null;
      let value = "";
      try {
        value = globalThis.getComputedStyle(node).backgroundImage;
      } catch (e) {}
      if (!value && node.style) value = node.style.backgroundImage;
      const raw = parseBackgroundUrl(value);
      if (raw) {
        const hit = build(node, "image", raw);
        if (hit) return hit;
      }
    }
    return null;
  }

  function fromStack(stack, startEl) {
    for (const node of stack) {
      if (isOverlay(node)) continue;
      const hit = mediaFromElement(node);
      if (hit) return hit;
    }
    const first = startEl || stack.find((n) => !isOverlay(n));
    return first ? backgroundFrom(first) : null;
  }

  function stackAt(x, y) {
    const doc = globalThis.document;
    if (!doc || typeof doc.elementsFromPoint !== "function") return [];
    try {
      return doc.elementsFromPoint(x, y) || [];
    } catch (e) {
      return [];
    }
  }

  function fromElement(el) {
    if (!el || isOverlay(el)) return null;
    const direct = mediaFromElement(el);
    if (direct) return direct;
    let stack = [];
    try {
      const r = el.getBoundingClientRect();
      if (r && (r.width > 0 || r.height > 0)) {
        stack = stackAt(r.left + r.width / 2, r.top + r.height / 2);
      }
    } catch (e) {}
    for (const node of stack) {
      if (isOverlay(node)) continue;
      const hit = mediaFromElement(node);
      if (hit) return hit;
    }
    return backgroundFrom(el);
  }

  function fromPoint(x, y) {
    return fromStack(stackAt(x, y), null);
  }

  async function readBlobUrl(url) {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      return { ok: true, blob, type: blob.type };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  const api = { fromElement, fromPoint, readBlobUrl };
  globalThis.SynthIDResolve = api;
  if (typeof module !== "undefined") module.exports = api;
})();
