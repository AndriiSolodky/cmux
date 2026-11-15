// l10n-allow-file: synthetic parent and helper transcript fixtures, not shipped UI.
// Leo, 2026-11-15, after a restart: "idk why it sent this tho?" (and then "oh i guess it was a
// false start"). His chat showed "Thinking 7s" while acpmux ran no turn for it: only a helper
// the chat had started in the background was thinking. Its thinking is the helper's, drawn in its
// own chat: the parent, between turns, shows no running turn, and a message sent then is no steer.
import { expect, test } from "bun:test";
import { AcpmuxDirectClient } from "../src/agent-session/acpmux/direct";
import type { AcpmuxRow, AcpmuxSnapshot } from "../src/agent-session/acpmux/model";

const CHAT = "0190a000-0000-7000-8000-0000000000d6";
const ROOT = "parent-thread";
const HELPER = `${ROOT}/toolu_helper`;
const START = Date.UTC(2026, 10, 15, 1, 30);
type Step = [dir: string, kind: string, msg: Record<string, unknown>];

const update = (body: Record<string, unknown>, owner?: string): Step => [
  "in",
  String(body.sessionUpdate),
  {
    method: "session/update",
    params: {
      sessionId: owner ?? ROOT,
      update: body,
      ...(owner ? { _meta: { acpmux: { subagent: owner } } } : {}),
    },
  },
];
const think = (text: string, owner?: string) =>
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } }, owner);
const say = (text: string, owner?: string) =>
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, owner);
const tool = (id: string, title: string, owner?: string) =>
  update({ sessionUpdate: "tool_call", toolCallId: id, title, kind: "execute", status: "in_progress" }, owner);
const record = (steps: Step[], from: number) =>
  steps.map(([dir, kind, msg], index) => ({
    sessionId: CHAT,
    seq: from + index,
    at: START + (from + index) * 1000,
    dir,
    kind,
    msg,
  }));

function fakeDaemon(steps: Step[]) {
  const history = record(steps, 100);
  let socket: any;
  const session = {
    sessionId: CHAT,
    agentSessionId: ROOT,
    cwd: "/home/dev/project",
    title: "Parent chat",
    harness: "claude",
    family: "claude",
    status: "ready",
    turnCount: 1,
    updatedAt: START,
  };
  const answer = (method: string) => {
    switch (method) {
      case "initialize":
        return { protocolVersion: 1, _meta: { acpmux: { origin: "local", extensions: [], operations: [] } } };
      case "_acpmux/watch":
      case "_acpmux/sessions":
        return { sessions: [session] };
      case "_acpmux/attach":
        return { session, lastSeq: history.at(-1)!.seq, events: history };
      case "_acpmux/events":
        return { events: [], hasMore: false, more: false, lastSeq: history.at(-1)!.seq };
      default:
        return null;
    }
  };
  const open = () => {
    socket = {
      readyState: 1,
      send(raw: string) {
        const message = JSON.parse(raw);
        if (message.id === undefined) return;
        queueMicrotask(() =>
          socket.onmessage?.({
            data: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer(message.method) }),
          }),
        );
      },
      close() {},
    };
    queueMicrotask(() => socket.onopen?.());
    return socket as WebSocket;
  };
  const push = (...steps: Step[]) => {
    for (const event of record(steps, history.at(-1)!.seq + 1)) {
      history.push(event);
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "_acpmux/event", params: event }) });
    }
  };
  return { open, push };
}

async function connect(daemon: ReturnType<typeof fakeDaemon>) {
  let snapshot: Partial<AcpmuxSnapshot> & { rows: readonly AcpmuxRow[] } = { rows: [] };
  const waiters = new Set<() => void>();
  const client = await AcpmuxDirectClient.connect(
    { protocolVersion: 1, transport: "acpmux-websocket", endpoint: "ws://127.0.0.1:1/", token: "t", sessionId: CHAT },
    (next: any) => {
      snapshot = next;
      for (const wake of waiters) wake();
    },
    undefined,
    daemon.open,
  );
  const until = (holds: (value: typeof snapshot) => boolean) =>
    new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(wake);
        reject(new Error("Expected transcript snapshot did not arrive"));
      }, 2000);
      const wake = () => {
        if (!holds(snapshot)) return;
        clearTimeout(timeout);
        waiters.delete(wake);
        resolve();
      };
      waiters.add(wake);
      wake();
    });
  return { client, snapshot: () => snapshot, until };
}

const live = (rows: readonly AcpmuxRow[]) =>
  rows.filter((row) => row.id === "thinking-live" || row.kind === "typing" || row.kind === "thinking").map((row) => row.id);

for (const restart of [false, true])
  test(`a background helper thinking while the parent is between turns draws no parent Thinking${restart ? ", after a restart" : ""}`, async () => {
    const ended: Step[] = [
      ["mux", "user_message", { client: "pane", promptId: "p1", turnId: "t1", text: "go now" }],
      ["mux", "turn_started", { client: "pane", promptId: "p1", turnId: "t1" }],
      ["mux", "status", { status: "running" }],
      say("Started a helper in the background."),
      tool("agent-1", "Agent: fix the gap"),
      ["mux", "turn_end", { turnId: "t1" }],
      ["mux", "turn_result", { promptId: "p1", status: "completed" }],
      ["mux", "status", { status: "ready" }],
    ];
    const helperWork: Step[] = [
      ["mux", "subagents_running", { count: 1 }],
      ["mux", "subagents_working", { since: START }],
      think("Checking the queue path", HELPER),
      tool("helper-bash", "glaeda-gh status", HELPER),
      ...(restart
        ? ([["mux", "host_adopted", { hostBuild: "test", incarnation: "i2", resumedAfter: 10 }]] as Step[])
        : []),
      think("The lane VM's gh translates the call", HELPER),
    ];
    const daemon = fakeDaemon(restart ? [...ended, ...helperWork] : ended);
    const { client, snapshot, until } = await connect(daemon);
    try {
      await until(({ rows }) => rows.some((row) => row.kind === "assistant"));
      if (!restart) {
        daemon.push(...helperWork);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      console.log(`ROWS ${restart} working=${snapshot().isWorking} ${snapshot().rows.map((row) => `${row.id}:${row.kind}`).join(" ")}`);
      expect(snapshot().isWorking).toBe(false);
      expect(live(snapshot().rows)).toEqual([]);
    } finally {
      client.close();
    }
  });
