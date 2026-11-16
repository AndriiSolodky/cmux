// l10n-allow-file: throwaway experiment, not committed.
import { afterAll, beforeAll, setDefaultTimeout, test } from "bun:test";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { requireBrowserLane } from "./support/requireBrowserLane";
import { warmViteServer } from "./support/warmDevServer";

await requireBrowserLane("zz-origin-variants.test.ts", async () => {
  setDefaultTimeout(280_000);
  const { createServer } = await import("vite");
  const webviews = path.resolve(import.meta.dir, "..");
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Browser | undefined;
  beforeAll(async () => {
    vite = await createServer({
      configFile: path.join(webviews, "vite.config.acpmux-pane.mjs"),
      server: { port: 0, host: "127.0.0.1", strictPort: false },
      logLevel: "error",
    });
    await vite.listen();
    await warmViteServer(vite, "/?mock");
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });
  async function restyled(page: Page, run: () => Promise<unknown>): Promise<number[]> {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await browser!.startTracing(page, { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] });
    await run();
    const trace = JSON.parse((await browser!.stopTracing()).toString()) as { traceEvents: any[] };
    return trace.traceEvents
      .filter((e) => e.name === "UpdateLayoutTree" && (e.ph === "X" || e.ph === "E"))
      .map((e) => Number(e.args?.elementCount ?? e.args?.data?.elementCount ?? 0));
  }
  test("variants", async () => {
    const page = await browser!.newPage({ viewport: { width: 900, height: 760 } });
    const { port } = vite!.httpServer!.address() as { port: number };
    await page.goto(`http://127.0.0.1:${port}/?mock`);
    await page.waitForFunction(() => "cmuxAcpmuxDebug" in window, null, { timeout: 60_000 });
    await page.evaluate(() => (window as any).cmuxAcpmuxDebug.loadSeed(700, { light: true }));
    await page.waitForFunction(() => document.querySelectorAll(".acpmux-scroll .acpmux-row").length > 5);
    await page.evaluate(() => {
      // An unrelated registered, non-inherited property nothing reads.
      (CSS as any).registerProperty({ name: "--zz-probe", syntax: "<length>", inherits: false, initialValue: "0px" });
    });
    const variants: Record<string, string> = {
      noop: "",
      varThread: `t.style.setProperty("--acpmux-scroll-origin", V)`,
      varThreadAgain: `t.style.setProperty("--acpmux-scroll-origin", V)`,
      probeThread: `t.style.setProperty("--zz-probe", V)`,
      translateThread: `t.style.translate = "0 " + V`,
      topThread: `t.style.top = "calc(" + t.style.top + " + 0px)"`,
      varScroller: `s.style.setProperty("--acpmux-scroll-origin", V)`,
      attrThread: `t.setAttribute("data-zz", V)`,
    };
    for (let round = 0; round < 2; round += 1)
      for (const [name, body] of Object.entries(variants)) {
        const value = `${0.25 + round * 0.25 + Object.keys(variants).indexOf(name) * 0.01}px`;
        const counts = await restyled(page, () =>
          page.evaluate(
            async ({ body, value }) => {
              const s = document.querySelector<HTMLElement>(".acpmux-scroll")!;
              const t = s.querySelector<HTMLElement>(".acpmux-thread")!;
              // eslint-disable-next-line no-new-func
              new Function("s", "t", "V", body)(s, t, value);
              void s.scrollTop;
              await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            },
            { body, value },
          ),
        );
        console.log(`ORIGIN-VARIANT ${JSON.stringify({ round, name, total: counts.reduce((a, b) => a + b, 0), counts })}`);
      }
    await page.close();
  });
});
