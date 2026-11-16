// cmux-web-test-timeout: 600
// l10n-allow-file: probe
import { afterAll, beforeAll, describe, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { turnReplies } from "../src/agent-session/acpmux/conversation/repliesDrawn";
import { installPaintedFrames } from "./support/paintedFrames";
import { requireBrowserLane } from "./support/requireBrowserLane";
import { warmViteServer } from "./support/warmDevServer";

await requireBrowserLane("probe-sr2-browser.test.ts", async () => {
  setDefaultTimeout(580_000);
  try {
    await (await chromium.launch({ headless: true })).close();
  } catch {
    describe.skip("probe", () => test("chromium", () => {}));
    return;
  }
  const { createServer } = await import("vite");
  const webviews = path.resolve(import.meta.dir, "..");
  const SESSION = "01a18a35-b1e8-7951-ba2f-703bf916b9a6";
  type Event = { sessionId: string; seq: number; at: number; dir: string; kind: string; msg: any };
  const all: Event[] = readFileSync(
    path.join(webviews, "src/agent-session/acpmux/conversation/fixtures/sr2-all-3590000.ndjson"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => ({ ...JSON.parse(line), sessionId: SESSION }));
  const SPLIT = 3591990;
  const replies = turnReplies(all as never).filter((reply) => reply.startSeq >= SPLIT);
  console.log("EXPECT", replies.map((r) => `${r.startSeq} ${r.segment} len=${r.text.length}`).join(" | "));
  let events: Event[] = [];
  let status = "idle";
  const summary = () => ({
    sessionId: SESSION,
    cwd: "/mock/project",
    title: "sr2",
    harness: "claude",
    status,
    steering: true,
    queuePaused: false,
    queued: 0,
    queue: [],
    turnCount: 50,
    createdAt: 1_794_000_000_000,
    updatedAt: events.at(-1)?.at ?? 1_794_000_000_000,
  });
  const page = (params: Record<string, any>, attach: boolean) => {
    const after = Number(params.afterSeq ?? 0);
    const before = params.beforeSeq === undefined ? Infinity : Number(params.beforeSeq);
    const newest = params.beforeSeq !== undefined || (attach && params.afterSeq === undefined);
    const limit = params.limit === undefined ? Infinity : Math.max(1, Number(params.limit));
    const maxBytes = params.maxBytes === undefined ? Infinity : Number(params.maxBytes);
    const out: Event[] = [];
    let bytes = 0;
    let hasMore = false;
    const take = (event: Event) => {
      if (event.seq <= after || event.seq >= before) return true;
      if (out.length >= limit) return !(hasMore = true);
      bytes += JSON.stringify(event.msg).length + event.kind.length + 120;
      if (out.length > 0 && bytes > maxBytes) return !(hasMore = true);
      out.push(event);
      return true;
    };
    if (newest) {
      for (let i = events.length - 1; i >= 0 && take(events[i]!); i -= 1);
      out.reverse();
    } else for (let i = 0; i < events.length && take(events[i]!); i += 1);
    return { events: out, hasMore };
  };
  function answer(method: string, params: Record<string, any>): unknown {
    switch (method) {
      case "initialize":
        return { protocolVersion: 1, _meta: { acpmux: { origin: "local", extensions: [], operations: [] } } };
      case "_acpmux/watch":
        return { sessions: [summary()] };
      case "_acpmux/attach": {
        const p = page(params, true);
        const last = events.at(-1)?.seq ?? 0;
        return { session: summary(), ...p, lastSeq: last, pageThrough: last, turnOpener: null };
      }
      case "_acpmux/events":
        return { ...page(params, false), lastSeq: events.at(-1)?.seq ?? 0 };
      default:
        return null;
    }
  }
  let daemon: ReturnType<typeof Bun.serve> | undefined;
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Browser | undefined;
  const sockets = new Set<any>();
  const url = () => {
    const { port } = vite!.httpServer!.address() as { port: number };
    const endpoint = `ws://127.0.0.1:${daemon!.port}/`;
    return `http://127.0.0.1:${port}/#endpoint=${encodeURIComponent(endpoint)}&token=t&session=${SESSION}`;
  };
  beforeAll(async () => {
    daemon = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, server) {
        return server.upgrade(request, { data: undefined }) ? undefined : new Response("acpmux", { status: 426 });
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
        },
        close(ws) {
          sockets.delete(ws);
        },
        message(ws, raw) {
          const message = JSON.parse(String(raw)) as { id?: number; method: string; params?: Record<string, any> };
          if (message.id === undefined) return;
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer(message.method, message.params ?? {}) }));
        },
      },
    });
    vite = await createServer({
      configFile: path.join(webviews, "vite.config.acpmux-pane.mjs"),
      server: { port: 0, host: "127.0.0.1", strictPort: false },
      logLevel: "error",
    });
    await vite.listen();
    await warmViteServer(vite, "/");
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    await daemon?.stop(true);
  });
  const frames = (p: Page, count: number) =>
    p.evaluate(async (n) => {
      for (let i = 0; i < n; i++) await window.cmuxPaintFrame();
    }, count);
  const bottom = (p: Page) =>
    p.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".acpmux-scroll")!;
      const box = scroller.getBoundingClientRect();
      return [...scroller.querySelectorAll<HTMLElement>("article.acpmux-row[data-row-id]")]
        .filter((node) => {
          const r = node.getBoundingClientRect();
          return r.height > 0 && r.bottom > box.top && r.top < box.bottom;
        })
        .map(
          (node) =>
            `${node.dataset.rowId} h=${Math.round(node.getBoundingClientRect().height)} t=${(node.textContent ?? "").length} buttons=[${[
              ...node.querySelectorAll("button"),
            ]
              .map((b) => b.getAttribute("aria-label") ?? (b.textContent ?? "").slice(0, 12))
              .join(",")}] :: ${(node.textContent ?? "").slice(0, 60).replace(/\s+/g, " ")}`,
        );
    });
  const rowText = (p: Page, id: string) =>
    p.evaluate((rowId) => {
      const node = document.querySelector<HTMLElement>(`article.acpmux-row[data-row-id="${CSS.escape(rowId)}"]`);
      return node ? (node.textContent ?? "").length : -1;
    }, id);

  for (const scrolledUp of [false, true])
    test(`stream the incident, scrolledUp=${scrolledUp}`, async () => {
      events = all.filter((event) => event.seq < SPLIT);
      status = "idle";
      const p = await browser!.newPage({ viewport: { width: 1000, height: 1100 } });
      const errors: string[] = [];
      p.on("pageerror", (error) => errors.push(String(error)));
      p.on("console", (msg) => {
        if (msg.type() === "error" || msg.type() === "warning") errors.push(`${msg.type()}: ${msg.text().slice(0, 300)}`);
      });
      try {
        await installPaintedFrames(p);
        await p.goto(url());
        await p.locator(".acpmux-row").first().waitFor({ timeout: 60_000 });
        await frames(p, 30);
        if (scrolledUp) {
          await p.mouse.move(500, 500);
          for (let i = 0; i < 6; i++) {
            await p.mouse.wheel(0, -600);
            await frames(p, 6);
          }
        }
        const live = all.filter((event) => event.seq >= SPLIT);
        let sent = 0;
        for (const event of live) {
          events.push(event);
          if (event.kind === "turn_started") status = "running";
          if (event.kind === "turn_result") status = "idle";
          const note = JSON.stringify({ jsonrpc: "2.0", method: "_acpmux/event", params: event });
          for (const ws of sockets) ws.send(note);
          sent += 1;
          if (sent % 25 === 0) await frames(p, 1);
          if (event.kind === "turn_result") {
            await frames(p, 40);
            const reply = replies.find((r) => r.endSeq <= event.seq && r.endSeq >= event.seq - 3);
            const length = reply ? await rowText(p, `assistant-${reply.segment}`) : -2;
            console.log(
              `TURN END ${event.seq} reply=${reply?.segment} expected=${reply?.text.length} domText=${length}`,
            );
            if (!scrolledUp || event.seq === live.at(-1)!.seq) console.log((await bottom(p)).join("\n"));
          }
        }
        if (scrolledUp) {
          await p.evaluate(() => {
            const scroller = document.querySelector<HTMLElement>(".acpmux-scroll")!;
            scroller.scrollTop = scroller.scrollHeight;
          });
          await frames(p, 60);
          console.log("AFTER SCROLL DOWN\n" + (await bottom(p)).join("\n"));
          for (const reply of replies.slice(-2))
            console.log(`FINAL ${reply.segment} expected=${reply.text.length} domText=${await rowText(p, `assistant-${reply.segment}`)}`);
        }
        console.log("PAGE ERRORS", errors.slice(0, 20).join("\n"));
      } finally {
        await p.close();
      }
    });
});
