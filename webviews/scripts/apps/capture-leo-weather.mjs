// Capture-only: screenshots of each look and one video of rain -> snow -> sun -> storm -> night,
// from the gallery entry apps.leo-weather. Usage: bun capture-leo-weather.mjs OUT_DIR
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { preview } from "vite";

const out = path.resolve(process.argv[2] ?? process.env.FAST_CHECKS_OUT ?? "leo-weather-captures");
fs.mkdirSync(out, { recursive: true });
const root = path.resolve(import.meta.dir, "../..");
const build = spawn("bun", ["run", "gallery:build"], { cwd: root, stdio: "inherit" });
await new Promise((resolve, reject) => {
  build.once("error", reject);
  build.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`gallery build exited ${code}`))));
});
const server = await preview({ root, configFile: path.join(root, "vite.config.gallery.ts"), preview: { host: "127.0.0.1", port: 0 } });
const address = server.httpServer.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const size = { width: 1100, height: 560 };
const url = (variant) => `${baseUrl}/frame.html?entry=apps.leo-weather&variant=${variant}&colorScheme=dark&width=normal&frame=component`;

async function open(page, variant) {
  await page.goto(url(variant), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.galleryReady === "1", undefined, { timeout: 90_000 });
  await page.waitForFunction(() => document.querySelectorAll(".cmux-app-scene-root").length === 2, undefined, { timeout: 60_000 });
}

async function record(browser, name, body) {
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, colorScheme: "dark", recordVideo: { dir: out, size } });
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && console.log(`[${name}] console error: ${m.text()}`));
  page.on("pageerror", (e) => console.log(`[${name}] page error: ${e.message}`));
  await body(page);
  const video = page.video();
  await context.close();
  if (video) {
    const target = path.join(out, `${name}.webm`);
    await video.saveAs(target);
    await video.delete();
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", target, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", target.replace(/\.webm$/, ".mp4")]);
    console.log(`wrote ${target}${r.status === 0 ? " (+mp4)" : ""}`);
  }
}

try {
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  try {
    const context = await browser.newContext({ viewport: size, deviceScaleFactor: 2, colorScheme: "dark" });
    const page = await context.newPage();
    for (const variant of ["sky-rain", "sky-snow", "sky-sun", "sky-storm", "sky-night", "card-sun", "card-rain", "minimal-snow", "minimal-sun"]) {
      await open(page, variant);
      // fixed-wait: particles and loops need a moment on screen before the still
      await page.waitForTimeout(2500);
      await page.screenshot({ path: path.join(out, `leo-weather-${variant}.png`) });
      console.log(`shot ${variant}`);
    }
    await context.close();
    await record(browser, "leo-weather-skies", async (p) => {
      for (const variant of ["sky-rain", "sky-snow", "sky-sun", "sky-storm", "sky-night"]) {
        await open(p, variant);
        // fixed-wait: each sky plays for a fixed length of the video (the 4 s bar shuffle fires once)
        await p.waitForTimeout(4500);
      }
    });
    await record(browser, "leo-weather-looks", async (p) => {
      for (const variant of ["sky-rain", "card-sun", "minimal-snow"]) {
        await open(p, variant);
        // fixed-wait: each look plays for a fixed length of the video
        await p.waitForTimeout(4500);
      }
    });
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
