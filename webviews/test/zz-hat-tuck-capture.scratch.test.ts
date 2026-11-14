// Scratch capture for the PR (not committed): the tuck control's three looks.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { galleryFrame, warmGalleryFrame } from "./support/galleryFrame";
import { requireBrowserLane } from "./support/requireBrowserLane";

await requireBrowserLane("zz-hat-tuck-capture.scratch.test.ts", async () => {
  setDefaultTimeout(600_000);
  const OUT = process.env.FAST_CHECKS_OUT ?? "/tmp/hat-shots";
  let server: any;
  let browser: Browser;
  beforeAll(async () => {
    await mkdir(OUT, { recursive: true });
    const { createServer } = await import("vite");
    server = await createServer({
      root: path.resolve(import.meta.dir, ".."),
      configFile: path.resolve(import.meta.dir, "../vite.config.gallery-dev.ts"),
      server: { port: 0, host: "127.0.0.1", strictPort: false },
      logLevel: "error",
    });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    await warmGalleryFrame(server, "agent-pane.composer-hat-tuck", { browser, params: { variant: "revealed" } });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  test("tuck looks", async () => {
    const port = server.httpServer!.address().port;
    for (const theme of ["dark", "light"])
      for (const arm of ["tab", "pill", "band"])
        for (const state of ["revealed", "hover", "pressed"]) {
          if (theme === "light" && arm !== "tab") continue;
          const page = await browser.newPage({
            viewport: { width: 560, height: 240 },
            deviceScaleFactor: 2,
            colorScheme: theme as "dark" | "light",
          });
          await page.addInitScript((value) => {
            (globalThis as any).cmuxExperiments = { "composer-hat-tuck": value };
          }, arm);
          await page.goto(
            `http://127.0.0.1:${port}${galleryFrame("agent-pane.composer-hat-tuck", { variant: "revealed", ...(theme === "light" ? { theme: "Apple System Colors Light" } : {}) })}`,
          );
          await page.waitForFunction(() => document.documentElement.dataset.galleryReady === "1");
          await page.locator(".acpmux-running-tray__title").hover();
          await page.waitForFunction(
            () => getComputedStyle(document.querySelector(".acpmux-running-tray__tuck")!).opacity === "1",
          );
          const box = (await page.locator(".acpmux-running-tray__tuck").boundingBox())!;
          if (state !== "revealed") await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          if (state === "pressed") await page.mouse.down();
          await page.waitForTimeout(400);
          const tray = (await page.locator(".acpmux-running-tray").boundingBox())!;
          console.log(`tuck ${theme} ${arm} ${state} box=${JSON.stringify(box)}`);
          await page.screenshot({
            path: `${OUT}/tuck2-${theme}-${arm}-${state}.png`,
            clip: { x: tray.x + tray.width / 2 - 140, y: tray.y - 12, width: 280, height: 52 },
          });
          await page.close();
        }
    expect(true).toBe(true);
  });
});
