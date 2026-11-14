// cmux-web-test-timeout: 240
// l10n-allow-file: test fixture prompts and replies, not shipped UI.
// History stays still when a turn ends. Inside the ending turn, Worked for always closes
// (Lucas, 2026-11-11); over work the reader scrolled up into, once they are back at the latest row
// (cmux#24569), so nothing they read folds away under them. Substantive findings
// remain visible (Leo, 2026-11-13: "a message was folded i think erroneously").
// The history-only no-shift rule came from Leo, 2026-11-03:
// "sometimes when an agent completes a message while im scrolled up the entire chat kinda
// hitches/shifts a bit? or the tool calls collpase then expand some messages? idk but it shouldnt
// realy move i think"). The "no layout shift" budget: away from the bottom, the turn's end (its
// "Worked for" fold, its footer, its rows turning final) keeps historical rows on their pixels.
// Work rows inside the ending turn leave the view; findings and the final reply stay outside its fold.
//
// Every visible row's box is read on every painted frame from just before the turn ends until the
// view settles, and scored with the shared box-shift measure (src/gallery/shift.ts, CLS-style: the
// moved area's share of the view times the move's share of the view's longer side).
//
// The page is the pane's dev entry with its browser host, talking JSON-RPC to a stand-in acpmux.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import path from "node:path";
import { chromium, webkit, type Browser, type BrowserType, type Page } from "playwright";
import { scoreBoxFrames, type BoxFrame } from "../src/gallery/shift";
import { installPaintedFrames } from "./support/paintedFrames";
import { requireBrowserLane } from "./support/requireBrowserLane";
import { warmViteServer } from "./support/warmDevServer";

await requireBrowserLane("agent-pane-turn-end-keeps-place.test.ts", async () => {
  setDefaultTimeout(200_000);
  const engines: [string, BrowserType][] = [];
  for (const engine of [
    ["chromium", chromium],
    ["webkit", webkit],
  ] as [string, BrowserType][]) {
    try {
      await (await engine[1].launch({ headless: true })).close();
      engines.push(engine);
    } catch {
      console.warn(
        `agent-pane-turn-end-keeps-place: skipping ${engine[0]} (run \`bunx playwright install ${engine[0]}\`)`,
      );
    }
  }
  if (engines.length === 0) {
    describe.skip("turn end keeps place", () => test("no engine", () => {}));
    return;
  }
  const { createServer } = await import("vite");
  const webviews = path.resolve(import.meta.dir, "..");

  const SESSION = "0190a000-0000-7000-8000-0000000000e7";
  let status = "running";
  let family = "codex";
  const summary = () => ({
    sessionId: SESSION,
    cwd: "/home/dev/sun",
    title: "Retry policy",
    harness: "claude",
    // A finished turn folds its work under one Worked for: the Codex family's fold (turns.ts).
    family,
    status,
    steering: true,
    queuePaused: false,
    queued: 0,
    queue: [],
    turnCount: 9,
    updatedAt: Date.now(),
  });
  const update = (body: Record<string, unknown>) => ({
    method: "session/update",
    params: { sessionId: "agent-1", update: body },
  });
  const chunk = (text: string) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const ran = (id: string, status = "completed") =>
    update({
      sessionUpdate: "tool_call",
      toolCallId: id,
      title: `rg retry ${id}`,
      kind: "execute",
      status,
      rawInput: { command: `rg retry ${id}` },
    });
  type Event = { sessionId: string; seq: number; at: number; dir: string; kind: string; msg: Record<string, unknown> };
  const events: Event[] = [];
  const record = (dir: string, kind: string, msg: Record<string, unknown>): Event => {
    const event = { sessionId: SESSION, seq: events.length + 1, at: Date.now(), dir, kind, msg };
    events.push(event);
    return event;
  };
  // Finished turns above, so the reader can be scrolled into history too.
  for (let turn = 0; turn < 8; turn++) {
    record("mux", "user_message", { text: `Check step ${turn + 1} of the retry plan`, promptId: `p-${turn}` });
    record("mux", "turn_started", {});
    record(
      "in",
      "agent_message_chunk",
      chunk(
        `Step ${turn + 1}: the client waits longer before each retry, capped at eight seconds, and stops ` +
          "after five attempts. The fetch tests cover a server that fails twice and then answers.",
      ),
    );
    record("mux", "turn_result", { status: "completed" });
  }
  // The running turn: notes and tool calls, taller than the view.
  record("mux", "user_message", { text: "Find every retry loop and fix the cap", promptId: "p-live" });
  record("mux", "turn_started", {});
  for (let step = 0; step < 14; step++) {
    record(
      "in",
      "agent_message_chunk",
      chunk(
        `Checking call site ${step + 1}: it retries on every error, so the cap has to apply here as well. ` +
          "The loop sleeps a fixed second between attempts and never gives up, which is what made the upload " +
          "queue hammer the server during the outage last week.\n\n",
      ),
    );
    record("in", "tool_call", ran(`t${step}`));
  }
  /// The running turn's live line, the last row while it runs.
  const LIVE = "[data-row-id='thinking-live']";
  const opened = events.length;
  const REPLY =
    "Every retry loop now shares one capped backoff. The fetch client, the socket reconnect and the upload " +
    "queue each called their own sleep; they now call `backoff(attempt)`, which stops at eight seconds.\n\n" +
    "- fetch client\n- socket reconnect\n- upload queue\n\nFinal reply marker.";

  function answer(method: string): unknown {
    switch (method) {
      case "initialize":
        return { protocolVersion: 1, _meta: { acpmux: { origin: "local", extensions: [], operations: [] } } };
      case "_acpmux/watch":
        return { sessions: [summary()] };
      case "_acpmux/attach":
        return { session: summary(), lastSeq: opened, events: events.slice(0, opened) };
      case "_acpmux/events":
        return { events: [], hasMore: false, lastSeq: events.length };
      default:
        return null;
    }
  }

  let socket: { send(data: string): void } | undefined;
  const emit = (dir: string, kind: string, msg: Record<string, unknown>) =>
    socket?.send(JSON.stringify({ jsonrpc: "2.0", method: "_acpmux/event", params: record(dir, kind, msg) }));
  const changed = () =>
    socket?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "_acpmux/session_changed",
        params: { sessionId: SESSION, session: summary(), kind: "status", seq: events.length },
      }),
    );

  let daemon: ReturnType<typeof Bun.serve> | undefined;
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  const browsers = new Map<string, Browser>();
  beforeAll(async () => {
    daemon = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, server) {
        return server.upgrade(request, { data: undefined }) ? undefined : new Response("acpmux", { status: 426 });
      },
      websocket: {
        message(ws, raw) {
          const message = JSON.parse(String(raw)) as { id?: number; method: string };
          if (message.method === "_acpmux/attach") socket = ws;
          if (message.id !== undefined)
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer(message.method) }));
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
    for (const [name, engine] of engines) browsers.set(name, await engine.launch({ headless: true }));
    // A cold dev server's first load can run Vite's dependency optimizer and reload mid-compile.
    for (const browser of browsers.values()) {
      for (let attempt = 1; ; attempt++) {
        const warm = await browser.newPage();
        try {
          await warm.goto(url());
          await warm.locator(LIVE).waitFor({ timeout: 25_000 });
          await warm.close();
          break;
        } catch (error) {
          await warm.close();
          if (attempt === 3) throw error;
        }
      }
    }
  });
  afterAll(async () => {
    for (const browser of browsers.values()) await browser.close();
    await vite?.close();
    await daemon?.stop(true);
  });

  const url = () => {
    const { port } = vite!.httpServer!.address() as { port: number };
    const endpoint = `ws://127.0.0.1:${daemon!.port}/`;
    return `http://127.0.0.1:${port}/#endpoint=${encodeURIComponent(endpoint)}&token=t&session=${SESSION}`;
  };

  /// Resolves once the transcript's offset and height have held, with nothing in it animating, for
  /// 12 painted frames.
  const rest = (page: Page) =>
    page.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>(".acpmux-scroll")!;
      const moving = () =>
        document
          .getAnimations()
          .some(
            (animation) =>
              animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming().endTime),
          );
      let last = "";
      for (let held = 0, frames = 0; held < 12 && frames < 600; frames += 1) {
        await window.cmuxPaintFrame();
        const now = `${scroller.scrollTop}:${scroller.scrollHeight}`;
        held = now === last && !moving() ? held + 1 : 0;
        last = now;
      }
    });

  type Sample = { id: string; x: number; y: number; width: number; height: number };
  /// Starts sampling every row box that shows in the transcript's view, once per painted frame, in
  /// the view's own coordinates.
  const startSampling = (page: Page) =>
    page.evaluate(() => {
      const w = window as unknown as { __rowFrames: Sample[][]; __stopRows: () => void };
      w.__rowFrames = [];
      const scroller = document.querySelector<HTMLElement>(".acpmux-scroll")!;
      const read = () => {
        const view = scroller.getBoundingClientRect();
        const frame: Sample[] = [];
        for (const row of scroller.querySelectorAll<HTMLElement>("[data-row-id]")) {
          const box = row.getBoundingClientRect();
          if (box.height <= 0 || box.bottom <= view.top || box.top >= view.bottom) continue;
          frame.push({
            id: row.dataset.rowId!,
            x: box.x - view.x,
            y: box.y - view.y,
            width: box.width,
            height: box.height,
          });
        }
        w.__rowFrames.push(frame);
      };
      read();
      let on = true;
      w.__stopRows = () => (on = false);
      window.cmuxAfterPaint(() => {
        if (!on) return false;
        read();
        return true;
      });
    });
  const stopSampling = (page: Page) =>
    page.evaluate(() => {
      const w = window as unknown as { __rowFrames: Sample[][]; __stopRows: () => void };
      w.__stopRows();
      return {
        frames: w.__rowFrames,
        view: (() => {
          const box = document.querySelector<HTMLElement>(".acpmux-scroll")!.getBoundingClientRect();
          return { width: box.width, height: box.height };
        })(),
      };
    });

  /// The shift a run of frames shows: the CLS-style score, how far the first row in sight at the
  /// start moved at most, and the rows that folded away and came back (a height that drops and
  /// returns, or a row that leaves the view and returns, within the run).
  const measure = (frames: Sample[][], view: { width: number; height: number }) => {
    const ids = new Map<string, number>();
    const boxFrames: BoxFrame[] = frames.map(
      (frame) =>
        new Map(
          frame.map((row) => {
            if (!ids.has(row.id)) ids.set(row.id, ids.size + 1);
            return [ids.get(row.id)!, { box: row, label: `row ${row.id}` }] as const;
          }),
        ),
    );
    const shift = scoreBoxFrames(boxFrames, view, { restedAtStart: true });
    const first = [...frames[0]!].sort((a, b) => a.y - b.y).find((row) => row.y + row.height > 0)!;
    let maxMove = 0;
    for (const frame of frames) {
      const now = frame.find((row) => row.id === first.id);
      maxMove = Math.max(maxMove, now ? Math.abs(now.y - first.y) : Infinity);
    }
    const flickers: string[] = [];
    for (const id of ids.keys()) {
      const heights = frames.map((frame) => frame.find((row) => row.id === id)?.height ?? 0);
      const start = heights[0]!;
      if (start <= 0) continue;
      const dropped = heights.findIndex((height) => height < start - 1);
      if (dropped >= 0 && heights.slice(dropped).some((height) => Math.abs(height - start) <= 1))
        flickers.push(`${id} (${start}px -> ${heights[dropped]}px at frame ${dropped})`);
    }
    // Rows the reader had in view that the view no longer draws (a fold closed over them).
    const last = new Set(frames.at(-1)!.map((row) => row.id));
    const lost = frames[0]!.filter((row) => !last.has(row.id)).map((row) => row.id);
    return { score: shift.score, moves: shift.moves, first: first.id, maxMove, flickers, lost };
  };

  /// The call a reader scrolled into the running turn has in view (after "Checking call site 7").
  const MID = "t6";
  const midCall = events.findIndex(
    (event) =>
      event.kind === "tool_call" && (event.msg.params as { update: { toolCallId: string } }).update.toolCallId === MID,
  );
  async function open(name: string, midRunning = false) {
    events.length = opened;
    status = "running";
    // A command in an earlier run that still runs (a parallel `cp` while later calls go on): the
    // live line names it, and its run draws no row for it (turns.ts `codexRuns`, `lineCall`).
    events[midCall] = { ...events[midCall]!, msg: ran(MID, midRunning ? "in_progress" : "completed") };
    const page = await browsers.get(name)!.newPage({ viewport: { width: 900, height: 640 } });
    await installPaintedFrames(page);
    await page.goto(url());
    await page.locator(LIVE).waitFor();
    await page.mouse.move(0, 0);
    await rest(page);
    // The reply streams in while the reader is at the end, before they scroll up.
    emit("in", "agent_message_chunk", chunk(REPLY));
    await page.getByText("Final reply marker.").waitFor();
    await rest(page);
    return page;
  }

  const endTurn = async (page: Page, sample = true) => {
    if (sample) await startSampling(page);
    status = "idle";
    emit("mux", "turn_result", { status: "completed" });
    changed();
    await page.locator(".acpmux-scroll [data-row-id]").first().waitFor();
    // The footer, the fold and the rows' final heights land over the next frames.
    await rest(page);
    await page.evaluate(async () => {
      for (let frame = 0; frame < 30; frame++) await window.cmuxPaintFrame();
    });
    await rest(page);
    const { frames, view } = await stopSampling(page);
    return measure(frames, view);
  };

  /// The gap between the newest row's line (its footer's action row once the turn ended) and the top
  /// of the bottom stack, as agent-pane-composer-rest-gap.test.ts reads it.
  const restGap = (page: Page) =>
    page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".acpmux-scroll")!;
      const dock = document.querySelector<HTMLElement>(".acpmux-dock")!;
      const rows = [...scroller.querySelectorAll<HTMLElement>(".acpmux-row")];
      const newest = rows.reduce<HTMLElement | undefined>(
        (a, b) => (!a || Number(b.getAttribute("aria-posinset")) > Number(a.getAttribute("aria-posinset")) ? b : a),
        undefined,
      )!;
      const drawn = rows.filter((row) => row.getBoundingClientRect().height > 0);
      const last = drawn.reduce((a, b) =>
        Number(b.getAttribute("aria-posinset")) > Number(a.getAttribute("aria-posinset")) ? b : a,
      );
      const actions = newest.querySelector(".cv-turn-actions");
      const bottom =
        newest !== last && newest.getBoundingClientRect().height === 0 && actions
          ? actions.getBoundingClientRect().bottom
          : last.getBoundingClientRect().bottom;
      const parts = [...dock.children].flatMap((part) =>
        part.classList.contains("acpmux-composer") ? [...part.children] : [part],
      );
      const top = Math.min(
        ...parts.map((part) => part.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.top),
      );
      const fromEnd = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      return {
        gap: Math.round((top - bottom) * 10) / 10,
        fromEnd,
        newest: newest.dataset.rowId,
        last: last.dataset.rowId,
        lastText: (last.textContent ?? "").slice(-60),
      };
    });

  for (const fam of ["codex", "claude"]) test.each(engines.map(([name]) => name))(
    `%s: probe: a ${fam} turn that ends while the reader follows the latest row`,
    async (name) => {
      family = fam;
      const page = await open(name);
      const before = await restGap(page);
      const replyId = await page
        .locator("[data-row-id]", { hasText: "Final reply marker." })
        .last()
        .getAttribute("data-row-id");
      await startSampling(page);
      const result = await endTurn(page, false);
      const after = await restGap(page);
      const raw = await page.evaluate(
        () => (window as unknown as { __rowFrames: { id: string; y: number; height: number }[][] }).__rowFrames,
      );
      const track = (pick: (frame: { id: string; y: number; height: number }[]) => string) =>
        raw
          .map((frame, i) => `${i}:${pick(frame)}`)
          .filter((entry, i, all) => i === 0 || entry.split(":")[1] !== all[i - 1]!.split(":")[1])
          .slice(0, 40)
          .join(" ");
      console.log(`${name} ${fam} PROBE reply ${replyId} y: ${track((f) => String(Math.round(f.find((r) => r.id === replyId)?.y ?? -1)))}`);
      console.log(
        `${name} ${fam} PROBE rows: ${track((f) => f.map((r) => `${r.id}@${Math.round(r.y)}/${Math.round(r.height)}`).join(","))}`,
      );
      console.log(
        `${name} ${fam} PROBE before ${JSON.stringify(before)} after ${JSON.stringify(after)} shift score ${result.score}, first row ${result.first} moved ${result.maxMove}px, lost ${JSON.stringify(result.lost)}, flickers ${JSON.stringify(result.flickers)}, moves ${JSON.stringify(result.moves.slice(0, 12))}`,
      );
      await page.close();
    },
  );
});
