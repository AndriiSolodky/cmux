// Leo, 2026-11-14: "picture dimensions were forgotten then reloaded. this is another cause of
// layout shift". A sent prompt's image drew as a 120 px square slot while the pane read its bytes
// back from acpmux, then the bubble took the image's real shape (his 1280x228 screenshot: a
// 320x57 strip), moving everything under it, on every history load, scroll-back, re-mount and
// restart. acpmux now records each image's pixel size with the prompt (hub/image_size.rs), and
// sends an older record with its kept image's size, so the bubble's first frame is its last.
//
// The page mounts the real UserBubble, with the real stylesheets, from the record acpmux writes
// for that prompt (cmux-tui/crates/acpmux/src/hub/image_size_fixture.json, which
// image_size_tests.rs checks against acpmux field for field), read through the pane's own record
// parser (inlinePrompt.ts recordedPromptParts). The image's bytes come 400 ms late, as a read over
// the daemon socket does; the bubble's height on its first frame must equal its height once the
// image has drawn: on first mount, on a re-mount (the virtual list scrolling it back), and on a
// mount with every image the pane held forgotten (an app restart or update).
//
// Real Chromium from Playwright; CI fails the file when it cannot launch (requireBrowserLane).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { requireBrowserLane } from "./support/requireBrowserLane";

await requireBrowserLane("chat-image-first-frame-browser.test.ts", async () => {
  setDefaultTimeout(90_000);
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    console.warn("chat-image-first-frame-browser: skipping (run `bunx playwright install chromium`)");
    describe.skip("chat image first frame", () => test("chromium", () => {}));
    return;
  }
  const webviews = path.resolve(import.meta.dir, "..");
  const src = path.join(webviews, "src");
  const fixturePath = path.resolve(webviews, "../cmux-tui/crates/acpmux/src/hub/image_size_fixture.json");
  const record = JSON.parse(await readFile(fixturePath, "utf8")).msg as Record<string, unknown>;
  // Any id: the page's reader answers every image with the same late bytes.
  const id = "a".repeat(64);
  const msg = JSON.parse(JSON.stringify(record).replaceAll("{{id}}", id));

  let scratch = "";
  let server: ReturnType<typeof Bun.serve> | undefined;
  beforeAll(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), "chat-image-first-frame-"));
    const entry = path.join(scratch, "entry.tsx");
    const module = (file: string) => JSON.stringify(path.join(src, "agent-session/acpmux", file));
    await writeFile(
      entry,
      [
        `import { createElement } from "react";`,
        `import { flushSync } from "react-dom";`,
        `import { createRoot } from "react-dom/client";`,
        `import { UserBubble } from ${module("conversation/UserBubble.tsx")};`,
        `import { TurnActionsContext } from ${module("conversation/turnActions.ts")};`,
        `import { clearImageEntries } from ${module("conversation/imageEntries.ts")};`,
        `import { recordedPromptParts } from ${module("inlinePrompt.ts")};`,
        `(window as any).__bubble = { createElement, flushSync, createRoot, UserBubble, TurnActionsContext, clearImageEntries, recordedPromptParts };`,
      ].join("\n"),
    );
    const built = await Bun.build({
      entrypoints: [entry],
      format: "iife",
      target: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!built.success) throw new Error(built.logs.map(String).join("\n"));
    const script = (await Promise.all(built.outputs.filter((o) => o.path.endsWith(".js")).map((o) => o.text()))).join(
      "\n",
    );
    const css = (
      await Promise.all(
        [
          "agent-session/shared/styles.css",
          "agent-session/acpmux/styles.css",
          "agent-session/acpmux/conversation/conversation.css",
        ].map((file) => readFile(path.join(src, file), "utf8")),
      )
    ).join("\n");
    const page =
      `<!doctype html><html><head><style>${css.replaceAll("</style", "<\\/style")}</style></head>` +
      `<body style="margin:0"><div id="chat" style="width:760px;display:flex"></div>` +
      `<script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(page, { headers: { "content-type": "text/html" } }),
    });
  });
  afterAll(async () => {
    await server?.stop(true);
    await browser.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  type Heights = { first: number; painted: number; loaded: number; imageLoaded: boolean };
  /// Mounts the bubble for `msg` three times (fresh, re-mounted, after the pane forgot every image)
  /// and reads its height on the frame that mounts it, on its first painted frame, and once its late
  /// image has drawn.
  async function measure(record: Record<string, unknown>): Promise<Heights[]> {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    try {
      await page.goto(`http://127.0.0.1:${server!.port}/`);
      return await page.evaluate(async (msg) => {
        const b = (window as any).__bubble;
        // The screenshot's bytes: 1280x228, as Leo's "Checking back in 19 min." capture.
        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 228;
        const ink = canvas.getContext("2d")!;
        ink.fillStyle = "#1d1b26";
        ink.fillRect(0, 0, 1280, 228);
        const dataUrl = canvas.toDataURL("image/png");
        const promptImage = () => new Promise<string>((resolve) => setTimeout(() => resolve(dataUrl), 400));
        const row = {
          id: "user-w4",
          version: 1,
          at: 1,
          kind: "user_message",
          text: msg.text,
          images: msg.images,
          inlineParts: b.recordedPromptParts(msg),
        };
        const host = document.getElementById("chat")!;
        const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const height = () => host.getBoundingClientRect().height;
        const drawn = () => {
          const img = host.querySelector<HTMLImageElement>(".cv-user__inline-image img, .cv-user__images img");
          return Boolean(img?.complete && img.naturalWidth);
        };
        const out: { first: number; painted: number; loaded: number; imageLoaded: boolean }[] = [];
        for (const pass of ["fresh", "remount", "restart"]) {
          if (pass === "restart") b.clearImageEntries();
          const slot = document.createElement("div");
          slot.className = "cv-user";
          host.replaceChildren(slot);
          const root = b.createRoot(slot);
          b.flushSync(() =>
            root.render(
              b.createElement(
                b.TurnActionsContext.Provider,
                { value: { promptImage } },
                b.createElement(b.UserBubble, { row, text: msg.text }),
              ),
            ),
          );
          const first = height();
          await frame();
          const painted = height();
          const deadline = performance.now() + 5000;
          while (!drawn() && performance.now() < deadline) await frame();
          await frame();
          await frame();
          out.push({ first, painted, loaded: height(), imageLoaded: drawn() });
          root.unmount();
        }
        return out;
      }, record);
    } finally {
      await page.close();
    }
  }

  test("an image's bubble has its final height on its first frame: mount, re-mount and restart", async () => {
    const passes = await measure(msg);
    const legacy = await measure({
      ...msg,
      images: (msg.images as Record<string, unknown>[]).map(({ width: _w, height: _h, ...image }) => image),
      inlineParts: (msg.inlineParts as Record<string, unknown>[]).map(({ width: _w, height: _h, ...part }) => part),
    });
    // The numbers the PR reports: a record without the size (acpmux before hub/image_size.rs) moves
    // the bubble by this much when the image lands; the record acpmux writes now moves it by 0.
    console.log(
      `chat-image-first-frame: delta px (loaded - first frame), sized record: ${passes
        .map((p) => (p.loaded - p.first).toFixed(1))
        .join(", ")}; unsized record: ${legacy.map((p) => (p.loaded - p.first).toFixed(1)).join(", ")}`,
    );
    for (const [index, pass] of passes.entries()) {
      const name = ["fresh", "remount", "restart"][index];
      expect({ name, imageLoaded: pass.imageLoaded }).toEqual({ name, imageLoaded: true });
      expect({ name, first: pass.first }).toEqual({ name, first: pass.loaded });
      expect({ name, painted: pass.painted }).toEqual({ name, painted: pass.loaded });
    }
  });
});
