# SynthID Check

Drag an image onto the drop box, or right-click an image, video, or audio element, to check it for a SynthID watermark. The original file is attached to Google's official SynthID Detector at synthid.com in a new tab, where you sign in and see the detection result.

## How to use

- **Drag and drop:** Drag an image on a page. A box "Drop here to check with SynthID" appears in the top-right corner by default (the other corner on the same side if you start dragging from there). Drop the image on it to start the check. The box goes away when the drag ends. You can choose the corner, or turn this off with "Show a drop zone when you drag an image", in the settings; the change applies to pages you open or reload afterwards.
- **Context menu:** Right-click an image, video, or audio element and select "Check with SynthID". If the site covers the media with an overlay, use "Find media under the cursor and check with SynthID" from the page or frame context menu.
- **Toolbar menu:** Click the extension icon to open its menu. It lists the ways to check (drag, right-click, pick). Choose **Pick media on this page** to pick: media is highlighted as you move the cursor; click the one you want to check, or press Esc to cancel. The menu also links to synthid.com and the settings.
- **Keyboard shortcut:** Press Alt+Shift+S to start pick mode directly, without the menu. You can change it, or add a shortcut that opens the menu, in SynthID Check's settings.

## What it can and can't detect

SynthID is Google DeepMind's invisible watermark. Google's AI products embed it, and so do partners that adopted it, including OpenAI, Nvidia and Kakao. synthid.com detects those watermarks in images, audio and video.

**Limitations:**
- Only detects SynthID watermarks from Google and partner systems. This is not a general AI detector.
- Absence of a detected watermark does not mean the media was created by a human.
- Text is not supported. synthid.com only checks images, audio and video. There is no public SynthID text detector.
- If synthid.com reports an error while checking (for example after many checks in a short time), the extension shows "Unexpected error" with a **Try again** button.
- Drag and drop only works for images the page lets you drag. Sites that disable image dragging or cover images with overlays won't show the drop zone (use the context menu, pick mode or "Find media under the cursor"). Video and audio are usually not draggable. Files dragged from the desktop or another window aren't supported. The box isn't shown in frames smaller than 240x160, and when you drag out of an embedded frame it appears inside that frame.
- Streaming videos (e.g., YouTube) cannot be captured. Download and upload the file directly on synthid.com.

## Website access

Firefox asks for access to all websites when you install the extension, and that's the only permission prompt. You can turn it off later in about:addons → SynthID Check → Permissions; that is Firefox's own control. Checks then can't download files from other sites, and the extension tells you so, with an **Open settings** button. To turn it back on, use the button in the extension's settings. The settings open in their own tab, from the **Settings** link in the toolbar menu.

## Requirements

- Firefox 140 or later
- A Google, Apple, or ChatGPT account to sign in on synthid.com
- synthid.com has daily detection limits per account

## Permissions

| Permission | Reason |
|-----------|--------|
| `menus` | Right-click context menu items |
| `activeTab` | To detect media on the current tab |
| `scripting` | To inject media detection and picker scripts |
| `storage` | To store extension settings in Firefox Sync storage |
| `clipboardWrite` | To copy images to the clipboard as a fallback |
| Access to all websites (`host_permissions: <all_urls>`) | Granted once when you install. Needed to download the original file from whichever site hosts it (often a different site than the page, such as an image CDN). Files are only downloaded when you start a check. |
| Content script on synthid.com | To attach the file to synthid.com's own upload form and show status (it never signs in or accepts terms for you) |
| Content script on all sites (only while "Show a drop zone when you drag an image" is on) | To show the drop zone while you drag an image. It only listens for drag events; it reads nothing and sends nothing until you drop an image on the zone. It uses the existing `scripting` and website access permissions, so there is no extra prompt. |

**Data collection:** This extension declares `websiteContent` in its manifest. When you initiate a check, the file you choose is downloaded from the site hosting it and sent to synthid.com (Google's service). No other data is collected or sent.

## Terms of use

The extension only fills synthid.com's own upload form with one file you select. It never calls synthid.com's backend, never accepts the site's Terms on your behalf, and has no batch or automation mode. This is in line with synthid.com's Terms of Service restrictions on "Automate or Scrape" activity.

## Install for development

```bash
npm install          # Install dependencies
npm test             # Run unit tests
npm run lint         # Lint the code
npm start            # Run in Firefox with web-ext (web-ext run)
npm run test:live    # End-to-end test against live synthid.com in Chromium
```

To load the extension temporarily in Firefox:
1. Navigate to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select the `manifest.json` file in this repository

## Build

```bash
npm run build        # Create a production build
```

## Project structure

This is a plain MV3 Firefox extension with no build step. Scripts use the `browser.*` promise API. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details on files, messaging flows, and how media detection and upload work.

## Credits

Inspired by [rslosh/synthid-chrome_extension](https://github.com/rslosh/synthid-chrome_extension), which is licensed under the MIT License. This extension is not affiliated with Google, OpenAI, Nvidia, Kakao, or synthid.com.

## License

MIT License. See [LICENSE](LICENSE) for details.
