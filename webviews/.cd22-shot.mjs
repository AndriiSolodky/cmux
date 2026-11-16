import { chromium } from "playwright";
const out = process.argv[2];
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 720, height: 520 }, deviceScaleFactor: 2, colorScheme: "dark" });
const result = {};
for (const variant of ["turn", "block", "tail"]) {
  await page.goto(`http://127.0.0.1:4200/gallery/frame.html?entry=agent-pane.woken-turn-gap&variant=${variant}&scheme=dark`, { waitUntil: "load" });
  await page.waitForFunction(() => document.documentElement.dataset.galleryReady === "true" || document.documentElement.dataset.galleryReady === "error", null, { timeout: 60000 }).catch(() => {});
  await page.waitForSelector(".acpmux-turnSummary", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  result[variant] = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".acpmux-row")];
    const box = (el) => el.getBoundingClientRect();
    const read = rows.find((r) => r.textContent.includes("b9yur0qrw"));
    const idx = rows.indexOf(read);
    const above = rows[idx - 1];
    return { ready: document.documentElement.dataset.galleryReady, rows: rows.length, gap: read && above ? box(read).top - box(above).bottom : null, aboveClass: above?.className };
  });
  await page.screenshot({ path: `${out}/${variant}.png` });
}
console.log(JSON.stringify(result));
await browser.close();
