// l10n-allow-file: probe
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { settleReact } from "../../../../test/support/domTeardown";
import type { EventRecord } from "../direct";
import { turnReplies, undrawnReplies } from "./repliesDrawn";
import { turnView } from "./turns";

const logged: EventRecord[] = readFileSync(new URL("./fixtures/sr2-big.ndjson", import.meta.url), "utf8")
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (done: () => boolean, ms: number) => {
  const deadline = performance.now() + ms;
  while (!done() && performance.now() < deadline) await tick();
  return done();
};

for (const following of [true, false]) {
  test(`held probe following=${following}`, async () => {
    const { AcpmuxDirectClient } = await import("../direct");
    const { MockAcpmuxSocket, mockHost } = await import("../mock");
    let target = "";
    let delivered = 0;
    const firstSeq = logged[0]!.seq;
    let socket: { deliver: (message: unknown) => void } | undefined;
    const retarget = (event: EventRecord) => ({ ...event, sessionId: target });
    class Chat extends MockAcpmuxSocket {
      constructor() {
        super(() => Promise.resolve());
        socket = this as unknown as typeof socket;
        const self = this as unknown as { answer: (method: string, params: any) => Promise<unknown> };
        const answer = self.answer.bind(this);
        self.answer = async (method, params) => {
          if (method === "_acpmux/attach") {
            const result = (await answer(method, params)) as Record<string, unknown>;
            target = params.sessionId;
            return { ...result, events: [], hasMore: false, lastSeq: firstSeq - 1, pageThrough: firstSeq - 1, turnOpener: null };
          }
          if (method === "_acpmux/events" && params.sessionId === target) {
            const shown = logged.slice(0, delivered);
            let events: EventRecord[];
            if (params.beforeSeq !== undefined) {
              const limit = Number(params.limit ?? 400);
              const before = shown.filter((event) => event.seq < params.beforeSeq);
              events = before.slice(-limit);
              return { events: events.map(retarget), hasMore: events.length > 0 && events[0]!.seq > firstSeq, lastSeq: shown.at(-1)?.seq ?? 0 };
            }
            const after = Number(params.afterSeq ?? 0);
            const through = params.throughSeq ?? params.endSeq;
            events = shown.filter((event) => event.seq > after && (through === undefined || event.seq <= through)).slice(0, 5000);
            return { events: events.map(retarget), hasMore: false, lastSeq: shown.at(-1)?.seq ?? 0 };
          }
          return answer(method, params);
        };
      }
    }
    const frames: (() => void)[] = [];
    (AcpmuxDirectClient as any).scheduleFrame = (run: () => void) => void frames.push(run);
    const flush = () => {
      for (const run of frames.splice(0)) run();
    };
    let snapshot: any = { rows: [] };
    const client = await AcpmuxDirectClient.connect(
      mockHost,
      (next) => (snapshot = next),
      undefined,
      () => new Chat() as unknown as WebSocket,
    );
    client.setFollowing(following);
    expect(await settle(() => target !== "", 10_000)).toBe(true);
    for (let index = 0; index < 20; index += 1) await tick();
    const replies = turnReplies(logged);
    const events = () => (client as unknown as { events: EventRecord[] }).events;
    let firstMissing: number | undefined;
    for (const event of logged) {
      delivered += 1;
      socket!.deliver({ jsonrpc: "2.0", method: "_acpmux/event", params: retarget(event) });
      if (event.kind !== "turn_result") {
        if (delivered % 50 === 0) {
          await tick();
          flush();
        }
        continue;
      }
      for (let index = 0; index < 10; index += 1) await tick();
      flush();
      const drawn = turnView(snapshot.rows, new Set(), { agentFamily: "claude" });
      const heldFrom = events()[0]?.seq ?? 0;
      const ended = replies.filter((reply) => reply.endSeq <= event.seq && reply.fromSeq >= heldFrom);
      const missing = undrawnReplies(ended, drawn);
      console.log(
        `through ${event.seq}: held ${events().length} from ${heldFrom}, rows ${snapshot.rows.length}, replies ${ended.length}, undrawn ${missing.map((reply) => reply.startSeq).join(",")}`,
      );
      if (missing.length && firstMissing === undefined) {
        firstMissing = event.seq;
        console.log("ROWS AT FIRST MISS", drawn.slice(-40).map((row: any) => `${row.kind}:${row.id}:${typeof row.text === "string" ? row.text.length : "-"}`).join("\n"));
      }
    }
    console.log("FIRST MISSING", firstMissing);
    client.close?.();
    (AcpmuxDirectClient as any).scheduleFrame = undefined;
  }, 600_000);
}
