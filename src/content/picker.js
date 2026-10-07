(function () {
  if (typeof globalThis.SynthIDPicker?.start === "function") return;

  let active = null;

  function start() {
    if (active) return;

    const dark = !!(globalThis.matchMedia && globalThis.matchMedia("(prefers-color-scheme: dark)").matches);
    const accent = dark ? "#8ab4f8" : "#1a73e8";

    const outline = document.createElement("div");
    outline.setAttribute("data-synthid-picker", "outline");
    outline.style.cssText =
      "position:fixed;pointer-events:none;display:none;box-sizing:border-box;margin:0;padding:0;" +
      "z-index:2147483647;border:2px solid " + accent + ";border-radius:2px;" +
      "background:" + (dark ? "rgba(138,180,248,0.18)" : "rgba(26,115,232,0.15)") + ";" +
      "box-shadow:0 0 0 1px " + (dark ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.8)") + ";";

    const hint = document.createElement("div");
    hint.setAttribute("data-synthid-picker", "hint");
    hint.textContent = "Click media to check with SynthID · Esc to cancel";
    hint.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);pointer-events:none;" +
      "z-index:2147483647;padding:8px 16px;border-radius:999px;margin:0;" +
      "font:500 13px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;white-space:nowrap;" +
      "box-shadow:0 2px 8px rgba(0,0,0,0.35);" +
      (dark
        ? "background:#202124;color:#e8eaed;border:1px solid #5f6368;"
        : "background:#fff;color:#202124;border:1px solid #dadce0;");

    const root = document.documentElement;
    root.appendChild(outline);
    root.appendChild(hint);

    function hideOutline() {
      outline.style.display = "none";
    }

    function onMove(e) {
      let hit = null;
      try {
        hit = globalThis.SynthIDResolve.fromPoint(e.clientX, e.clientY);
      } catch (err) {}
      const el = hit && hit.element;
      if (!el) return hideOutline();
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return hideOutline();
      outline.style.display = "block";
      outline.style.left = r.left + "px";
      outline.style.top = r.top + "px";
      outline.style.width = r.width + "px";
      outline.style.height = r.height + "px";
    }

    function swallow(e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }

    // Pages can dispatch synthetic events; only real user input may pick or cancel.
    function onMouseButton(e) {
      if (!e.isTrusted) return;
      swallow(e);
    }

    function onClick(e) {
      if (!e.isTrusted) return;
      swallow(e);
      let media = null;
      try {
        const hit = globalThis.SynthIDResolve.fromPoint(e.clientX, e.clientY);
        if (hit) {
          media = {
            kind: hit.kind,
            url: hit.url,
            isBlob: hit.isBlob,
            isMediaSource: hit.isMediaSource,
          };
        }
      } catch (err) {}
      stop();
      browser.runtime.sendMessage({ type: "synthid:picked", media }).catch(() => {});
    }

    function onKey(e) {
      if (!e.isTrusted) return;
      if (e.key === "Escape") {
        swallow(e);
        stop();
      }
    }

    function stop() {
      if (!active) return;
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouseButton, true);
      window.removeEventListener("mouseup", onMouseButton, true);
      window.removeEventListener("scroll", hideOutline, true);
      outline.remove();
      hint.remove();
      active = null;
    }

    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouseButton, true);
    window.addEventListener("mouseup", onMouseButton, true);
    window.addEventListener("scroll", hideOutline, true);
    active = { stop };
  }

  globalThis.SynthIDPicker = { start };
})();
