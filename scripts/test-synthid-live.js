#!/usr/bin/env node
/* End-to-end check against the LIVE https://synthid.com in Chromium.
 * Stubs browser.runtime.sendMessage, injects the content scripts and verifies:
 *  a. Terms dialog -> banner shown, "Agree and continue" NOT auto-clicked
 *  b. after the user clicks it, the file is attached (sign-in dialog appears),
 *     synthid:attached{signInRequired:true} is sent and the banner offers Retry.
 * One page load, one attach: no batch use of the site. */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { chromium } = require("/opt/node-tools/node_modules/playwright");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "test-results");
fs.mkdirSync(OUT, { recursive: true });

function crc32(buf) {
  let c, crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 255) / w;
      raw[o + 1] = (y * 255) / h;
      raw[o + 2] = 128;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS" : "FAIL") + ": " + name + (ok || !detail ? "" : " (" + detail + ")"));
  if (!ok) failed++;
}

const INIT = (b64) => `
(() => {
  const bin = atob(${JSON.stringify(b64)});
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  window.__msgs = [];
  globalThis.browser = {
    runtime: {
      sendMessage: async (msg) => {
        window.__msgs.push(msg);
        if (msg.type === "synthid:getPending") {
          return { found: true, blob: new Blob([bytes], { type: "image/png" }), name: "test.png",
                   type: "image/png", autoAttach: true, signInSeen: false, sourceUrl: "https://example.com/a.png" };
        }
        return { ok: true };
      },
    },
  };
  // The banner uses a closed shadow root; keep a handle so the test can read it.
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const r = orig.call(this, init);
    if (this.localName === "synthid-check-banner") window.__bannerRoot = r;
    return r;
  };
})();`;

const bannerText = (page) =>
  page.evaluate(() => {
    const r = window.__bannerRoot;
    const box = r && r.querySelector(".box");
    return box && !box.hidden ? box.innerText : "";
  });

async function waitBanner(page, re, timeout = 20000) {
  const start = Date.now();
  let t = "";
  while (Date.now() - start < timeout) {
    t = await bannerText(page);
    if (re.test(t)) return t;
    await page.waitForTimeout(250);
  }
  return t;
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, bypassCSP: true });
    await context.addInitScript(INIT(makePng(64, 64).toString("base64")));
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log("pageerror:", e.message));
    page.on("console", (m) => {
      if (/SynthID Check/.test(m.text())) console.log("  [content script] " + m.text());
    });

    await page.goto("https://synthid.com/", { waitUntil: "load", timeout: 60000 });
    const agree = page.getByRole("button", { name: "Agree and continue" });
    await agree.waitFor({ state: "visible", timeout: 30000 });

    const bannerJs = fs.readFileSync(path.join(ROOT, "src/content/banner.js"), "utf8");
    const synthJs = fs.readFileSync(path.join(ROOT, "src/content/synthid.js"), "utf8");
    await page.addScriptTag({ content: bannerJs });
    await page.addScriptTag({ content: synthJs });

    // a. Terms
    const termsMsg = await waitBanner(page, /accept the terms/i);
    await page.screenshot({ path: path.join(OUT, "1-terms-banner.png") });
    check("terms banner shown", /accept the terms/i.test(termsMsg), JSON.stringify(termsMsg));
    await page.waitForTimeout(3000);
    check("'Agree and continue' not auto-clicked after 3s", await agree.isVisible());
    const msgs0 = await page.evaluate(() => window.__msgs.map((m) => m.type));
    check("no attach before terms accepted", !msgs0.includes("synthid:attached"), msgs0.join(","));

    // b. User accepts the terms
    await agree.click();
    await page.screenshot({ path: path.join(OUT, "2-terms-accepted.png") });
    let signIn = true;
    try {
      await page.getByText(/please sign in before detection/i).first().waitFor({ state: "visible", timeout: 30000 });
    } catch (e) {
      signIn = false;
    }
    await page.screenshot({ path: path.join(OUT, "3-sign-in-dialog.png") });
    check("site received the file (sign-in dialog shown)", signIn);

    const final = await waitBanner(page, /sign in/i, 15000);
    await page.screenshot({ path: path.join(OUT, "4-final-banner.png") });
    check("banner shows sign-in / Retry state", /sign in/i.test(final) && /retry/i.test(final), JSON.stringify(final));
    check("banner offers Copy image", /copy image/i.test(final));

    const msgs = await page.evaluate(() => window.__msgs);
    const att = msgs.filter((m) => m.type === "synthid:attached");
    check("synthid:attached sent once with signInRequired:true", att.length === 1 && att[0].signInRequired === true, JSON.stringify(att));
    check("no synthid:clear before dismiss", !msgs.some((m) => m.type === "synthid:clear"));

    // dismiss -> clear
    await page.evaluate(() => window.__bannerRoot.querySelector(".close").click());
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => window.__msgs.map((m) => m.type));
    check("dismiss sends synthid:clear", after.includes("synthid:clear"));
    check("banner hidden after dismiss", (await bannerText(page)) === "");

    // c. Returning visitor (Terms already accepted in this profile), scripts injected at
    // document_start as in the extension: the file should be attached right away.
    const page2 = await context.newPage();
    page2.on("pageerror", (e) => console.log("  page2 error:", e.message));
    page2.on("console", (m) => { if (/SynthID/.test(m.text())) console.log("  [page2] " + m.text()); });
    await page2.addInitScript(
      () => {
        const t0 = performance.now();
        document.addEventListener(
          "change",
          (e) => {
            if (e.target && e.target.type === "file" && window.__changeAt === undefined) {
              window.__changeAt = Math.round(performance.now() - t0);
            }
          },
          true,
        );
      },
    );
    await page2.addInitScript({ content: bannerJs + "\n;\n" + synthJs });
    await page2.goto("https://synthid.com/", { waitUntil: "load", timeout: 60000 });
    const returning = await waitBanner(page2, /sign in/i, 15000);
    const changeAt = await page2.evaluate(() => window.__changeAt);
    check("returning visitor: no Terms banner, file attached", /sign in/i.test(returning), JSON.stringify(returning));
    check("returning visitor: attached within 1.5 s of navigation", typeof changeAt === "number" && changeAt < 1500, String(changeAt));
    console.log("  returning visitor attach time: " + changeAt + " ms");
    await page2.screenshot({ path: path.join(OUT, "5-returning-visitor.png") });
  } catch (e) {
    console.log("FAIL: unexpected error: " + e.message);
    failed++;
  } finally {
    await browser.close();
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
})();
