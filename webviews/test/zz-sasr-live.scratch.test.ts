import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { AcpmuxDirectClient } from "../src/agent-session/acpmux/direct";
import type { AcpmuxRow } from "../src/agent-session/acpmux/model";
import { withSubagentLines } from "../src/agent-session/acpmux/subagents/runningTray";
import { turnView } from "../src/agent-session/acpmux/conversation/turns";
import { layoutConversation } from "../src/agent-session/acpmux/model";

type Event = { sessionId: string; seq: number; at: number; kind: string };

test("live diag", async () => {
  const events = readFileSync(
    new URL("../src/gallery/fixtures/recordings/zz-sasr-wide.scratch.ndjson", import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Event);
  const sessionId = events[0]!.sessionId;
  const split = Number(process.env.SASR_SPLIT ?? 2864259);
  const history = events.filter((event) => event.seq <= split);
  const live = events.filter((event) => event.seq > split);
  const session = {
    sessionId,
    cwd: "/home/dev/project",
    title: "Recorded chat",
    harness: "claude",
    family: "claude",
    status: "running",
    steering: false,
    turnCount: 1,
    updatedAt: history.at(-1)!.at,
  };
  const lastSeq = history.at(-1)!.seq;
  const answer = (method: string) => {
    if (method === "initialize")
      return { protocolVersion: 1, _meta: { acpmux: { origin: "local", extensions: [], operations: [] } } };
    if (method === "_acpmux/watch") return { sessions: [session] };
    if (method === "_acpmux/attach") return { session, lastSeq, events: history, hasMore: false };
    if (method === "_acpmux/events") return { events: [], hasMore: false, more: false, lastSeq };
    return null;
  };
  type FakeSocket = {
    readyState: number;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    send(raw: string): void;
    close(): void;
  };
  let socket: FakeSocket | undefined;
  const open = () => {
    socket = {
      readyState: 1,
      send(raw: string) {
        const message = JSON.parse(raw) as { id?: number; method: string };
        if (message.id !== undefined)
          queueMicrotask(() =>
            socket!.onmessage?.({
              data: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer(message.method) }),
            }),
          );
      },
      close() {},
    };
    queueMicrotask(() => socket!.onopen?.());
    return socket as unknown as WebSocket;
  };
  let rows: AcpmuxRow[] = [];
  const client = await AcpmuxDirectClient.connect(
    { protocolVersion: 1, transport: "acpmux-websocket", endpoint: "ws://127.0.0.1:1/", token: "t", sessionId },
    (snapshot) => {
      rows = (snapshot as { rows: AcpmuxRow[] }).rows;
    },
    undefined,
    open,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const report = (label: string) => {
    const shaped = turnView(withSubagentLines(rows), new Set(), { agentFamily: "claude" });
    const layout = layoutConversation(shaped, 720, new Map());
    const at = shaped.findIndex((row) => row.id === "subagentStarted:subagents-2865046");
    if (at < 0) return console.log("LIVE", label, "no start row", shaped.length);
    for (let index = Math.max(0, at - 2); index < Math.min(shaped.length, at + 4); index += 1) {
      const row = shaped[index]!;
      console.log(
        "LIVE",
        label,
        index,
        row.kind,
        row.id.slice(0, 50),
        `bg=${row.inBackground ?? ""}`,
        `mark=${layout.marks?.[index]}`,
        `gap=${layout.gaps[index]}`,
        `h=${layout.heights[index]}`,
      );
    }
  };
  for (const event of live) {
    socket!.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "_acpmux/event", params: event }) });
    if (event.seq === 2865548 || event.seq === 2866000) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      report(`after-${event.seq}`);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  report("end");
  client.close();
});
