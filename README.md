# SynthID Check

Right-click an image, video, or audio element to check it for a SynthID watermark. The original file is attached to Google's official SynthID Detector at synthid.com in a new tab, where you sign in and see the detection result.

## How to use

- **Context menu:** Right-click an image, video, or audio element and select "Check with SynthID". If the site covers the media with an overlay, use "Find media here and check with SynthID" from the page or frame context menu.
- **Toolbar button:** Click the extension icon to enter pick mode and highlight media as you move the cursor. Click the media you want to check.
- **Keyboard shortcut:** Press Alt+Shift+S to start pick mode.

## What it can and can't detect

SynthID is Google DeepMind's invisible watermark. Google's AI products embed it, and so do partners that adopted it, including OpenAI, Nvidia and Kakao. synthid.com detects those watermarks in images, audio and video.

**Limitations:**
- Only detects SynthID watermarks from Google and partner systems. This is not a general AI detector.
- Absence of a detected watermark does not mean the media was created by a human.
- Text is not supported. synthid.com and the Gemini app only check images, audio and video. There is no public SynthID text detector.
- Streaming videos (e.g., YouTube) cannot be captured. Download and upload the file directly on synthid.com.

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
| `optional_host_permissions` | Requested per site only when needed to download the original file |
| Content script on synthid.com only | To attach the file to synthid.com's own upload form and show status (it never signs in or accepts terms for you) |

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
