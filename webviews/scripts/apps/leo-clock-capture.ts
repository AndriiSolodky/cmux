// l10n-allow-file: scratch evidence capture (not committed).
// After `bun run gallery:build`: screenshots of each LeoClockPreview variant and a webm per variant.
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { chromium } from "playwright"

const out = path.join(process.env.FAST_CHECKS_OUT!, "leo-clock")
await mkdir(out, { recursive: true })
const gallery = path.resolve(import.meta.dir, "../../dist/gallery")
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const name = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "")
    const file = path.resolve(gallery, name || "index.html")
    if (!file.startsWith(`${gallery}/`)) return new Response("forbidden", { status: 403 })
    const blob = Bun.file(file)
    return (await blob.exists()) ? new Response(blob) : new Response("not found", { status: 404 })
  },
})
const browser = await chromium.launch({ headless: true })
for (const variant of ["analog", "flip", "ring"]) {
  const context = await browser.newContext({
    viewport: { width: 900, height: 760 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    recordVideo: { dir: out, size: { width: 900, height: 760 } },
  })
  const page = await context.newPage()
  page.on("console", (m) => console.log(variant, "console", m.type(), m.text()))
  page.on("pageerror", (e) => console.log(variant, "pageerror", e.message))
  const params = new URLSearchParams({
    entry: "apps.leo-clock-preview",
    variant,
    source: "src/apps/scene/LeoClockPreview.gallery.tsx",
    entryPath: "src/apps/scene/LeoClockPreview.gallery.tsx",
    theme: "Apple System Colors",
    colorScheme: "dark",
    reducedMotion: "false",
    width: "900",
    height: "760",
  })
  await page.goto(`http://127.0.0.1:${server.port}/frame.html?${params}`, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => document.documentElement.dataset.galleryReady === "1", undefined, { timeout: 30_000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: path.join(out, `${variant}.png`) })
  await page.waitForTimeout(variant === "analog" ? 10_500 : 7_500)
  await page.screenshot({ path: path.join(out, `${variant}-later.png`) })
  const video = page.video()
  await context.close()
  if (video) {
    const file = await video.path()
    await Bun.write(path.join(out, `${variant}.webm`), Bun.file(file))
  }
  console.log("captured", variant)
}
await browser.close()
server.stop()
