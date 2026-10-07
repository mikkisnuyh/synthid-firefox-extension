# Architecture

Firefox MV3 extension. The user picks an image, video or audio element. The extension fetches the original file and attaches it to synthid.com's own upload form in a new tab, where the user (signed in) sees the result.

It never calls synthid.com's backend directly, never auto-accepts the site's Terms, never retries without a user click, and has no batch mode (synthid.com Terms: "Automate or Scrape").

No build step. Plain scripts, using the `browser.*` promise API.

Scripts are injected on demand, with one exception: while the `dropZone` setting is on, `resolve.js` and `dropzone.js` are registered as content scripts for all pages and frames (see Drop zone).

## Files

| File | Runs in | Responsibility |
|---|---|---|
| `src/lib/media.js` | background (classic script) and Node tests | Pure helpers: accepted types, MIME and extension checks, file names, `data:` URL → Blob. |
| `src/lib/pending.js` | background | IndexedDB store of pending checks, keyed by the synthid.com tab id. |
| `src/background.js` | background event page | Menus, toolbar/picker, permissions, getting the file, opening synthid.com, messaging. |
| `src/content/resolve.js` | injected into the source page on demand; also registered with `dropzone.js` while the drop zone is on | Finds the media element for a right-click target or a point; reads `blob:` URLs. |
| `src/content/dropzone.js` | registered content script, all pages and frames (except synthid.com) while the `dropZone` setting is on | Drop zone: shows a drop target while an image is dragged; dropping on it starts a check. |
| `src/content/picker.js` | injected on demand | Pick mode: hover to highlight media, click to choose, Esc to cancel. |
| `src/content/banner.js` | synthid.com content script; also injected into source pages for notices | Shadow-DOM banner UI. |
| `src/content/synthid.js` | synthid.com content script | Attaches the pending file to the site's file input (paste fallback); handles the Terms and sign-in dialogs. |
| `src/options/options.*` | options page | Settings; shows whether website access is on and offers to restore it if it was revoked. |
| `src/popup/popup.*` | toolbar popup | Menu: "Pick media on this page", plus links to synthid.com and the settings. |

## Shared globals (classic scripts, no modules)

### `src/lib/media.js`
Defines `globalThis.SynthIDMedia` and also sets `module.exports` when `module` exists, so Node tests can `require` it.

- `ACCEPTED_EXTENSIONS`: `["jpg","jpeg","png","bmp","webp","avif","heic","heif","tiff","tif","gif","wav","mp3","ogg","flac","aac","m4a","mp4","mov","webm"]`, copied from synthid.com's `<input accept>`.
- `MIME_TO_EXTENSION`: object, e.g. `"image/jpeg" → "jpg"`, `"audio/mpeg" → "mp3"`, `"video/quicktime" → "mov"`.
- `extensionFromUrl(url)` → lowercase extension, or `""`. Ignores the query string and hash; for `data:` URLs uses the MIME.
- `isAcceptedType(mime, fileName)` → boolean. Accepted if the MIME maps to an accepted extension, or else the file name's extension is accepted. Treats `image/jpg` and `image/pjpeg` like `image/jpeg`.
- `fileNameFor(url, mime)` → a sane file name with the right extension (default base name `synthid-check`), max 100 characters, no path separators.
- `dataUrlToBlob(dataUrl)` → `Blob`. Throws on malformed input.
- `originPattern(url)` → e.g. `"https://cdn.example.com/*"`, or `null` for non-http(s) URLs.
- `MAX_BYTES` = 200 MB, a sanity cap. The extension refuses larger files with a clear message.

### `src/lib/pending.js`
Defines `globalThis.SynthIDPending`. The database is `synthid-check`, with object store `pending` and key path `tabId`.

- `put({tabId, blob, name, type, sourceUrl, createdAt, autoAttach: true, attachedAt: null, signInSeen: false})`
- `get(tabId)` → the record, or `null`. Returns `null` and deletes the record if it's older than `TTL_MS` (10 minutes).
- `update(tabId, patch)`
- `remove(tabId)`
- `purgeExpired()`

### `src/content/banner.js`
Defines `globalThis.SynthIDBanner`. It must be idempotent: injecting it twice is harmless.

- `SynthIDBanner.show({ state, title, message, actions })`. Creates or updates a single fixed-position banner: a host element `<synthid-check-banner>` with a closed shadow root, z-index max, bottom-right, readable in both light and dark color schemes.
  - `state` is one of `info | working | warn | error | success`.
  - `actions` is `[{ id, label, primary? }]`.
- `SynthIDBanner.onAction(handler)` registers `handler(actionId)`. A built-in Dismiss (×) button always exists and fires `"dismiss"`, then hides the banner.
- `SynthIDBanner.hide()`.
- Never use `innerHTML` with dynamic strings. Use `textContent`; AMO lint flags `innerHTML`.

### `src/content/resolve.js`
Defines `globalThis.SynthIDResolve`.

- `fromElement(el)`. Finds the media for an element:
  1. the element itself if it is `img`, `video`, `audio`, `picture` or `source`, or an SVG `image`;
  2. otherwise, media found with `document.elementsFromPoint` at the center of the element's bounding box;
  3. otherwise, a CSS `background-image: url(...)` on the element or its ancestors (up to 3 levels).

  Returns `{ kind: "image"|"video"|"audio", url, isBlob, isMediaSource }`, or `null`.
  - `url` prefers `currentSrc`, then `src`, then the first `<source src>`.
  - `isMediaSource` is true when the URL is `blob:` and the element is `video` or `audio` with `srcObject`, or the blob fetch later fails. Stream URLs from MediaSource can't be fetched.
- `fromPoint(x, y)`. Same as above, starting from `document.elementsFromPoint(x, y)`. It skips the picker's own overlay.
- `readBlobUrl(url)` → `Promise<{ ok: true, blob, type } | { ok: false, error }>`. Fetches a `blob:` URL in the page context.

### `src/content/picker.js`
Defines `globalThis.SynthIDPicker`.

- `SynthIDPicker.start()`. Shows a highlight outline over the media under the cursor, using `SynthIDResolve.fromPoint`, plus a small hint pill: "Click media to check with SynthID · Esc to cancel". On click (capture phase, with `preventDefault` and `stopPropagation`), it resolves and sends `{type: "synthid:picked", media}` with `browser.runtime.sendMessage`, or `{type: "synthid:picked", media: null}` if nothing was found. Then it stops. Esc stops it without sending.
- It is idempotent: if it's already running, `start()` is a no-op.

### `src/content/dropzone.js`
Defines `globalThis.SynthIDDropZone = { hide }`. Idempotent: it does nothing if `hide` already exists as a function. It only adds listeners; see Drop zone below.

## Messages (`browser.runtime.sendMessage`; the background reads `sender.tab.id`)

| From → to | Message | Reply |
|---|---|---|
| synthid.js → bg | `{type:"synthid:getPending"}` | `{found:false}` or `{found:true, blob, name, type, sourceUrl, autoAttach, signInSeen}` |
| synthid.js → bg | `{type:"synthid:attached", signInRequired:boolean}` | `{ok:true}`. The bg sets `attachedAt` and `signInSeen\|=signInRequired`, and sets `autoAttach = signInRequired` (re-attach automatically only after a sign-in redirect). |
| synthid.js → bg | `{type:"synthid:clear"}` | `{ok:true}` (removes the record) |
| picker.js → bg | `{type:"synthid:picked", media}` | none |
| dropzone.js → bg | `{type:"synthid:dropped", media}` | none. Handled like `synthid:picked`, with `sender.frameId` as the source frame. |
| popup → bg | `{type:"synthid:startPicker", tabId}` | `{ok:boolean}`. Accepted only from the popup page; `ok:false` when the page blocks injection. |

Firefox runtime messaging uses structured clone, so `Blob` crosses the boundary intact.

## Flows

### Context menu
Items are created in `runtime.onInstalled` (and `runtime.onStartup`, after `menus.removeAll()`, for robustness):

- `check-media`: "Check with SynthID", contexts `["image","video","audio"]`.
- `find-media`: "Find media under the cursor and check with SynthID", contexts `["page","frame","link"]`.

`menus.onClicked(info, tab)`:
1. **check-media** with `info.srcUrl`:
   - Website access (`<all_urls>`) is a required host permission, granted at install, so normally nothing is asked.
   - Firefox lets users revoke it. The background keeps a synchronous flag for it, refreshed from the permissions API at startup and on `permissions.onAdded` / `onRemoved`. If it's off, the click handler calls `browser.permissions.request({origins:["<all_urls>"]})` **synchronously, before any await**. The `start-picker` command and the popup's Pick button do the same.
   - `activeTab` already covers the tab's own origin, so skip the request when the source URL is same-origin with `info.pageUrl`.
   - If the request is declined, show a notice in the source tab (inject banner.js plus a `func` that calls `SynthIDBanner.show`).
2. **find-media**: `scripting.executeScript({target:{tabId, frameIds:[info.frameId]}, files:["src/content/resolve.js"]})`, then a `func` that does `SynthIDResolve.fromElement(browser.menus.getTargetElement(id))` and returns the media. Continue with **acquire**.

### Toolbar menu or shortcut
The toolbar button opens the popup (`action.default_popup`), so `action.onClicked` never fires. Opening the popup is a toolbar click, which grants `activeTab`. The popup's "Pick media on this page" button sends `synthid:startPicker` with the active tab's id. The `start-picker` command (Alt+Shift+S) skips the menu. Both call `startPicker(tabId)`, which injects `resolve.js` and `picker.js` into the top frame and calls `SynthIDPicker.start()`. `_execute_action` (open the menu) has no default key. On `synthid:picked`, continue with **acquire** using `sender.tab`.

### acquire(media, sourceTab, frameId)
- **http(s):** `fetch(url, {credentials:"include"})` from the background. If website access is off (the user declined or revoked it), fetch inside the source frame or top frame when the media is same-origin with it (`activeTab` covers that). Otherwise show a notice that points to the settings.
- **`data:`:** `SynthIDMedia.dataUrlToBlob`.
- **`blob:`:** run `SynthIDResolve.readBlobUrl(url)` in the source frame. If it fails, or `isMediaSource` is set, notify: "This is a streaming video and can't be captured. Download the file and upload it on synthid.com yourself."
- **Validate:** check `isAcceptedType` (else notify which types are accepted) and size (≤ `MAX_BYTES`).
- **Open synthid.com:** `tabs.create({url:"https://synthid.com/", index: sourceTab.index + 1, openerTabId: sourceTab.id, active: settings.openInForeground})`. Then `SynthIDPending.put({tabId: newTab.id, ...})`.
- **Errors:** notify in the source tab through the banner, injected with `scripting.executeScript` (`activeTab` allows this). If injection fails (for example on about: pages), fall back to `console.warn`.

### synthid.com page (`synthid.js`)
Declared with `run_at: document_start`, so the file transfer from the background overlaps with the page loading. Timings were measured on the live site: the upload field appears about 0.26 s after load for returning visitors; on a first visit, the Terms dialog renders just before the field; the sign-in dialog appears about 10 ms after a file is added.

1. `getPending`. If none is found, exit silently: the user is just browsing the site. Then wait until the document root exists.
2. If a record exists and `autoAttach` is false (already attached, no sign-in seen), show the banner "File from <host> is ready" with **Attach again** and **Copy image** buttons. Don't auto-attach, so reloads don't burn quota.
3. Wait for `input[type=file]`. Then wait on page state, not fixed delays (the only timeouts are generous fallbacks in case the site changes):
   - **Terms:** synthid.com stores its state in `localStorage.firstTime` once the app starts (`{isInitialized, termsAccepted, …}`). Attach only when `termsAccepted` is true and the "Agree and continue" dialog isn't visible. While it isn't, show "Accept the terms to continue…" and re-check on every DOM change. Never click it.
   - **Sign-in:** Firebase keeps a saved session in IndexedDB (`firebaseLocalStorageDb` / `firebaseLocalStorage`, key `firebase:authUser:…`). The script reads it without ever creating the database.
     - **If a session is saved,** wait until the page shows the user signed in: the account button renders `sid-account-avatar .profile-image`. Attaching before that makes the site treat the user as signed out.
     - **If the session disappears while waiting** (expired, so Firebase signed out), attach right away.
4. **Attach:** `new DataTransfer()`, `items.add(file)`, `input.files = dt.files`, then dispatch `input` and `change` with `bubbles: true`.
   - If that throws, fall back to a synthetic `paste` on `document`.
   - If that fails too, use the Firefox Xray fallbacks through `window.wrappedJSObject` and `cloneInto`.
5. **Result:** follow what the site does with the file by watching the page (MutationObserver; 3-minute fallback only). Signed in, the site moves to its `*-detection` page and shows "Detecting...", then a result card or its "Something went wrong!" card.
   - **"Detecting..." or a result:** send `synthid:attached` with `signInRequired: false`, then show the "File attached" success. It has no buttons, hides itself after 4 s, and the pending record is then cleared. Keep watching until the final state.
   - **The site's error card, or its quota message** (at once or after the success): show a neutral "Unexpected error — synthid.com couldn't check your file. Please try again later." banner. It stays until dismissed, and doesn't claim a rate limit. **Try again** (click only) goes back to the upload page with the site's "Back" link (else `history.back()`), waits until the old error card is gone, then attaches the file again from memory. Whatever the page showed just before attaching (for example the previous error card) only counts once the page has moved on from it.
   - **Signed out:** the site shows its sign-in prompt instead. Show "Sign in, then press Retry" with **Retry** and **Copy image**. When the account button later shows the user signed in, the banner says so.

6. **Copy image:** `navigator.clipboard.write([new ClipboardItem({"image/png": …})])` inside the click handler. Images only.
7. On dismiss, send `synthid:clear`.

### Drop zone
- **Registration.** `syncDropZone()` in the background registers the content script `drop-zone` with `scripting.registerContentScripts` (`resolve.js` + `dropzone.js`, `<all_urls>`, excluding `https://synthid.com/*`, `allFrames`, `document_start`) while `settings.dropZone` is not `false` (default `true`, in `storage.sync`). It unregisters it when the setting is off. It runs at startup, on `storage.onChanged` for `dropZone`, and on `runtime.onInstalled` (which also refreshes the definition with `updateContentScripts`). Calls are chained so overlapping runs can't register the id twice. The setting only affects pages opened or reloaded afterwards.
- **Drag detection.** Listeners are on `window`, capture phase, added at `document_start`, and ignore `!isTrusted` events. On `dragstart`, the target is checked: an `img`, `picture` or SVG `image` goes through `SynthIDResolve.fromElement`. For anything else (for example an image inside a link, which drags as the link), the zone counts only when `dataTransfer.types` has `application/x-moz-nativeimage`, and the media comes from `SynthIDResolve.fromPoint`. Only `kind: "image"` with a URL counts. Text and plain links don't show the zone.
- **Showing.** After the check, `setTimeout(0)` waits for the page's own `dragstart` handlers; if `e.defaultPrevented`, the drag was cancelled, no `dragend` would follow, and the zone is not shown. Frames smaller than 240x160 get no zone.
- **Why in the source frame.** Firefox doesn't let a cross-origin frame drop into its parent, so a zone in the top frame couldn't receive a drag that started in an iframe. The zone is shown in the frame where the drag started: the top frame for ordinary pages.
- **The zone.** A `<synthid-check-dropzone>` host with a closed shadow root and `data-synthid-picker`, so `resolve.js` never takes it for page media. It is fixed at the bottom-right, half transparent with a dashed border, and uses the popover top layer (`popover="manual"`, `showPopover()`) to stay above page dialogs. `dragenter`/`dragover` on it call `preventDefault` and `stopImmediatePropagation` and set `dropEffect` within what the source's `effectAllowed` permits.
- **Drop.** A drop on the zone is stopped, the zone is hidden, and `{type:"synthid:dropped", media}` is sent. The background runs `acquire` with `sender.tab` and `sender.frameId`, like `synthid:picked`. A drop anywhere else just hides the zone. Nothing is read or sent before the drop.
- **Hiding.** On `dragend`, `drop`, `pagehide`, and when a new `dragstart` begins. `dragend` goes to the drag source, so a page that removes the source from the document mid-drag hides it from us. As a fallback, a trusted `mousemove` with `buttons === 0` while the zone is shown hides it, since no mouse events reach the page during a drag.

## Hardening added after review

- **Dismiss and Terms.** `synthid.js` stops the flow as soon as the banner is dismissed. It never attaches while the "Agree and continue" dialog is visible: it watches for the dialog while waiting for the file input, and on a first visit (no Terms acceptance stored by the site) it requires a short period with no dialog before attaching. A Retry or "Attach again" click goes through the same checks.
- **Private windows.** Pending files from private windows are kept only in the background's memory, never in IndexedDB. All pending records are cleared on browser start, because tab ids restart each session.
- **Script injection.** Every `scripting.executeScript` call uses `injectImmediately: true`, so notices and pick mode work on pages that are still loading. Each tab has its own notice queue.
- **Pick mode.** It ignores synthetic (`!isTrusted`) events, so a page can't choose the media for the user.
- **Overlays.** `fromElement` hit-tests the centre of the part of the element that is on screen.
- **Downloads.** The size cap is enforced while streaming the download. After a network error , there is one fallback to an in-page fetch for the page's own origin, then a notice.
- **Permissions.** The options page doesn't list `https://synthid.com/*` as removable. If that access has been revoked anyway, the background shows a notice instead of opening a tab where nothing can be attached.
- **Re-injection guards.** They check for function types (`typeof X?.fn === "function"`), so named page elements (window named properties) can't spoof them.
- **Drop zone.** It ignores synthetic events, so a page can't show the zone or trigger a drop. Its listeners run in the capture phase on `window` from `document_start`, ahead of the page's, so a page can't swallow drops meant for the zone. The script sends nothing until a trusted drop lands on the zone, and the guard against double injection checks `typeof SynthIDDropZone?.hide === "function"`.
