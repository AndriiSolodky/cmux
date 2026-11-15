// Scratch: inclusive and self time per function from a .cpuprofile. Not committed.
import fs from "node:fs";
const p = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8"));
const byId = new Map<number, any>(p.nodes.map((n: any) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const key = (n: any) => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}`;
const incl = new Map<string, number>(); const self = new Map<string, number>();
p.samples.forEach((s: number, i: number) => {
  const dt = p.timeDeltas[i] ?? 0; const seen = new Set<string>();
  self.set(key(byId.get(s)), (self.get(key(byId.get(s))) ?? 0) + dt);
  for (let id: number | undefined = s; id !== undefined; id = parent.get(id)) { const k = key(byId.get(id)); if (seen.has(k)) continue; seen.add(k); incl.set(k, (incl.get(k) ?? 0) + dt); }
});
for (const [k, v] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, 45)) console.log(`INCL ${(v / 1000).toFixed(0)}ms ${k}`);
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`SELF ${(v / 1000).toFixed(0)}ms ${k}`);
