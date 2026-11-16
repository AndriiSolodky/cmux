// l10n-allow-file: proof script, not shipped UI.
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { chromium } from "playwright";
import { galleryFrame, warmGalleryFrame } from "./support/galleryFrame";
import { warmViteServer } from "./support/warmDevServer";

const label = process.env.PROOF_LABEL ?? "tree";
const root = path.join(process.env.FAST_CHECKS_OUT ?? "/tmp/proof", label);
mkdirSync(root, { recursive: true });
const { createServer } = await import("vite");
const webviews = path.resolve(import.meta.dir, "..");
const vite = await createServer({
  root: webviews,
  configFile: path.join(webviews, "vite.config.ts"),
  server: { port: 0, host: "127.0.0.1", strictPort: false },
  logLevel: "error",
});
await vite.listen();
const port = (vite.httpServer!.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
await warmViteServer(vite, "/test/browser/transcript-follow.html");
const browser = await chromium.launch({ headless: true });
const report: Record<string, unknown> = {};

const OUTLINE = "outline:2px solid #ff2d55;outline-offset:-1px;background:rgba(255,45,85,.10)";

// ---- Part A: the harness sequence, video + per-step stills
{
  const context = await browser.newContext({
    viewport: { width: 900, height: 640 },
    recordVideo: { dir: path.join(root, "video-tmp"), size: { width: 900, height: 640 } },
  });
  const page = await context.newPage();
  await page.goto(`${base}/test/browser/transcript-follow.html`);
  await page.waitForFunction(() => "__showLiveRows" in window);
  await page.evaluate(() => (window as any).__loadStrings());
  // build steps inside page so Date.now is page time
  const stepCount = 7;
  const trace: any[] = [];
  const shots: string[] = [];
  for (let s = 0; s < stepCount; s++) {
    const m = await page.evaluate(async (s) => {
      const sent = Date.now() - 30_000;
      const user = { id: "u", kind: "user", version: 1, at: sent, text: "Find every retry loop and fix the cap." };
      const earlier = { id: "a0", kind: "assistant", version: 1, at: sent + 500, text: Array.from({ length: 40 }, (_, i) => `Call site ${i + 1} retries on every error and sleeps a fixed second between attempts, so the cap has to apply here as well.`).join("\n\n") };
      const call = (id: string) => ({ kind: "tool", text: "", tool: { id, title: `rg retry ${id}`, kind: "execute", status: "completed", command: `rg retry ${id}`, startedAt: sent + 1000 } });
      const run = (id: string, at: number, calls: string[]) => ({ id, kind: "activity", version: 1, at, items: calls.map(call) });
      const reply = (id: string, at: number, text: string) => ({ id, kind: "assistant", version: 1, at, text });
      const steps: Array<[string, any[]]> = [];
      const rows: any[] = [user, earlier];
      steps.push(["reply", [...rows]]);
      for (let i = 0; i < 3; i++) {
        rows.push(run(`r${i}`, sent + 2000 + i * 2000, [`c${i}a`, `c${i}b`]));
        steps.push(["run", [...rows]]);
        rows.push(reply(`a${i + 1}`, sent + 3000 + i * 2000, `Call site ${i + 15} also retries.`));
        steps.push(["reply", [...rows]]);
      }
      (window as any).__showLiveRows(steps[s]![1]);
      await new Promise((r) => setTimeout(r, 900));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const scroller = document.querySelector<HTMLElement>(".acpmux-scroll")!;
      const line = document.querySelector<HTMLElement>('[data-row-id="thinking-live"]')!;
      const words = line.querySelector<HTMLElement>(".cv-thinking")!;
      const prev = line.previousElementSibling as HTMLElement;
      const v = scroller.getBoundingClientRect(), b = line.getBoundingClientRect(), p = prev.getBoundingClientRect();
      return {
        kind: steps[s]![0], over: prev.dataset.rowId,
        boxHeight: Math.round(b.height * 10) / 10, gapAbove: Math.round((b.top - p.bottom) * 10) / 10,
        boxTopFromViewBottom: Math.round((v.bottom - b.top) * 10) / 10,
        wordsFromViewBottom: Math.round((v.bottom - words.getBoundingClientRect().bottom) * 10) / 10,
      };
    }, s);
    trace.push({ step: s, ...m });
    await page.evaluate(() => { const l = document.querySelector<HTMLElement>('[data-row-id="thinking-live"]')!; l.setAttribute("style", (l.getAttribute("style") ?? "") + ";" + "outline:2px solid #ff2d55;outline-offset:-1px;background:rgba(255,45,85,.10)"); });
    const file = path.join(root, `harness-step${s}-${m.kind}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: 340, width: 900, height: 300 } });
    shots.push(file);
    await page.waitForTimeout(500);
  }
  report.harness = trace;
  const videoPath = await page.video()!.path();
  await context.close();
  renameSync(videoPath, path.join(root, `live-turn-${label}.webm`));

  // frame strip
  const sp = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  const cells = shots.map((f, i) => `<figure style="margin:0"><img src="data:image/png;base64,${readFileSync(f).toString("base64")}" style="width:430px;display:block;border:1px solid #888"/><figcaption style="font:13px system-ui">${i}: ${trace[i].kind} over ${trace[i].over} - box ${trace[i].boxHeight}px, gap ${trace[i].gapAbove}px</figcaption></figure>`).join("");
  await sp.setContent(`<body style="margin:12px;background:#fff"><h3 style="font:600 18px system-ui">${label}: live line (red) as run/reply rows land over it</h3><div style="display:grid;grid-template-columns:repeat(4,430px);gap:12px">${cells}</div></body>`);
  await sp.screenshot({ path: path.join(root, `strip-${label}.png`), fullPage: true });
  await sp.close();
}

// ---- Part B: gallery variants
const variants: Array<[string, string]> = [
  ["agent-pane.transcript", "codex-turn-raw-commands"],
  ["agent-pane.transcript-spacing-table", "working-bottom"],
  ["agent-pane.transcript-spacing-table", "reply-received"],
  ["agent-pane.transcript-spacing-table", "notes-live"],
];
report.gallery = {};
for (const [entry, variant] of variants) {
  try {
    await warmGalleryFrame(vite, entry, { browser, timeoutMs: 110_000 });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.goto(`${base}${galleryFrame(entry, { variant, reducedMotion: 1 })}`);
    await page.waitForFunction(() => document.documentElement.dataset.galleryReady === "1", undefined, { timeout: 60_000 });
    await page.waitForSelector(".cv-thinking", { timeout: 30_000 });
    await page.waitForTimeout(800);
    const m = await page.evaluate(() => {
      const words = document.querySelector<HTMLElement>(".cv-thinking")!;
      const line = (words.closest(".cv-worked.is-below, [data-row-id='thinking-live']") ?? words.parentElement) as HTMLElement;
      const b = line.getBoundingClientRect();
      const over = [...document.querySelectorAll(".cv-tool, .cv-msgline__preview, .cv-md, .cv-sent, .cv-worked")].filter((n) => n !== line && !line.contains(n) && n.getBoundingClientRect().bottom <= b.top + 1);
      const nearest = over.length ? Math.max(...over.map((n) => n.getBoundingClientRect().bottom)) : NaN;
      line.setAttribute("style", (line.getAttribute("style") ?? "") + ";outline:2px solid #ff2d55;outline-offset:-1px;background:rgba(255,45,85,.10)");
      line.scrollIntoView({ block: "end" });
      return { selector: line.className || line.dataset.rowId, boxHeight: Math.round(b.height * 10) / 10, gapAbove: Math.round((b.top - nearest) * 10) / 10 };
    });
    await page.screenshot({ path: path.join(root, `gallery-${variant}-${label}.png`) });
    (report.gallery as any)[variant] = m;
    await page.close();
  } catch (e) {
    (report.gallery as any)[variant] = { error: String(e).slice(0, 300) };
  }
}
writeFileSync(path.join(root, `report-${label}.json`), JSON.stringify(report, null, 1));
console.log("REPORT " + label + " " + JSON.stringify(report));
await browser.close();
await vite.close();
process.exit(0);
