// l10n-allow-file: probe
import { afterAll, beforeAll, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { settleReact } from "../../../../test/support/domTeardown";
import { AcpmuxDirectClient, type EventRecord } from "../direct";
import type { AcpmuxRow } from "../model";
import { turnReplies, undrawnReplies } from "./repliesDrawn";
import { turnView } from "./turns";

const SESSION = "01a18a35-b1e8-7951-ba2f-703bf916b9a6";
const logged: EventRecord[] = readFileSync(new URL("./fixtures/sr2-turns-3591992.ndjson", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

const dom = new JSDOM("<!doctype html>", { url: "http://localhost/" });
const scope = globalThis as Record<string, unknown>;
beforeAll(() => {
  scope.window = dom.window;
  scope.document = dom.window.document;
});
afterAll(async () => {
  await settleReact();
  delete scope.window;
  delete scope.document;
});

function replay(events: readonly EventRecord[]): AcpmuxRow[] {
  let rows: readonly AcpmuxRow[] = [];
  const client = AcpmuxDirectClient.replay(SESSION, [...events], (snapshot) => {
    rows = snapshot.rows;
  });
  try {
    client.seekReplay(events.at(-1)!.seq);
  } finally {
    client.close();
  }
  return [...rows];
}

test("probe", () => {
  const replies = turnReplies(logged);
  console.log("replies", replies.map((r) => `${r.startSeq} ${r.segment} ${r.fromSeq}..${r.toSeq} len=${r.text.length}`));
  const rows = replay(logged);
  console.log("ROWS");
  for (const row of rows) {
    const r = row as any;
    if (r.kind === "tool" || r.kind === "thought") continue;
    console.log(`${r.kind} ${r.id} len=${typeof r.text === "string" ? r.text.length : "-"} parent=${r.parentToolUseId ?? r.subagent ?? ""} folded=${r.foldedReply ?? ""}`);
  }
  const drawn = turnView(rows, new Set(), { agentFamily: "claude" });
  console.log("DRAWN");
  for (const row of drawn) {
    const r = row as any;
    console.log(`${r.kind} ${r.id} len=${typeof r.text === "string" ? r.text.length : "-"}`);
  }
  console.log("UNDRAWN", undrawnReplies(replies, drawn).map((r) => r.startSeq));
});

const settle = async (done: () => boolean) => {
  for (let turns = 0; !done(); turns += 1) {
    if (turns > 20_000) throw new Error(`never settled`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

for (const batch of [1, 9]) {
  test(`live probe batch ${batch}`, async () => {
    const { MockAcpmuxSocket, mockHost } = await import("../mock");
    const { turnViewFrom } = await import("./turns");
    let live: ReturnType<typeof turnViewFrom> | undefined;
    let shown: any;
    let snapshots = 0;
    let socket!: any;
    const client = await AcpmuxDirectClient.connect(
      mockHost,
      (snapshot) => {
        shown = snapshot;
        snapshots += 1;
        live = turnViewFrom(
          snapshot.rows,
          new Set() as never,
          {
            working: snapshot.isWorking,
            clockOffset: snapshot.clockOffsetMs,
            turnStartedAtMs: snapshot.turnStartedAtMs,
            agentFamily: "claude",
            waitingSteers: snapshot.waitingSteers,
          } as never,
          live,
        );
      },
      undefined,
      () => (socket = new MockAcpmuxSocket(() => Promise.resolve())) as unknown as WebSocket,
    );
    const id = mockHost.sessionId!;
    await settle(() => shown?.summary !== undefined);
    const replies = turnReplies(logged);
    let sent = 0;
    for (const event of logged) {
      if (event.dir === "mux") {
        if (event.kind === "turn_started") socket.touch(id, { status: "running", turn: { turnId: event.msg?.turnId } });
        socket.emit(id, { mux: event.kind, msg: event.msg });
        if (event.kind === "turn_result") socket.touch(id, { status: "idle", turn: undefined });
      } else
        socket.emit(id, {
          update: event.msg.params.update,
          ...(event.msg.params._meta && { meta: event.msg.params._meta }),
        });
      sent += 1;
      if (sent % batch !== 0 && event.kind !== "turn_result") continue;
      const before = snapshots;
      await settle(() => snapshots > before);
      if (event.kind !== "turn_result") continue;
      const ended = replies.filter((reply) => reply.endSeq <= event.seq);
      console.log(`batch ${batch} through ${event.seq}: undrawn`, undrawnReplies(ended, live!.rows).map((r) => r.startSeq));
    }
    console.log("LIVE ROWS", live!.rows.map((r: any) => `${r.kind}:${r.id}:${typeof r.text === "string" ? r.text.length : "-"}`).join("\n"));
    client.close?.();
  }, 120_000);
}

test("fold probe: any single toggled fold that hides later replies", async () => {
  const { CLOSED_TURN_FOLD } = await import("./turns");
  const { viewFolds } = await import("./viewFolds");
  const replies = turnReplies(logged);
  const rows = replay(logged);
  const base = turnView(rows, new Set(), { agentFamily: "claude" });
  const ids = new Set<string>();
  for (const row of [...rows, ...base]) {
    ids.add(row.id);
    ids.add(`${CLOSED_TURN_FOLD}${row.id}`);
    const r = row as any;
    for (const key of ["foldId", "groupId", "owner", "runId"]) if (typeof r[key] === "string") ids.add(r[key]);
  }
  const ARMS: Record<string, string>[] = [
    {},
    { "claude-turn-fold": "runs" },
    ...["nested-open", "nested", "header", "split"].map((arm) => ({ "turn-fold-steered": arm })),
    ...["groups", "runs", "replies"].map((arm) => ({ "turn-fold-replies": arm })),
  ];
  let found = 0;
  for (const arms of ARMS) {
    globalThis.cmuxExperiments = arms;
    for (const view of ["normal", "thinking", "verbose"] as const)
      for (const id of [undefined, ...ids]) {
        const expanded = new Set(id ? [id] : []);
        const folds = viewFolds(view as never, expanded, view === "normal" ? new Set() : expanded);
        let drawn: AcpmuxRow[];
        try {
          drawn = turnView(rows, folds, { agentFamily: "claude" });
        } catch (error) {
          console.log(`THROW arms=${JSON.stringify(arms)} view=${view} id=${id}: ${error}`);
          found += 1;
          continue;
        }
        const missing = undrawnReplies(replies, drawn).filter((reply) => !(id ?? "").includes(reply.turnId));
        if (missing.length) {
          found += 1;
          if (found < 40) console.log(`MISS arms=${JSON.stringify(arms)} view=${view} id=${id}: ${missing.map((r) => r.startSeq)}`);
        }
      }
  }
  delete (globalThis as { cmuxExperiments?: unknown }).cmuxExperiments;
  console.log("FOLD PROBE FOUND", found, "ids", ids.size);
});
