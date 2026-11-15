// Scratch check for the deck template (not committed). Run from webviews/: bun ../.rich-scratch/deck-check.mjs OUT
import { chromium } from "playwright";
import { statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const out = process.argv[2] || "/tmp/deck-out";
const deck = "file://" + resolve("../cmux-tui/crates/acpmux/skills/cmux-rich-output/templates/deck.html");
const browser = await chromium.launch();
const report = {};
for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(deck);
  await page.screenshot({ path: `${out}/deck-${scheme}-1.png` });
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  report[`${scheme}.count`] = await page.textContent(".deck-count");
  report[`${scheme}.hash`] = await page.evaluate(() => location.hash);
  await page.screenshot({ path: `${out}/deck-${scheme}-3.png` });
  await page.keyboard.press("f");
  await page.waitForTimeout(300);
  report[`${scheme}.presenting`] = await page.evaluate(() => document.documentElement.classList.contains("deck-presenting"));
  await page.screenshot({ path: `${out}/deck-${scheme}-present.png` });
  await page.keyboard.press("Escape");
  if (scheme === "light") {
    const narrow = await ctx.newPage();
    await narrow.setViewportSize({ width: 560, height: 420 });
    await narrow.goto(deck + "#2");
    await narrow.screenshot({ path: `${out}/deck-light-narrow.png` });
    const pdf = await page.pdf({ path: `${out}/deck.pdf`, preferCSSPageSize: true, printBackground: true });
    report.pdfBytes = pdf.length;
    report.pdfPages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
    const t0 = Date.now();
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("text=Export .pptx")]);
    await download.saveAs(`${out}/deck.pptx`);
    report.pptxClickToSaveMs = Date.now() - t0;
    report.pptxBytes = statSync(`${out}/deck.pptx`).size;
    await page.waitForFunction(() => /Saved|failed/.test(document.querySelector(".deck-status").textContent));
    report.pptxStatus = await page.textContent(".deck-status");
    const t1 = Date.now();
    const [again] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("text=Export .pptx")]);
    await again.path();
    report.pptxSecondMs = Date.now() - t1;
    report.countAfterExport = await page.textContent(".deck-count");
  }
  report[`${scheme}.errors`] = errors;
  await ctx.close();
}
await browser.close();
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
