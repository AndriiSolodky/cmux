// Scratch: split live-turn-rows per stage, and count command reads per record. Not committed.
import { layoutConversation, type AcpmuxRow } from "../src/agent-session/acpmux/model";
import { turnViewFrom } from "../src/agent-session/acpmux/conversation/turns";
import { subagentRowsFrom } from "../src/agent-session/acpmux/subagents/subagentRows";
import { activity, assistant, tool, user } from "../src/gallery/fixtures/acpmux";
const N = Number(process.argv[2] ?? 10000), E = 200, START = 1_000_000;
const reads = { count: 0 };
const readers = new Map<string, number>();
function record(index: number): AcpmuxRow {
  const at = START + index * 1_000;
  if (index % 10 === 9) { const text = `Lane ${index} merged.`; return user(text, 0, { id: `incoming-${index}`, at, incoming: { kind: "message", message: { name: `lane-${index}`, text, raw: text } }, continues: true }); }
  if (index % 4 === 3) return assistant(`Lane ${index} is green.`, 0, { id: `reply-${index}`, at });
  const t = tool(`gh pr checks ${index}`, "execute", "completed", { output: "ok" });
  const command = `x ${index}`;
  Object.defineProperty(t.tool!, "command", { enumerable: true, get: () => { reads.count++; if (process.env.WHO) { const s = (new Error().stack ?? "").split("\n").slice(2, 5).map((l) => l.trim().replace(/^at /, "").replace(/\(.*\//, "(")).join(" < "); readers.set(s, (readers.get(s) ?? 0) + 1); } return command; } });
  return activity([t], 0, { id: `call-${index}`, at });
}
const prompt = user("Coordinate.", 0, { id: "live-user", at: START - 1000 });
const options = { working: true, turnStartedAtMs: START - 1000, now: START + (N + E) * 1000 };
let rows: AcpmuxRow[] = [prompt]; for (let i = 0; i < N; i++) rows.push(record(i));
const open = new Set<string>();
let turns = turnViewFrom(rows, open, options); let sub = subagentRowsFrom(turns.rows, open);
const known = new WeakMap(); let drawn = sub.rows; let layout = layoutConversation(drawn, 720, new Map(), undefined, known as any);
const t = { turns: [] as number[], sub: [] as number[], layout: [] as number[], reads: [] as number[] };
for (let e = 0; e < E; e++) {
  rows = [...rows, record(N + e)]; reads.count = 0; if (e === E - 1) readers.clear();
  let a = performance.now(); turns = turnViewFrom(rows, open, options, turns);
  let b = performance.now(); sub = subagentRowsFrom(turns.rows, open, sub);
  let c = performance.now(); const l = layoutConversation(sub.rows, 720, new Map(), undefined, known as any, { rows: drawn, layout });
  let d = performance.now(); t.turns.push(b - a); t.sub.push(c - b); t.layout.push(d - c); t.reads.push(reads.count); drawn = sub.rows; layout = l;
}
const p = (x: number[], q: number) => [...x].sort((a, b) => a - b)[Math.floor(q * x.length)]!.toFixed(2);
for (const [k, v] of Object.entries(t)) console.log(`SPLIT ${N} ${k}: p50 ${p(v, 0.5)} p95 ${p(v, 0.95)}`);
for (const [k, v] of [...readers].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`READER ${v} ${k}`);
const kinds = new Map<string, number>(); for (const r of turns.rows) kinds.set(String(r.kind), (kinds.get(String(r.kind)) ?? 0) + 1);
console.log(`SIZES ${N} turns.rows ${turns.rows.length} sub.rows ${sub.rows.length} kinds ${JSON.stringify([...kinds])}`);
