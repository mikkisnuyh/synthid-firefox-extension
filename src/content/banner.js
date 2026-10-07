/* Shadow-DOM banner shared by the synthid.com content script and on-demand notices. */
(function () {
  "use strict";
  // Type check: a page element named "SynthIDBanner" (window named property) is not a banner.
  if (typeof globalThis.SynthIDBanner?.show === "function") return;

  const STATES = ["info", "working", "warn", "error", "success"];
  const CSS = `
    :host { all: initial; }
    .box {
      --bg: #ffffff; --fg: #1b1b1f; --muted: #55565c; --border: #d5d7de;
      --btn-bg: #eef0f4; --btn-fg: #1b1b1f; --accent: #1a73e8; --accent-fg: #ffffff;
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      box-sizing: border-box; width: calc(100vw - 32px); max-width: 360px;
      padding: 12px 14px 12px 16px; border-radius: 10px;
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--border); border-left: 5px solid var(--accent);
      box-shadow: 0 6px 24px rgba(0,0,0,.28);
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      text-align: left; letter-spacing: normal;
    }
    .box[hidden] { display: none; }
    .box[data-state="info"] { --accent: #1a73e8; }
    .box[data-state="working"] { --accent: #6b5bd2; }
    .box[data-state="warn"] { --accent: #d98200; }
    .box[data-state="error"] { --accent: #d93025; }
    .box[data-state="success"] { --accent: #1e8e3e; }
    @media (prefers-color-scheme: dark) {
      .box {
        --bg: #26272b; --fg: #f1f2f5; --muted: #b4b6bd; --border: #44464d;
        --btn-bg: #3a3c43; --btn-fg: #f1f2f5;
        box-shadow: 0 6px 24px rgba(0,0,0,.6);
      }
      .box[data-state="info"] { --accent: #8ab4f8; }
      .box[data-state="working"] { --accent: #b3a8ff; }
      .box[data-state="warn"] { --accent: #fdb44b; }
      .box[data-state="error"] { --accent: #f28b82; }
      .box[data-state="success"] { --accent: #81c995; }
      .primary { --accent-fg: #14151a; }
    }
    .title { margin: 0 24px 4px 0; font-weight: 600; font-size: 14px; color: var(--accent); }
    .title:empty { display: none; }
    .msg { margin: 0; color: var(--fg); overflow-wrap: anywhere; }
    .msg:empty { display: none; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .actions:empty { display: none; }
    button {
      font: inherit; font-size: 13px; cursor: pointer; border-radius: 6px;
      padding: 5px 12px; border: 1px solid var(--border);
      background: var(--btn-bg); color: var(--btn-fg);
    }
    button:hover { filter: brightness(0.95); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
    .close {
      position: absolute; top: 4px; right: 6px; width: 26px; height: 26px; padding: 0;
      border: 0; background: transparent; color: var(--muted); font-size: 18px; line-height: 1;
    }
    .close:hover { color: var(--fg); filter: none; }
    .spin {
      display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px;
      border: 2px solid var(--accent); border-top-color: transparent; border-radius: 50%;
      animation: spin .8s linear infinite;
    }
    .box:not([data-state="working"]) .spin { display: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
  `;

  let host = null;
  let els = null;
  let handler = null;

  function fire(id) {
    if (typeof handler !== "function") return;
    try {
      handler(id);
    } catch (e) {
      console.warn("SynthIDBanner handler failed", e);
    }
  }

  function ensure() {
    if (host && host.isConnected && els) return els;
    host = document.createElement("synthid-check-banner");
    const root = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = CSS;

    const box = document.createElement("div");
    box.className = "box";
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    box.setAttribute("data-state", "info");

    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.setAttribute("aria-label", "Dismiss");
    close.title = "Dismiss";
    close.textContent = "×";
    close.addEventListener("click", () => {
      hide();
      fire("dismiss");
    });

    const title = document.createElement("p");
    title.className = "title";
    const spin = document.createElement("span");
    spin.className = "spin";
    spin.setAttribute("aria-hidden", "true");
    const titleText = document.createElement("span");
    title.append(spin, titleText);

    const msg = document.createElement("p");
    msg.className = "msg";
    const actions = document.createElement("div");
    actions.className = "actions";

    box.append(close, title, msg, actions);
    root.append(style, box);
    (document.documentElement || document.body).appendChild(host);
    els = { box, title, titleText, msg, actions };
    return els;
  }

  function show(opts) {
    const o = opts || {};
    const e = ensure();
    const state = STATES.includes(o.state) ? o.state : "info";
    e.box.setAttribute("data-state", state);
    e.titleText.textContent = o.title ? String(o.title) : "";
    e.title.style.display = o.title ? "" : "none";
    e.msg.textContent = o.message ? String(o.message) : "";
    e.actions.textContent = "";
    for (const a of Array.isArray(o.actions) ? o.actions : []) {
      if (!a || !a.id) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = String(a.label || a.id);
      if (a.primary) b.className = "primary";
      b.addEventListener("click", () => fire(String(a.id)));
      e.actions.appendChild(b);
    }
    e.box.hidden = false;
  }

  function hide() {
    if (els) els.box.hidden = true;
  }

  function onAction(fn) {
    handler = typeof fn === "function" ? fn : null;
  }

  globalThis.SynthIDBanner = { show, hide, onAction };
})();
