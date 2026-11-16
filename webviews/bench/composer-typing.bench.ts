// l10n-allow-file: benchmark output, not shipped UI.
// What one keystroke in the agent chat's composer costs, at transcript lengths of 60, 1,500 and 6,000 rows (CMUX-571,
// Leo: "improve performance (chat, everything related)"; Leo, 2026-11-12: long chats must have "no perceivable
// difference"). A key should render the composer and nothing that does not read its text: not the pane root, not the
// transcript, not a row, and its cost should not grow with the transcript.
//
// The real pane (`?mock`: the real direct client against the in-page mock daemon), built as it ships (the server
// setup below). Each length is a light chat
// (`cmuxAcpmuxDebug.loadSeed(turns, { light: true })`), then `--keys` letters typed into the prompt with real key
// events (Playwright's keyboard, `--gap` ms apart, about a fast typist's pace). Per key:
//   renders   `acpmuxPerf.renders`: the pane root (AcpmuxPane), the transcript, the composer, every row and row frame
//   layout    the page's layouts and style recalcs (CDP Performance.getMetrics LayoutCount, RecalcStyleCount)
//   script    main-thread script, layout and style time (ScriptDuration, LayoutDuration, RecalcStyleDuration), ms
//   to_frame  the page's own typingStats (keydown to the next frame, p50 / p95 / max), as the Mac bench reads it
//   key_frame the bench's own keydown-to-next-frame per key (p50 / p95 / max), from an init script's rAF clock
//   longest_task_ms  the longest main-thread task while the keys are typed (PerformanceObserver longtask: 0 when
//             none reached 50 ms), and long_tasks how many did
//   frames_over_16ms  rAF intervals while typing past 20 ms, and frame_gap_max the longest
//   stream    with --modes idle,stream: the same keys while the chat streams a reply (60 deltas/s, a tool call every
//             30), and, with no typing, the composer's renders per streamed event (reply text and tool calls, then a
//             tool's output ticking while another chat changes: debug loadRun and loadTick). A stream event the
//             composer does not show should render it 0 times. The reply comes from the app's mock (one delta per
//             timer, never a catch-up burst).
//   flood     with --modes flood: the same keys while the open chat streams a reply (--flood-chunks, 60
//             agent_message_chunk/s) and a shell call's output grows a line per tool_call_update (--flood-lines,
//             2,000/s, `_meta.terminal_output.data`). The frames are raw JSON strings with increasing
//             `_meta.acpmux.seq`, handed to the client's transport socket `onmessage` a push at a time, as
//             `BridgeSocket.receive` does with the host pacer's push, so receive, parse, reduce and emit are measured.
//             The schedule is fixed: push k goes at k*16 ms from the start and holds exactly the events whose
//             precomputed offsets (i/rate) fall in its slot. A late timer sends the pushes it owes one task at a
//             time, never one bigger burst, so every run gets the same pushes; load_late_pushes counts the late ones.
//             The load starts a second before the warm-up keys and runs until the last key is measured.
//
// Arms (A/B of two source trees in one run): `--arms A=DIR,B=DIR`, each DIR a webviews directory (this one is `.`
// from webviews/; another is a copy of it beside it with its own src, node_modules a symlink to this one's). Each arm
// is built once and served on its own port. Each length and mode runs `--rounds` (default 5 with --arms) rounds; a
// round runs the arms in order then reversed (A B B A), and every run gets a fresh browser process and page. A third
// arm `A'`, the first arm again, gives the noise floor: A' against A is two identical arms measured in the same run
// (`--no-floor` drops it; then a round is A B B A). With it a round is A B A' A' B A, and every other round swaps A
// and A' so both hold the same places. Per arm the summary gives the median and [min-max] over the rounds
// of key_frame and to_frame p50/p95/max, to_listener p95, longest task and long-task count, then each arm's median
// minus the first arm's, and `sep` where the two ranges do not overlap.
//   bun bench/composer-typing.bench.ts [--lengths 60,1500,6000] [--keys 60] [--gap 80] [--modes idle,stream,flood]
//     [--arms A=.,B=../webviews-b] [--rounds 5] [--no-floor] [--flood-chunks 60] [--flood-lines 2000] [--dev] [--profile]
/// <reference types="bun" />
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "./browsers";
import type { Page } from "playwright";
import { warmViteServer } from "../test/support/warmDevServer";

type Mode = "idle" | "stream" | "flood";
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const LENGTHS = (flag("--lengths") ?? "60,1500,6000").split(",").map(Number);
const KEYS = Number(flag("--keys") ?? 60);
const GAP_MS = Number(flag("--gap") ?? 80);
const MODES = (flag("--modes") ?? "idle").split(",") as Mode[];
for (const mode of MODES)
  if (!["idle", "stream", "flood"].includes(mode)) throw new Error(`--modes: unknown mode ${mode}`);
const FLOOD_CHUNKS_PER_S = Number(flag("--flood-chunks") ?? 60);
const FLOOD_LINES_PER_S = Number(flag("--flood-lines") ?? 2000);
/// With --profile: a CPU profile over the typed keys, and the functions with the most time per key (inclusive and self).
const PROFILE = argv.includes("--profile");
const DEV = argv.includes("--dev");
const webviews = path.resolve(import.meta.dir, "..");
const ARMS_FLAG = flag("--arms");
const ARMS = ARMS_FLAG
  ? ARMS_FLAG.split(",").map((entry) => {
      const at = entry.indexOf("=");
      if (at <= 0) throw new Error(`--arms: ${entry} is not NAME=DIR`);
      const dir = path.resolve(webviews, entry.slice(at + 1));
      if (!fs.existsSync(path.join(dir, "vite.config.acpmux-pane.mjs")))
        throw new Error(`--arms: ${dir} is not a webviews directory (no vite.config.acpmux-pane.mjs)`);
      return { name: entry.slice(0, at), dir };
    })
  : [{ name: "this", dir: webviews }];
const ROUNDS = Number(flag("--rounds") ?? (ARMS_FLAG ? 5 : 1));
const FLOOR = !!ARMS_FLAG && !argv.includes("--no-floor");
const PROMPT = ".acpmux-composer-prompt[contenteditable='true'], .acpmux-composer-prompt [contenteditable='true']";
const METRICS = [
  "LayoutCount",
  "RecalcStyleCount",
  "ScriptDuration",
  "LayoutDuration",
  "RecalcStyleDuration",
  "TaskDuration",
] as const;

async function openChat(page: Page, port: number, turns: number) {
  await page.goto(`http://127.0.0.1:${port}/?mock`);
  await page.waitForFunction(() => "cmuxAcpmuxDebug" in window, null, { timeout: 60_000 });
  const seeded = (await page.evaluate(
    (count) => (window as any).cmuxAcpmuxDebug.loadSeed(count, { light: true }),
    turns,
  )) as Record<string, any>;
  if (seeded.error) throw new Error(`loadSeed: ${seeded.error}`);
  await page.locator(PROMPT).first().waitFor({ timeout: 20_000 });
  return { rows: seeded.rows as number, session: seeded.session as string };
}

type Probe = { keys: number[]; frames: number[]; long: { at: number; ms: number }[] };

/// Init script: the bench's own clock for keys and frames (self-contained). Each keydown's time, each frame
/// callback's time and each long task, from the first frame on; the bench reads the window it typed in.
function typingProbe() {
  const w = window as unknown as { __typingProbe?: Probe };
  if (w.__typingProbe) return;
  const probe: Probe = { keys: [], frames: [], long: [] };
  w.__typingProbe = probe;
  const tick = () => {
    probe.frames.push(performance.now());
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  addEventListener("keydown", (event) => probe.keys.push(event.timeStamp), true);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.long.push({ at: entry.startTime, ms: entry.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // An engine without long tasks reads 0.
  }
}

/// Starts the flood load in the page (see the header): a running turn on the open chat, then push k at k*16 ms
/// from the start with exactly the reply chunks and tool output lines whose offsets fall in its slot, as raw frames
/// through the client's transport socket. The client is found through React's fiber above the composer (the pane
/// keeps it in a ref and exposes no handle), and each push reads its socket then, as the host's push reaches
/// whichever socket is live.
async function startFlood(page: Page, session: string, chunksPerS: number, linesPerS: number) {
  const started = (await page.evaluate(
    ({ session, chunksPerS, linesPerS, selectors }) => {
      type Socket = { readyState: number; onmessage: ((message: { data: string }) => void) | null };
      type Client = { socket?: Socket; lastSeq: number; selectedSessionId?: string };
      const isClient = (value: any): value is Client =>
        !!value &&
        typeof value === "object" &&
        typeof value.lastSeq === "number" &&
        "selectedSessionId" in value &&
        typeof value.socket?.onmessage === "function";
      let client: Client | undefined;
      for (const selector of selectors) {
        const element = document.querySelector(selector) as any;
        if (!element) continue;
        const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
        for (let fiber = key ? element[key] : undefined; fiber && !client; fiber = fiber.return) {
          for (let hook = fiber.memoizedState; hook && typeof hook === "object" && "next" in hook; hook = hook.next) {
            const current = hook.memoizedState?.current;
            if (isClient(current)) {
              client = current;
              break;
            }
          }
        }
        if (client) break;
      }
      if (!client) return { error: "no direct client found through the pane's fiber" };
      if (client.selectedSessionId !== session)
        return { error: `the client shows ${String(client.selectedSessionId)}, not the seeded ${session}` };
      const live = client;
      let seq = live.lastSeq;
      const id = JSON.stringify(session);
      const event = (kind: string, msg: string) =>
        `{"jsonrpc":"2.0","method":"_acpmux/event","params":{"sessionId":${id},"seq":${++seq},"at":${Date.now()},"dir":"mux","kind":"${kind}","msg":${msg}}}`;
      const update = (body: string) =>
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":${id},"update":${body},"_meta":{"acpmux":{"seq":${++seq},"at":${Date.now()}}}}}`;
      const words = [
        "the",
        "composer",
        "keeps",
        "its",
        "draft",
        "while",
        "rows",
        "stream",
        "in",
        "and",
        "each",
        "frame",
        "should",
        "draw",
        "only",
        "what",
        "changed",
        "`receive`",
        "parses",
        "**once**",
        "then",
        "reduces",
      ];
      let chunkIndex = 0;
      const chunk = () => {
        chunkIndex += 1;
        let text = "";
        for (let i = 0; i < 5; i += 1) text += `${words[(chunkIndex * 7 + i * 3) % words.length]} `;
        if (chunkIndex % 40 === 0) text += "\n\n";
        else if (chunkIndex % 9 === 0) text += "\n- ";
        return update(
          `{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":${JSON.stringify(text)}}}`,
        );
      };
      const call = `composer-load-${Date.now()}`;
      let lineIndex = 0;
      const line = () => {
        lineIndex += 1;
        const data = `[${String(lineIndex).padStart(6, "0")}] compiling src/agent-session/module${lineIndex % 97}.ts ok\n`;
        return update(
          `{"sessionUpdate":"tool_call_update","toolCallId":"${call}","status":"in_progress","_meta":{"terminal_output":{"data":${JSON.stringify(data)}}}}`,
        );
      };
      // As BridgeSocket.receive: every frame of one push in one task, in order, while the socket is open.
      const push = (frames: string[]) => {
        const socket = live.socket;
        for (const data of frames) {
          if (!socket || socket.readyState !== 1) return;
          socket.onmessage?.({ data });
        }
      };
      const opening = [
        event("user_message", `{"text":"Build it and explain what changed"}`),
        event("turn_started", "{}"),
      ];
      if (linesPerS > 0)
        opening.push(
          update(
            `{"sessionUpdate":"tool_call","toolCallId":"${call}","title":"Run bun run build","kind":"execute","status":"in_progress","rawInput":{"command":"bun run build"}}`,
          ),
        );
      push(opening);
      // The fixed schedule: event i of a stream at rate r is due at i/r s; push k (at k*SLOT_MS) holds every
      // event due before it, so its count depends on k alone, never on when its timer fired.
      const SLOT_MS = 16;
      const dueBy = (rate: number, k: number) => Math.ceil((k * SLOT_MS * rate) / 1000 - 1e-9);
      const t0 = performance.now();
      const state = {
        pushes: 0,
        frames: opening.length,
        chunks: 0,
        lines: 0,
        stopped: false,
        push_ms_max: 0,
        late_pushes: 0,
        lag_ms_max: 0,
      };
      (window as unknown as { __streamLoad: typeof state }).__streamLoad = state;
      let k = 0;
      const pump = () => {
        if (state.stopped) return;
        k += 1;
        const lag = performance.now() - (t0 + k * SLOT_MS);
        if (lag > SLOT_MS) state.late_pushes += 1;
        state.lag_ms_max = Math.max(state.lag_ms_max, lag);
        const frames: string[] = [];
        for (; state.chunks < dueBy(chunksPerS, k); state.chunks += 1) frames.push(chunk());
        for (; state.lines < dueBy(linesPerS, k); state.lines += 1) frames.push(line());
        if (frames.length) {
          const at = performance.now();
          push(frames);
          state.push_ms_max = Math.max(state.push_ms_max, performance.now() - at);
          state.pushes += 1;
          state.frames += frames.length;
        }
        // The next push at its own slot; a push already owed goes in the next task, alone.
        setTimeout(pump, Math.max(0, t0 + (k + 1) * SLOT_MS - performance.now()));
      };
      setTimeout(pump, SLOT_MS);
      return { seq: live.lastSeq };
    },
    { session, chunksPerS, linesPerS, selectors: [PROMPT, ".acpmux-scroll", ".acpmux-composer"] },
  )) as { error?: string };
  if (started.error) throw new Error(`flood load: ${started.error}`);
}

type CpuProfile = {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }[];
  samples: number[];
  timeDeltas: number[];
};

/// Per key, ms: each function's inclusive time (once per sample however deep it recurses) and self time.
function printProfile(length: number, profile: CpuProfile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const name = (id: number) => {
    const frame = byId.get(id)!.callFrame;
    const file = frame.url.split("/").pop()?.split("?")[0] ?? "";
    return `${frame.functionName || "(anon)"} ${file}:${frame.lineNumber + 1}`;
  };
  const inclusive = new Map<string, number>();
  const self = new Map<string, number>();
  profile.samples.forEach((id, index) => {
    const ms = (profile.timeDeltas[index + 1] ?? 0) / 1000;
    const fn = byId.get(id)?.callFrame.functionName;
    if (fn === "(idle)" || fn === "(program)") return;
    self.set(name(id), (self.get(name(id)) ?? 0) + ms);
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const key = name(at);
      if (seen.has(key)) continue;
      seen.add(key);
      inclusive.set(key, (inclusive.get(key) ?? 0) + ms);
    }
  });
  const top = (map: Map<string, number>, count: number) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([key, ms]) => `  ${(ms / KEYS).toFixed(3)} ms/key  ${key}`)
      .join("\n");
  console.log(`PROFILE ${length} rows, inclusive:\n${top(inclusive, 90)}`);
  console.log(`PROFILE ${length} rows, self:\n${top(self, 40)}`);
}

const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p))]! : 0;
};
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const r1 = (value: number) => Math.round(value * 10) / 10;

// Each arm's pane as it ships (a vite build: production React, the React Compiler pass), served as files; --dev
// serves the arm's dev server instead (development React, several times the script time per render). With --profile
// the build is unminified, so the profile names functions.
const releases: (() => unknown)[] = [];
async function serveArm(dir: string): Promise<number> {
  const configFile = path.join(dir, "vite.config.acpmux-pane.mjs");
  if (DEV) {
    const { createServer } = await import("vite");
    const vite = await createServer({
      configFile,
      server: { port: 0, host: "127.0.0.1", strictPort: false },
      logLevel: "error",
    });
    releases.push(() => vite.close());
    await vite.listen();
    await warmViteServer(vite, "/?mock");
    return (vite.httpServer!.address() as { port: number }).port;
  }
  const out = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "composer-typing-bench-"));
  releases.push(() => fs.rmSync(out, { recursive: true, force: true }));
  const { build } = await import("vite");
  await build({
    configFile,
    build: { outDir: out, emptyOutDir: true, ...(PROFILE ? { minify: false } : {}) },
    logLevel: "error",
  });
  const statics = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      const file = Bun.file(path.join(out, pathname === "/" ? "index.html" : pathname));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
  releases.push(() => statics.stop(true));
  return statics.port!;
}

/// One run: a fresh browser process and page on `port`, one length in one mode, the keys typed and measured.
async function measure(port: number, length: number, mode: Mode): Promise<Record<string, unknown>> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
    await page.addInitScript(typingProbe);
    const { rows, session } = await openChat(page, port, Math.max(1, Math.round(length / 3)));
    if (mode === "flood") {
      await startFlood(page, session, FLOOD_CHUNKS_PER_S, FLOOD_LINES_PER_S);
      // The load runs before the first key: a second of it lands first.
      await page.waitForTimeout(1000);
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const metrics = async () => {
      const { metrics: list } = (await cdp.send("Performance.getMetrics")) as {
        metrics: { name: string; value: number }[];
      };
      return Object.fromEntries(
        list.filter((m) => (METRICS as readonly string[]).includes(m.name)).map((m) => [m.name, m.value]),
      );
    };
    await page.locator(PROMPT).first().click();
    // Warm-up: the first keys load the composer's lazy parts (emoji data, the mention index).
    for (const key of "warm") await page.keyboard.press(key);
    await page.waitForTimeout(500);
    for (let i = 0; i < 4; i += 1) await page.keyboard.press("Backspace");
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const debug = (window as any).cmuxAcpmuxDebug;
      debug.resetTyping();
      debug.renders();
    });
    if (PROFILE) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
      await cdp.send("Profiler.start");
    }
    // Stream mode: a reply streams in for the whole typing run (no scrolling), a tool call every 30 deltas.
    const streaming =
      mode === "stream"
        ? page.evaluate(
            (seconds) =>
              (window as any).cmuxAcpmuxDebug.loadRun({ seconds, chunk_ms: 16, tool_every: 30, scroll_speed: 0 }),
            (KEYS * (GAP_MS + 20)) / 1000 + 1,
          )
        : Promise.resolve(undefined);
    if (mode === "stream") {
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        const debug = (window as any).cmuxAcpmuxDebug;
        debug.resetTyping();
        debug.renders();
      });
    }
    const before = await metrics();
    const since = await page.evaluate(() => performance.now());
    const letters = "abcdefghijklmnopqrstuvwxyz";
    for (let i = 0; i < KEYS; i += 1) {
      await page.keyboard.press(letters[i % letters.length]!);
      await page.waitForTimeout(GAP_MS);
    }
    await page.waitForTimeout(500);
    const after = await metrics();
    const until = await page.evaluate(() => performance.now());
    const load =
      mode === "flood"
        ? ((await page.evaluate(() => {
            const state = (window as unknown as { __streamLoad: Record<string, number | boolean> }).__streamLoad;
            state.stopped = true;
            return state;
          })) as Record<string, number>)
        : undefined;
    const probe = (await page.evaluate(() => (window as unknown as { __typingProbe: Probe }).__typingProbe)) as Probe;
    if (PROFILE) {
      const { profile } = (await cdp.send("Profiler.stop")) as { profile: CpuProfile };
      printProfile(length, profile);
    }
    const { renders, typing } = (await page.evaluate(() => {
      const debug = (window as any).cmuxAcpmuxDebug;
      return { renders: debug.renders(), typing: debug.typingStats() };
    })) as { renders: Record<string, number>; typing: Record<string, any> };
    await streaming;
    // Per stream event, nobody typing: the composer's renders while a reply and tool calls stream
    // (loadRun), then while a tool's output ticks and another chat changes (loadTick).
    let composerPerEvent: number | undefined;
    let composerPerTick: number | undefined;
    if (mode === "stream") {
      const run = (await page.evaluate(() =>
        (window as any).cmuxAcpmuxDebug.loadRun({ seconds: 3, chunk_ms: 16, tool_every: 10, scroll_speed: 0 }),
      )) as { renders: Record<string, number>; deltas: number; tools: number };
      composerPerEvent = Math.round(((run.renders.composer ?? 0) / Math.max(1, run.deltas + run.tools)) * 1000) / 1000;
      const tick = (await page.evaluate(() =>
        (window as any).cmuxAcpmuxDebug.loadTick({ seconds: 3, tick_ms: 50, sidebar_ms: 100, scroll_speed: 0 }),
      )) as { renders: Record<string, number>; ticks?: number; sidebar?: number };
      composerPerTick =
        Math.round(((tick.renders.composer ?? 0) / Math.max(1, (tick.ticks ?? 0) + (tick.sidebar ?? 0))) * 1000) / 1000;
    }
    await page.close();
    const per = (value: number) => Math.round((value / KEYS) * 100) / 100;
    const sum = (prefix: string) =>
      Object.entries(renders)
        .filter(([name]) => name.startsWith(prefix))
        .reduce((total, [, value]) => total + value, 0);
    const delta = (name: string) => (after[name] ?? 0) - (before[name] ?? 0);
    // Each typed key's next frame (the first frame callback after its keydown), on the bench's own clock.
    const keyTimes = probe.keys.filter((at) => at >= since && at <= until);
    const frames = probe.frames.filter((at) => at >= since && at <= until);
    const keyFrame: number[] = [];
    for (const at of keyTimes) {
      const next = frames.find((frame) => frame >= at);
      if (next !== undefined) keyFrame.push(next - at);
    }
    const gaps = frames.slice(1).map((at, index) => at - frames[index]!);
    const long = probe.long.filter((task) => task.at + task.ms >= since && task.at <= until);
    return {
      mode,
      rows,
      keys: typing.keys,
      pane: per(renders.pane ?? 0),
      transcript: per(renders.transcript ?? 0),
      composer: per(renders.composer ?? 0),
      rowRenders: per(sum("row:") + sum("content:")),
      rowFrames: per(sum("frame:")),
      layouts: per(delta("LayoutCount")),
      styles: per(delta("RecalcStyleCount")),
      script_ms: per(delta("ScriptDuration") * 1000),
      layout_ms: per(delta("LayoutDuration") * 1000),
      style_ms: per(delta("RecalcStyleDuration") * 1000),
      task_ms: per(delta("TaskDuration") * 1000),
      to_listener_p95: typing.to_listener?.p95_ms,
      to_work_p95: typing.to_work?.p95_ms,
      to_frame_p50: typing.to_frame?.p50_ms,
      to_frame_p95: typing.to_frame?.p95_ms,
      to_frame_max: typing.to_frame?.max_ms,
      key_frame_p50: r1(pct(keyFrame, 0.5)),
      key_frame_p95: r1(pct(keyFrame, 0.95)),
      key_frame_max: r1(Math.max(0, ...keyFrame)),
      longest_task_ms: r1(Math.max(0, ...long.map((task) => task.ms))),
      long_tasks: long.length,
      frames_over_16ms: gaps.filter((gap) => gap > 20).length,
      frame_gap_max: r1(Math.max(0, ...gaps)),
      composer_per_stream_event: composerPerEvent,
      composer_per_tick_event: composerPerTick,
      ...(load && {
        load_pushes: load.pushes,
        load_chunks: load.chunks,
        load_lines: load.lines,
        load_late_pushes: load.late_pushes,
        load_lag_ms_max: r1(load.lag_ms_max ?? 0),
        load_push_ms_max: r1(load.push_ms_max ?? 0),
      }),
      nativePosts: JSON.stringify(typing.native_posts ?? {}),
      busiest: Object.entries(renders)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, value]) => `${name}=${value}`)
        .join(" "),
    };
  } finally {
    await browser.close();
  }
}

/// The numbers an A/B reads, per arm: median and [min-max] over the rounds, then each arm's median minus the first
/// arm's, with `sep` when the two arms' ranges do not overlap.
const SUMMARY = [
  "key_frame_p50",
  "key_frame_p95",
  "key_frame_max",
  "to_frame_p50",
  "to_frame_p95",
  "to_frame_max",
  "to_listener_p95",
  "longest_task_ms",
  "long_tasks",
] as const;

function printArms(length: number, mode: Mode, runs: Record<string, unknown>[], names: string[]) {
  const values = (arm: string, metric: string) =>
    runs
      .filter((run) => run.arm === arm)
      .map((run) => Number(run[metric] ?? Number.NaN))
      .filter(Number.isFinite);
  const [first, ...rest] = names;
  const table: Record<string, Record<string, string>> = {};
  const summary: Record<string, Record<string, { median: number; min: number; max: number }>> = {};
  for (const metric of SUMMARY) {
    const row: Record<string, string> = {};
    const base = values(first!, metric);
    for (const arm of names) {
      const list = values(arm, metric);
      if (!list.length) continue;
      const stats = { median: r1(median(list)), min: r1(Math.min(...list)), max: r1(Math.max(...list)) };
      (summary[arm] ??= {})[metric] = stats;
      row[arm] = `${stats.median} [${stats.min}-${stats.max}]`;
    }
    for (const arm of rest) {
      const list = values(arm, metric);
      if (!list.length || !base.length) continue;
      const diff = r1(median(list) - median(base));
      const separated = Math.min(...list) > Math.max(...base) || Math.max(...list) < Math.min(...base);
      row[`${arm}-${first}`] = `${diff > 0 ? "+" : ""}${diff}${separated ? " sep" : ""}`;
    }
    table[metric] = row;
  }
  const rounds = Math.max(...names.map((arm) => runs.filter((run) => run.arm === arm).length));
  console.log(
    `ARMS ${mode} ${length} rows, ${rounds} runs per arm (median [min-max] over runs, ms; long_tasks a count)` +
      (FLOOR ? `; noise floor: ${first}' against ${first}` : ""),
  );
  console.table(table);
  console.log(`COMPOSER-TYPING-ARMS ${JSON.stringify({ mode, length, arms: names, summary })}`);
}

try {
  const arms: { name: string; port: number }[] = [];
  for (const arm of ARMS) arms.push({ name: arm.name, port: await serveArm(arm.dir) });
  if (FLOOR) arms.push({ name: `${arms[0]!.name}'`, port: arms[0]!.port });
  // A round: the arms in order, then reversed (A B B A, or A B A' A' B A with the noise floor; every other round
  // swaps A and A', A' B A A B A', so over two rounds they hold the same places).
  const order = [...arms, ...[...arms].reverse()];
  const swapped = order.map((arm) =>
    !FLOOR ? arm : arm === arms[0] ? arms.at(-1)! : arm === arms.at(-1) ? arms[0]! : arm,
  );
  const perRound = (round: number) => (!ARMS_FLAG ? arms : round % 2 ? order : swapped);
  const table: Record<string, unknown>[] = [];
  for (const { length, mode } of LENGTHS.flatMap((length) => MODES.map((mode) => ({ length, mode })))) {
    const runs: Record<string, unknown>[] = [];
    for (let round = 1; round <= ROUNDS; round += 1)
      for (const arm of perRound(round)) {
        const run: Record<string, unknown> = { arm: arm.name, round, ...(await measure(arm.port, length, mode)) };
        runs.push(run);
        if (ARMS_FLAG)
          console.log(
            `RUN ${mode} ${length} rows round ${round} ${arm.name}: key_frame p95 ${String(run.key_frame_p95)}, ` +
              `to_frame p95 ${String(run.to_frame_p95)}, to_listener p95 ${String(run.to_listener_p95)}, ` +
              `longest task ${String(run.longest_task_ms)}, long tasks ${String(run.long_tasks)}` +
              (mode === "flood" ? `, late pushes ${String(run.load_late_pushes)}` : ""),
          );
      }
    table.push(...runs);
    if (ARMS_FLAG)
      printArms(
        length,
        mode,
        runs,
        arms.map((arm) => arm.name),
      );
  }
  if (!ARMS_FLAG) {
    console.table(table.map(({ arm: _a, round: _r, busiest: _, nativePosts: __, ...row }) => row));
    for (const row of table)
      console.log(
        `${String(row.mode)} ${String(row.rows)} rows: ${String(row.busiest)}; native posts ${String(row.nativePosts)}`,
      );
  }
  console.log(`COMPOSER-TYPING ${JSON.stringify(table)}`);
} finally {
  for (const release of releases.reverse()) await release();
}
