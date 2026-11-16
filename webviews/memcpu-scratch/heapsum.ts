// Summarize a .heapsnapshot: self size by node type+name (top 40), and the strings' total. bun heapsum.ts FILE
import fs from "node:fs";

const snap = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8"));
const meta = snap.snapshot.meta;
const fields: string[] = meta.node_fields;
const types: string[] = meta.node_types[0];
const nodes: number[] = snap.nodes;
const strings: string[] = snap.strings;
const width = fields.length;
const iType = fields.indexOf("type");
const iName = fields.indexOf("name");
const iSize = fields.indexOf("self_size");
const by = new Map<string, { size: number; count: number }>();
let total = 0;
for (let i = 0; i < nodes.length; i += width) {
  const type = types[nodes[i + iType]!]!;
  const size = nodes[i + iSize]!;
  total += size;
  let name = type === "object" || type === "closure" || type === "native" ? strings[nodes[i + iName]!]! : type;
  if (name.length > 60) name = name.slice(0, 60);
  const key = `${type}:${name}`;
  const entry = by.get(key) ?? { size: 0, count: 0 };
  entry.size += size;
  entry.count += 1;
  by.set(key, entry);
}
console.log(`total self ${(total / 2 ** 20).toFixed(1)} MB, nodes ${nodes.length / width}`);
for (const [key, { size, count }] of [...by.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 40))
  console.log(`${(size / 2 ** 20).toFixed(2).padStart(9)} MB ${String(count).padStart(9)} ${key}`);
