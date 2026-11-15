// Scratch: split live-turn-rows per stage and CPU-profile it. Not committed.
import { layoutConversation, type AcpmuxRow } from "../src/agent-session/acpmux/model";
import { turnViewFrom } from "../src/agent-session/acpmux/conversation/turns";
import { subagentRowsFrom } from "../src/agent-session/acpmux/subagents/subagentRows";
import { activity, assistant, tool, user } from "../src/gallery/fixtures/acpmux";
const N = Number(process.argv[2] ?? 10000), E = 200, START = 1_000_000;
function record(index: number): AcpmuxRow {
  const at = START + index * 1_000;
  if (index % 10 === 9) { const text = `Lane ${index} merged.`; return user(text, 0, { id: `incoming-${index}`, at, incoming: { kind: "message", message: { name: `lane-${index}`, text, raw: text } }, continues: true }); }
  if (index % 4 === 3) return assistant(`Lane ${index} is green.`, 0, { id: `reply-${index}`, at });
  return activity([tool(`gh pr checks ${index}`, "execute", "completed", { command: `x ${index}`, output: "ok" })], 0, { id: `call-${index}`, at });
}
const prompt = user("Coordinate.", 0, { id: "live-user", at: START - 1000 });
const options = { working: true, turnStartedAtMs: START - 1000, now: START + (N + E) * 1000 };
let rows: AcpmuxRow[] = [prompt]; for (let i = 0; i < N; i++) rows.push(record(i));
const open = new Set<string>();
let turns = turnViewFrom(rows, open, options); let sub = subagentRowsFrom(turns.rows, open);
const known = new WeakMap(); let drawn = sub.rows; let layout = layoutConversation(drawn, 720, new Map(), undefined, known as any);
const t = { turns: [] as number[], sub: [] as number[], layout: [] as number[] };
for (let e = 0; e < E; e++) {
  rows = [...rows, record(N + e)];
  let a = performance.now(); turns = turnViewFrom(rows, open, options, turns);
  let b = performance.now(); sub = subagentRowsFrom(turns.rows, open, sub);
  let c = performance.now(); const l = layoutConversation(sub.rows, 720, new Map(), undefined, known as any, { rows: drawn, layout });
  let d = performance.now(); t.turns.push(b - a); t.sub.push(c - b); t.layout.push(d - c); drawn = sub.rows; layout = l;
}
const p = (x: number[], q: number) => [...x].sort((a, b) => a - b)[Math.floor(q * x.length)]!.toFixed(2);
for (const [k, v] of Object.entries(t)) console.log(`SPLIT ${N} ${k}: p50 ${p(v, 0.5)} p95 ${p(v, 0.95)} ms`);
console.log(`SPLIT rows: source ${rows.length}, turn rows ${turns.rows.length}, drawn ${sub.rows.length}`);
