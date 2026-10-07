"use strict";

(function () {
  const ALL = { origins: ["<all_urls>"] };
  const SYNTHID = { origins: ["https://synthid.com/*"] };
  const DEFAULTS = { openInForeground: true, dropZone: true, dropZoneCorner: "top-right" };
  const CORNERS = ["top-right", "bottom-right", "top-left", "bottom-left"];
  const COMMAND_ORDER = ["start-picker", "_execute_action"];
  const COMMAND_LABELS = {
    "start-picker": "Pick media on this page",
    _execute_action: "Open the SynthID Check menu",
  };
  const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)$/;
  const KEY_NAMES = {
    Comma: "Comma", Period: "Period", Home: "Home", End: "End", PageUp: "PageUp",
    PageDown: "PageDown", Space: "Space", Insert: "Insert", Delete: "Delete",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  };

  const foreground = document.getElementById("openInForeground");
  const dropZone = document.getElementById("dropZone");
  const corner = document.getElementById("dropZoneCorner");
  const cornerField = corner.parentElement;
  const shortcutList = document.getElementById("shortcuts");
  const shortcutStatus = document.getElementById("shortcut-status");
  const accessStatus = document.getElementById("access-status");
  const synthidStatus = document.getElementById("synthid-status");
  const restoreBlock = document.getElementById("restore-block");
  const restore = document.getElementById("restore");
  const error = document.getElementById("error");

  let isMac = false;
  let commands = [];
  let recording = null; // name of the command being recorded
  let saving = false; // a recorded shortcut is being saved
  let renderToken = 0;

  function showError(e) {
    error.textContent = e ? String(e && e.message ? e.message : e) : "";
    error.hidden = !e;
  }

  function setShortcutStatus(text, isError) {
    shortcutStatus.textContent = text || "";
    shortcutStatus.classList.toggle("error", !!isError);
  }

  function normalizeCorner(value) {
    return CORNERS.includes(value) ? value : DEFAULTS.dropZoneCorner;
  }

  // Applies stored values to the controls and the usage text.
  function applySettings(s) {
    foreground.checked = s.openInForeground !== false;
    dropZone.checked = s.dropZone !== false;
    corner.value = normalizeCorner(s.dropZoneCorner);
    corner.disabled = !dropZone.checked;
    cornerField.classList.toggle("disabled", corner.disabled);
  }

  async function loadSettings() {
    applySettings(await browser.storage.sync.get(DEFAULTS));
  }

  foreground.addEventListener("change", () => {
    browser.storage.sync.set({ openInForeground: foreground.checked }).catch(showError);
  });

  dropZone.addEventListener("change", () => {
    corner.disabled = !dropZone.checked;
    cornerField.classList.toggle("disabled", corner.disabled);
    browser.storage.sync
      .set({ dropZone: dropZone.checked })
      .then(() => browser.runtime.sendMessage({ type: "synthid:syncDropZone" }))
      .catch(showError);
  });

  corner.addEventListener("change", () => {
    browser.storage.sync.set({ dropZoneCorner: normalizeCorner(corner.value) }).catch(showError);
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (!("openInForeground" in changes || "dropZone" in changes || "dropZoneCorner" in changes)) {
      return;
    }
    loadSettings().catch(showError);
  });

  // Keyboard shortcuts

  function appendShortcut(container, shortcut) {
    container.textContent = "";
    if (!shortcut) {
      container.textContent = "Not set";
      return;
    }
    shortcut.split("+").forEach((part) => {
      const kbd = document.createElement("kbd");
      kbd.textContent = part;
      container.appendChild(kbd);
    });
  }

  function commandLabel(cmd) {
    if (cmd.name === "_execute_action") return COMMAND_LABELS._execute_action;
    return cmd.description || COMMAND_LABELS[cmd.name] || cmd.name;
  }

  function makeButton(text, onClick, disabled) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.disabled = !!disabled;
    b.addEventListener("click", onClick);
    return b;
  }

  function renderShortcuts() {
    shortcutList.textContent = "";
    const sorted = commands.slice().sort((a, b) => {
      const ia = COMMAND_ORDER.indexOf(a.name);
      const ib = COMMAND_ORDER.indexOf(b.name);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    for (const cmd of sorted) {
      const row = document.createElement("li");
      row.className = "shortcut-row";
      const isRecording = recording === cmd.name;
      row.classList.toggle("recording", isRecording);

      const name = document.createElement("span");
      name.className = "shortcut-name";
      name.textContent = commandLabel(cmd);

      const keys = document.createElement("span");
      keys.className = "shortcut-keys";
      if (isRecording) keys.textContent = "Waiting for keys…";
      else appendShortcut(keys, cmd.shortcut);

      const actions = document.createElement("div");
      actions.className = "shortcut-actions";
      actions.append(
        makeButton(isRecording ? "Cancel" : "Change", () => {
          if (isRecording) stopRecording();
          else startRecording(cmd.name);
        }),
        makeButton("Reset", () => runCommandAction(cmd.name, () => browser.commands.reset(cmd.name))),
        makeButton(
          "Remove",
          () => runCommandAction(cmd.name, () => browser.commands.update({ name: cmd.name, shortcut: "" })),
          !cmd.shortcut,
        ),
      );

      const line = document.createElement("div");
      line.className = "shortcut-line";
      line.append(name, keys);
      row.append(line, actions);
      shortcutList.appendChild(row);
    }
  }

  async function refreshCommands() {
    const token = ++renderToken;
    const list = await browser.commands.getAll();
    if (token !== renderToken) return;
    commands = list;
    renderShortcuts();
  }

  async function runCommandAction(name, action) {
    stopRecording(true);
    try {
      await action();
      setShortcutStatus("");
    } catch (e) {
      setShortcutStatus(e && e.message ? e.message : String(e), true);
    }
    refreshCommands().catch(showError);
  }

  function startRecording(name) {
    recording = name;
    setShortcutStatus("Press the new shortcut… Esc to cancel", false);
    document.addEventListener("keydown", onRecordKey, true);
    document.addEventListener("pointerdown", onRecordPointer, true);
    renderShortcuts();
  }

  function stopRecording(keepStatus, deferRender) {
    if (recording === null) return;
    recording = null;
    saving = false;
    document.removeEventListener("keydown", onRecordKey, true);
    document.removeEventListener("pointerdown", onRecordPointer, true);
    if (!keepStatus) setShortcutStatus("");
    if (deferRender) {
      // Re-rendering now would remove the button being pressed before its click fires.
      window.addEventListener("pointerup", () => setTimeout(renderShortcuts, 0), { once: true, capture: true });
    } else {
      renderShortcuts();
    }
  }

  function onRecordPointer(e) {
    // Clicking elsewhere cancels; the recording row's own buttons handle themselves.
    if (e.target instanceof Element && e.target.closest(".shortcut-row.recording")) return;
    stopRecording(false, true);
  }

  // The key as Firefox matches it: by the character it types, so the shortcut works on
  // AZERTY, QWERTZ or Dvorak. The physical key (code) is the fallback, e.g. when Shift or
  // Option changes the character.
  function keyName(e) {
    if (typeof e.key === "string" && /^[A-Za-z0-9]$/.test(e.key)) return e.key.toUpperCase();
    return /^Key[A-Z]$/.test(e.code) ? e.code.slice(3)
      : /^Digit[0-9]$/.test(e.code) ? e.code.slice(5)
      : /^F([1-9]|1[0-2])$/.test(e.code) ? e.code
      : KEY_NAMES[e.code];
  }

  // Returns { shortcut } or { problem } for a keydown event.
  function buildShortcut(e) {
    const key = keyName(e);
    if (!key) {
      return { problem: "That key can't be used. Use a letter, number, F1 to F12, Comma, Period, Space, or one of Home, End, PageUp, PageDown, Insert, Delete or the arrow keys." };
    }
    if (e.metaKey && !isMac) {
      return { problem: "The Windows or Super key can't be used here. Try Ctrl, Alt or Shift." };
    }
    const mods = [];
    if (isMac && e.metaKey) mods.push("Command");
    if (e.ctrlKey) mods.push(isMac ? "MacCtrl" : "Ctrl");
    if (e.altKey) mods.push("Alt");
    const hasPrimary = mods.length > 0;
    if (e.shiftKey) mods.push("Shift");
    if (mods.length > 2) {
      return { problem: "Firefox allows at most two modifier keys in a shortcut." };
    }
    const isFunctionKey = /^F\d+$/.test(key);
    if (!hasPrimary && !isFunctionKey) {
      return { problem: "A shortcut needs at least one of " + (isMac ? "Command, Control or Option" : "Ctrl or Alt") + " (Shift alone isn't enough), unless it is F1 to F12." };
    }
    return { shortcut: mods.concat(key).join("+") };
  }

  function onRecordKey(e) {
    if (recording === null) return;
    if (MODIFIER_CODES.test(e.code) || e.key === "AltGraph") return;
    e.preventDefault();
    e.stopPropagation();
    // Holding the keys repeats them; a second combination waits for the first to be saved.
    if (e.repeat || saving) return;
    if (e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      stopRecording();
      return;
    }
    const result = buildShortcut(e);
    if (result.problem) {
      setShortcutStatus(result.problem + " Press another shortcut, or Esc to cancel.", true);
      return;
    }
    const name = recording;
    saving = true;
    // commands.update throws synchronously for a value its schema rejects.
    Promise.resolve()
      .then(() => browser.commands.update({ name, shortcut: result.shortcut }))
      .then(
        () => {
          stopRecording();
          refreshCommands().catch(showError);
        },
        (err) => {
          saving = false;
          setShortcutStatus((err && err.message ? err.message : String(err)) + " Try another shortcut, or Esc to cancel.", true);
        },
      );
  }

  if (browser.commands.onChanged) {
    browser.commands.onChanged.addListener(() => refreshCommands().catch(showError));
  }
  // Shortcuts may also be edited in Firefox's add-ons manager while the popup is open.
  window.addEventListener("focus", () => {
    if (recording === null) refreshCommands().catch(showError);
  });

  // Website access. Granted at install; Firefox lets users revoke it, so offer a way back.
  async function render() {
    const [hasAll, hasSynthid] = await Promise.all([
      browser.permissions.contains(ALL),
      browser.permissions.contains(SYNTHID),
    ]);
    accessStatus.textContent = hasAll
      ? "SynthID Check has access to all websites."
      : "Access to websites is turned off, so SynthID Check can't download files to check.";
    synthidStatus.hidden = hasSynthid;
    restoreBlock.hidden = hasAll && hasSynthid;
  }

  restore.addEventListener("click", () => {
    showError(null);
    // permissions.request() must be called directly from the click.
    browser.permissions.request(ALL).then(render, showError);
  });

  browser.permissions.onAdded.addListener(() => render().catch(showError));
  browser.permissions.onRemoved.addListener(() => render().catch(showError));

  browser.runtime
    .getPlatformInfo()
    .then((info) => { isMac = info.os === "mac"; }, () => {})
    .then(() => refreshCommands())
    .catch(showError);
  loadSettings().catch(showError);
  render().catch(showError);

  // Used by popup.js, which switches between the main and the settings view.
  window.SettingsView = {
    isRecording: () => recording !== null,
    // Called whenever the view is shown or left.
    cancelRecording: () => stopRecording(),
    refresh() {
      loadSettings().catch(showError);
      refreshCommands().catch(showError);
      render().catch(showError);
    },
  };
})();
