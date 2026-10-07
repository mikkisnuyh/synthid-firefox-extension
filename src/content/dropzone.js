/* Drop zone: while an image is dragged, show a box in the corner; dropping the image on it starts a check.
 *
 * Registered as a content script for every page and frame (scripting.registerContentScripts) while the
 * "drop zone" setting is on. The zone is shown in the frame where the drag started: Firefox doesn't let
 * a cross-origin frame drop into its parent, so a zone in the top frame couldn't receive those drops.
 * In a frame, it goes in the corner of the part of the frame that is on screen.
 *
 * All listeners sit on window in the capture phase and are added at document_start, so they run before
 * the page's own window listeners and a page can't swallow drops meant for the zone.
 */
(function () {
  "use strict";
  if (typeof globalThis.SynthIDDropZone?.hide === "function") return;

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const NATIVE_IMAGE = "application/x-moz-nativeimage";
  const CHECKABLE_URL = /^(https?|data|blob):/i;
  const IMAGE_TAGS = ["img", "picture", "image"];
  const CORNERS = ["top-right", "bottom-right", "top-left", "bottom-left"];
  const DEFAULT_CORNER = "top-right";
  const ZONE_WIDTH = 240;
  const ZONE_HEIGHT = 132;
  const MARGIN = 16;
  // Smaller visible areas (ads, embeds) have no room for the zone.
  const MIN_WIDTH = 240;
  const MIN_HEIGHT = 160;

  // The zone itself is the popover, inside the closed shadow root, so page styles (a bare
  // ::backdrop rule, [popover] selectors) and popover events can't reach it.
  const CSS = `
    :host { all: initial !important; display: block !important; }
    .zone {
      --bg: rgba(255, 255, 255, 0.72); --fg: #1b1b1f; --accent: #1a73e8; --hover-bg: rgba(232, 240, 254, 0.92);
      position: fixed; inset: auto; margin: 0; z-index: 2147483647;
      box-sizing: border-box; width: ${ZONE_WIDTH}px; height: ${ZONE_HEIGHT}px; overflow: visible;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
      padding: 12px; border-radius: 14px; border: 2px dashed var(--accent);
      background: var(--bg); color: var(--fg);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
      font: 500 14px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      text-align: center; letter-spacing: normal;
      opacity: 0.85;
      transition: opacity 120ms ease, transform 120ms ease, background-color 120ms ease;
    }
    .zone::backdrop { background: transparent; }
    .zone.over { opacity: 1; border-style: solid; background: var(--hover-bg); transform: scale(1.03); }
    .zone * { pointer-events: none; }
    .icon { width: 28px; height: 28px; color: var(--accent); }
    .hint { font-size: 12px; font-weight: 400; opacity: 0.8; }
    @media (prefers-color-scheme: dark) {
      .zone {
        --bg: rgba(38, 39, 43, 0.72); --fg: #f1f2f5; --accent: #8ab4f8; --hover-bg: rgba(40, 52, 74, 0.94);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .zone { transition: none; }
      .zone.over { transform: none; }
    }
  `;

  let host = null;
  let zone = null;
  // The media being dragged while the zone is shown, else null.
  let dragged = null;
  // A drop counts only after the pointer entered the zone from elsewhere on the page,
  // so releasing a drag in place can't start a check.
  let armed = false;
  // Bumped by every dragstart and hide, so a stale deferred show does nothing.
  let generation = 0;
  let showTimer = null;
  let probe = null;
  // Where the last trusted mousedown was: a drag starts there.
  let downPoint = null;
  // The corner setting, read once and dropped when it changes.
  let cornerSetting = null;

  function getCorner() {
    if (!cornerSetting) {
      try {
        cornerSetting = browser.storage.sync.get({ dropZoneCorner: DEFAULT_CORNER }).then(
          (s) => (CORNERS.includes(s.dropZoneCorner) ? s.dropZoneCorner : DEFAULT_CORNER),
          () => DEFAULT_CORNER,
        );
      } catch (e) {
        cornerSetting = Promise.resolve(DEFAULT_CORNER);
      }
    }
    return cornerSetting;
  }

  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes && "dropZoneCorner" in changes) cornerSetting = null;
    });
  } catch (e) {}

  function ensure() {
    if (host && zone) return true;
    try {
      // A plain div: pages can't define it as a custom element and reach the closed shadow root.
      const h = document.createElementNS(HTML_NS, "div");
      // resolve.js skips [data-synthid-picker] elements, so the zone is never taken for page media.
      h.setAttribute("data-synthid-picker", "dropzone");
      const root = h.attachShadow({ mode: "closed" });

      const style = document.createElementNS(HTML_NS, "style");
      style.textContent = CSS;

      const z = document.createElementNS(HTML_NS, "div");
      z.className = "zone";
      z.setAttribute("popover", "manual");
      z.setAttribute("role", "region");
      z.setAttribute("aria-label", "Drop here to check with SynthID");

      const svgNs = "http://www.w3.org/2000/svg";
      const icon = document.createElementNS(svgNs, "svg");
      icon.setAttribute("class", "icon");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(svgNs, "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("d", "M12 4v11m0 0-4-4m4 4 4-4M5 19h14");
      icon.appendChild(path);

      const label = document.createElementNS(HTML_NS, "div");
      label.textContent = "Drop here to check with SynthID";
      const hint = document.createElementNS(HTML_NS, "div");
      hint.className = "hint";
      hint.textContent = "Opens synthid.com in a new tab";

      z.append(icon, label, hint);
      root.append(style, z);
      host = h;
      zone = z;
      return true;
    } catch (e) {
      return false;
    }
  }

  function isZone(target) {
    return host !== null && target === host;
  }

  // Everything outside an open modal dialog is inert, so the zone has to live inside it.
  function container() {
    try {
      const modals = document.querySelectorAll("dialog:modal");
      if (modals.length) return modals[modals.length - 1];
    } catch (e) {}
    return document.documentElement || document.body;
  }

  function isTopFrame() {
    try {
      return window === window.top;
    } catch (e) {
      return false;
    }
  }

  function viewport() {
    const w = globalThis.innerWidth;
    const h = globalThis.innerHeight;
    return { left: 0, top: 0, right: Number.isFinite(w) ? w : 0, bottom: Number.isFinite(h) ? h : 0 };
  }

  function roomy(area) {
    return area && area.right - area.left >= MIN_WIDTH && area.bottom - area.top >= MIN_HEIGHT ? area : null;
  }

  function removeProbe() {
    if (!probe) return;
    probe.observer.disconnect();
    probe.el.remove();
    probe = null;
  }

  // The part of this frame's viewport that is on screen, or null if too small. A frame sized to its
  // content (embeds, webmail) can reach far below the visible page; its own corner may be off screen.
  function visibleArea(callback) {
    const vp = viewport();
    if (isTopFrame() || typeof globalThis.IntersectionObserver !== "function") {
      callback(roomy(vp));
      return;
    }
    try {
      const el = document.createElementNS(HTML_NS, "div");
      el.setAttribute("data-synthid-picker", "probe");
      el.style.cssText =
        "all:initial !important;position:fixed !important;inset:0 !important;" +
        "opacity:0 !important;pointer-events:none !important;";
      const observer = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        removeProbe();
        if (!entry || !entry.isIntersecting) return callback(null);
        const r = entry.intersectionRect;
        callback(
          roomy({
            left: Math.max(r.left, vp.left),
            top: Math.max(r.top, vp.top),
            right: Math.min(r.right, vp.right),
            bottom: Math.min(r.bottom, vp.bottom),
          }),
        );
      });
      probe = { el, observer };
      (document.documentElement || document.body).appendChild(el);
      observer.observe(el);
    } catch (e) {
      removeProbe();
      callback(roomy(vp));
    }
  }

  // The zone's box in the given corner of the area, in viewport coordinates.
  function boxIn(area, corner) {
    const width = Math.min(ZONE_WIDTH, area.right - area.left - 2 * MARGIN);
    const left = corner.endsWith("left") ? area.left + MARGIN : area.right - MARGIN - width;
    const top = corner.startsWith("top") ? area.top + MARGIN : area.bottom - MARGIN - ZONE_HEIGHT;
    return { left, top, width };
  }

  // The chosen corner of the area, or the other corner on the same side when the drag
  // started where the zone would appear.
  function place(area, point, corner) {
    let box = boxIn(area, corner);
    const underPointer =
      point &&
      point.x >= box.left &&
      point.x <= box.left + box.width &&
      point.y >= box.top &&
      point.y <= box.top + ZONE_HEIGHT;
    if (underPointer) {
      const side = corner.endsWith("left") ? "left" : "right";
      box = boxIn(area, (corner.startsWith("top") ? "bottom-" : "top-") + side);
    }
    const s = zone.style;
    s.width = box.width + "px";
    s.left = box.left + "px";
    s.top = box.top + "px";
    s.right = "auto";
    s.bottom = "auto";
  }

  function show(area, point, corner) {
    if (!ensure()) return false;
    try {
      zone.classList.remove("over");
      place(area, point, corner);
      const parent = container();
      if (host.parentNode !== parent) parent.appendChild(host);
      // The top layer keeps the zone above the page's own dialogs and fullscreen elements.
      try {
        if (!zone.matches(":popover-open")) zone.showPopover();
      } catch (e) {
        // No popover support: z-index alone has to do.
      }
      return true;
    } catch (e) {
      if (host) host.remove();
      return false;
    }
  }

  function hide() {
    generation++;
    clearTimeout(showTimer);
    showTimer = null;
    removeProbe();
    dragged = null;
    armed = false;
    if (!host) return;
    try {
      if (zone.matches(":popover-open")) zone.hidePopover();
    } catch (e) {}
    host.remove();
  }

  function isImageElement(el) {
    return !!(el && el.nodeType === 1 && IMAGE_TAGS.includes(el.localName));
  }

  // Where the drag started. Falls back to the mousedown point in case the event has no coordinates.
  function dragPoint(e) {
    if (e.clientX || e.clientY || !downPoint) return { x: e.clientX, y: e.clientY };
    return downPoint;
  }

  // An image dragged by a link (or another draggable element) around it. The link is the
  // dragstart target then, not the image.
  function imageInside(target, e, point) {
    const resolve = globalThis.SynthIDResolve;
    const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
    // Firefox marks image drags with this type; then whatever is under the pointer is the image.
    const markedImage = types.includes(NATIVE_IMAGE);
    const under = resolve.fromPoint(point.x, point.y);
    if (under && (markedImage || (isImageElement(under.element) && target.contains(under.element)))) return under;
    // A link that is just an image (a logo, an avatar), in case the type isn't exposed.
    if (markedImage || !(target.textContent || "").trim()) {
      const imgs = target.querySelectorAll("img");
      if (imgs.length === 1) return resolve.fromElement(imgs[0]);
    }
    return null;
  }

  // The image under a drag, or null when something else (text, a plain link) is dragged.
  function mediaForDrag(e, point) {
    const resolve = globalThis.SynthIDResolve;
    if (typeof resolve?.fromElement !== "function") return null;
    let hit = null;
    try {
      // composedPath reaches an image inside the page's own (open) shadow roots.
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      const target = path[0] && path[0].nodeType === 1 ? path[0] : e.target;
      if (!target || target.nodeType !== 1) return null;
      hit = isImageElement(target) ? resolve.fromElement(target) : imageInside(target, e, point);
    } catch (err) {
      return null;
    }
    if (!hit || hit.kind !== "image" || !hit.url || !CHECKABLE_URL.test(hit.url)) return null;
    return { kind: hit.kind, url: hit.url, isBlob: hit.isBlob, isMediaSource: hit.isMediaSource };
  }

  function onDragStart(e) {
    // Pages can dispatch synthetic drag events; only a real drag may show the zone.
    if (!e.isTrusted) return;
    hide();
    const point = dragPoint(e);
    const media = mediaForDrag(e, point);
    if (!media) return;
    const gen = generation;
    // Show after the page's own dragstart handlers ran: if one cancelled the drag, no drag
    // (and no dragend to hide the zone) follows.
    showTimer = setTimeout(() => {
      showTimer = null;
      if (gen !== generation || e.defaultPrevented) return;
      getCorner().then((corner) => {
        if (gen !== generation) return;
        visibleArea((area) => {
          if (gen !== generation || !area) return;
          if (show(area, point, corner)) dragged = media;
        });
      });
    }, 0);
  }

  // The drop effect the zone accepts, within what the drag source allows.
  function dropEffectFor(dt) {
    const allowed = (dt && dt.effectAllowed) || "all";
    if (allowed === "none") return "none";
    if (allowed === "all" || allowed === "uninitialized" || /copy/i.test(allowed)) return "copy";
    if (/link/i.test(allowed)) return "link";
    return "move";
  }

  function onDragEnterOrOver(e) {
    if (!dragged || !zone || !e.isTrusted) return;
    const over = isZone(e.target);
    if (!over) armed = true;
    zone.classList.toggle("over", over && armed);
    if (!over || !armed) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.dataTransfer) {
      try {
        e.dataTransfer.dropEffect = dropEffectFor(e.dataTransfer);
      } catch (err) {}
    }
  }

  function onDragLeave(e) {
    if (!dragged || !zone || !e.isTrusted) return;
    if (isZone(e.target)) zone.classList.remove("over");
  }

  function onDrop(e) {
    if (!dragged || !e.isTrusted) return;
    if (!isZone(e.target)) {
      // Dropped somewhere on the page: the drag is over.
      hide();
      return;
    }
    // The page never sees drops on the zone, counted or not.
    e.preventDefault();
    e.stopImmediatePropagation();
    const media = armed ? dragged : null;
    hide();
    if (media) browser.runtime.sendMessage({ type: "synthid:dropped", media }).catch(() => {});
  }

  function onDragEndOrPageHide(e) {
    if (!e.isTrusted) return;
    hide();
  }

  // dragend goes to the drag source, so a page that removed it from the document mid-drag hides
  // dragend from us. No mouse events reach the page during a drag; a release or a move with no
  // button down means it's over.
  function onMouse(e) {
    if (!e.isTrusted) return;
    if (e.type === "mousedown") {
      downPoint = { x: e.clientX, y: e.clientY };
      return;
    }
    if (!dragged) return;
    if (e.type === "mouseup" || e.buttons === 0) hide();
  }

  window.addEventListener("dragstart", onDragStart, true);
  window.addEventListener("dragenter", onDragEnterOrOver, true);
  window.addEventListener("dragover", onDragEnterOrOver, true);
  window.addEventListener("dragleave", onDragLeave, true);
  window.addEventListener("drop", onDrop, true);
  window.addEventListener("dragend", onDragEndOrPageHide, true);
  window.addEventListener("mousedown", onMouse, true);
  window.addEventListener("mousemove", onMouse, true);
  window.addEventListener("mouseup", onMouse, true);
  window.addEventListener("pagehide", onDragEndOrPageHide, true);

  globalThis.SynthIDDropZone = { hide };
})();
