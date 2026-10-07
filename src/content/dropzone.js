/* Drop zone: while an image is dragged, show a box in the corner; dropping the image on it starts a check.
 *
 * Registered as a content script for every page and frame (scripting.registerContentScripts) while the
 * "drop zone" setting is on. The zone is shown in the frame where the drag started: Firefox doesn't let
 * a cross-origin frame drop into its parent, so a zone in the top frame couldn't receive those drops.
 *
 * All listeners sit on window in the capture phase and are added at document_start, so they run before
 * the page's own window listeners and a page can't swallow drops meant for the zone.
 */
(function () {
  "use strict";
  if (typeof globalThis.SynthIDDropZone?.hide === "function") return;

  const NATIVE_IMAGE = "application/x-moz-nativeimage";
  // Smaller frames (ads, embeds) have no room for the zone.
  const MIN_FRAME_WIDTH = 240;
  const MIN_FRAME_HEIGHT = 160;

  const CSS = `
    :host {
      all: initial !important;
      position: fixed !important; inset: auto 16px 16px auto !important; z-index: 2147483647 !important;
      display: block !important; box-sizing: border-box !important;
      width: min(240px, calc(100vw - 32px)) !important; height: 132px !important;
      margin: 0 !important; padding: 0 !important; overflow: visible !important;
      border: 0 !important; background: transparent !important; color: inherit !important;
    }
    .zone {
      --bg: rgba(255, 255, 255, 0.72); --fg: #1b1b1f; --accent: #1a73e8; --hover-bg: rgba(232, 240, 254, 0.92);
      box-sizing: border-box; width: 100%; height: 100%;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
      padding: 12px; border-radius: 14px; border: 2px dashed var(--accent);
      background: var(--bg); color: var(--fg);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
      font: 500 14px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      text-align: center; letter-spacing: normal;
      opacity: 0.85;
      transition: opacity 120ms ease, transform 120ms ease, background-color 120ms ease;
    }
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
  let showTimer = null;

  function ensure() {
    if (host && zone) return;
    host = document.createElement("synthid-check-dropzone");
    // resolve.js skips [data-synthid-picker] elements, so the zone is never taken for page media.
    host.setAttribute("data-synthid-picker", "dropzone");
    const root = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = CSS;

    zone = document.createElement("div");
    zone.className = "zone";
    zone.setAttribute("role", "region");
    zone.setAttribute("aria-label", "Drop here to check with SynthID");

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

    const label = document.createElement("div");
    label.textContent = "Drop here to check with SynthID";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Opens synthid.com in a new tab";

    zone.append(icon, label, hint);
    root.append(style, zone);
  }

  function isZone(target) {
    return host !== null && target === host;
  }

  function show() {
    ensure();
    zone.classList.remove("over");
    if (!host.isConnected) (document.documentElement || document.body).appendChild(host);
    // The top layer keeps the zone above the page's own modal dialogs and fullscreen elements.
    try {
      if (!host.hasAttribute("popover")) host.setAttribute("popover", "manual");
      if (!host.matches(":popover-open")) host.showPopover();
    } catch (e) {
      // No popover support: z-index alone has to do.
    }
  }

  function hide() {
    clearTimeout(showTimer);
    showTimer = null;
    dragged = null;
    if (!host) return;
    try {
      if (host.matches(":popover-open")) host.hidePopover();
    } catch (e) {}
    host.remove();
  }

  // The image under a drag, or null when something else (text, a plain link) is dragged.
  function mediaForDrag(e) {
    const resolve = globalThis.SynthIDResolve;
    if (typeof resolve?.fromElement !== "function") return null;
    const target = e.target;
    let hit = null;
    try {
      const tag = target && target.nodeType === 1 ? target.localName : "";
      if (tag === "img" || tag === "picture" || tag === "image") {
        hit = resolve.fromElement(target);
      } else {
        // An image inside a link drags as the link; Firefox marks image drags with this type.
        const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
        if (types.includes(NATIVE_IMAGE)) hit = resolve.fromPoint(e.clientX, e.clientY);
      }
    } catch (err) {
      return null;
    }
    if (!hit || hit.kind !== "image" || !hit.url) return null;
    return { kind: hit.kind, url: hit.url, isBlob: hit.isBlob, isMediaSource: hit.isMediaSource };
  }

  function frameHasRoom() {
    const w = globalThis.innerWidth;
    const h = globalThis.innerHeight;
    if (!Number.isFinite(w) || !Number.isFinite(h)) return true;
    return w >= MIN_FRAME_WIDTH && h >= MIN_FRAME_HEIGHT;
  }

  function onDragStart(e) {
    // Pages can dispatch synthetic drag events; only a real drag may show the zone.
    if (!e.isTrusted) return;
    hide();
    const media = mediaForDrag(e);
    if (!media || !frameHasRoom()) return;
    // Show after the page's own dragstart handlers ran: if one cancelled the drag, no drag
    // (and no dragend to hide the zone) follows.
    showTimer = setTimeout(() => {
      showTimer = null;
      if (e.defaultPrevented) return;
      dragged = media;
      show();
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

  function acceptDrag(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.dataTransfer) {
      try {
        e.dataTransfer.dropEffect = dropEffectFor(e.dataTransfer);
      } catch (err) {}
    }
  }

  function onDragEnterOrOver(e) {
    if (!dragged || !e.isTrusted) return;
    const over = isZone(e.target);
    zone.classList.toggle("over", over);
    if (over) acceptDrag(e);
  }

  function onDragLeave(e) {
    if (!dragged || !e.isTrusted) return;
    if (isZone(e.target)) zone.classList.remove("over");
  }

  function onDrop(e) {
    if (!dragged || !e.isTrusted) return;
    if (!isZone(e.target)) {
      // Dropped somewhere on the page: the drag is over.
      hide();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    const media = dragged;
    hide();
    browser.runtime.sendMessage({ type: "synthid:dropped", media }).catch(() => {});
  }

  function onDragEnd(e) {
    if (!e.isTrusted) return;
    hide();
  }

  // dragend goes to the drag source, so a page that removed it from the document mid-drag hides
  // dragend from us. No mouse events reach the page during a drag; a move with no button down
  // means it's over.
  function onMouseMove(e) {
    if (!dragged || !e.isTrusted || e.buttons !== 0) return;
    hide();
  }

  window.addEventListener("dragstart", onDragStart, true);
  window.addEventListener("dragenter", onDragEnterOrOver, true);
  window.addEventListener("dragover", onDragEnterOrOver, true);
  window.addEventListener("dragleave", onDragLeave, true);
  window.addEventListener("drop", onDrop, true);
  window.addEventListener("dragend", onDragEnd, true);
  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("pagehide", hide, true);

  globalThis.SynthIDDropZone = { hide };
})();
