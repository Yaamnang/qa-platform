// Captures a still of the 3D eclipse scene as the sign-in page's poster image
// (components/eclype/eclype-poster.jpg). The poster shows instantly while three.js
// loads, and stays for browsers that cannot run the scene.
//
// Re-run after changing anything in components/eclype, with the app running:
//   node scripts/eclype-poster.mjs [base url, default http://localhost:3000]
//
// Needs a real GPU: headless Chromium falls back to software WebGL, where the
// scene deliberately does not render.

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:3000";
const out = "components/eclype/eclype-poster.jpg";

const browser = await chromium.launch({ args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
// A narrow panel (about 0.7 wide per 1 tall): wider panels crop it top and
// bottom, so the moon keeps the same size as in the live scene.
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 2, reducedMotion: "no-preference" });
await page.goto(`${base}/login`, { waitUntil: "load" });
await page.addStyleTag({ content: "canvas { transition: none !important; }" });
// Hide everything on the panel except the scene itself.
await page.evaluate(() => {
  for (const el of document.querySelector("aside").children) {
    if (!el.querySelector("canvas")) el.style.visibility = "hidden";
  }
});
await page.waitForFunction(() => document.querySelector("aside canvas")?.style.opacity === "1", null, { timeout: 60000 });
const image = await page.locator("aside canvas").screenshot({ type: "jpeg", quality: 85 });
writeFileSync(out, image);
console.log(`Saved ${out} (${Math.round(image.length / 1024)} KB)`);
await browser.close();
