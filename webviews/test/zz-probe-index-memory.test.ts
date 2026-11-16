// Scratch probe (not committed): what a fake client of N prompts keeps.
import { heapStats } from "bun:jsc";
import { test } from "bun:test";
import { fakeClient, records, settle } from "./support/fakeAcpmuxClient";

const CHAT = "0190a000-0000-7000-8000-0000000c0de7";
const say = (text: string) => ({
  method: "session/update",
  params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
});
const turn = (n: number): [string, string, Record<string, unknown>][] => [
  ["mux", "user_message", { text: `Question ${n} about the lane`, promptId: `p-${n}`, turnId: `t-${n}` }],
  ["mux", "turn_started", { promptId: `p-${n}`, turnId: `t-${n}` }],
  ["in", "agent_message_chunk", say(`Answer ${n}`)],
  ["mux", "turn_result", { status: "completed", turnId: `t-${n}` }],
];
const stats = () => {
  Bun.gc(true);
  return heapStats();
};
test("probe", async () => {
  for (const prompts of [1000, 4000]) {
    const history = records(CHAT, Array.from({ length: prompts }, (_, n) => turn(n + 1)).flat());
    const before = stats();
    const chat = await fakeClient(history, { page: 40 });
    for (let n = 0; n < 50 && !chat.snapshot().earlierPrompts; n++) await settle(5);
    const snapshot = chat.snapshot();
    const after = stats();
    const reads = chat.reads.map((r) => JSON.stringify({ ...r, sessionId: undefined })).slice(0, 8);
    console.log(
      `PROBE ${prompts}: rows ${snapshot.rows.length} earlier ${snapshot.earlierPrompts?.length} objects +${after.objectCount - before.objectCount} reads ${chat.reads.length} ${reads.join(" ")}`,
    );
    const deltas = Object.entries(after.objectTypeCounts)
      .map(([k, v]) => [k, v - (before.objectTypeCounts[k] ?? 0)] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    console.log(`PROBE ${prompts} types: ${deltas.map(([k, v]) => `${k}=${v}`).join(", ")}`);
    chat.client.close();
  }
});
