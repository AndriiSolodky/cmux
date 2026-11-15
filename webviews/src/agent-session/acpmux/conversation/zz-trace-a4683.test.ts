// A running turn is shaped again on every record (turns.ts `shapedTurn` keeps no cache for it): the
// rows a record did not change stay the objects drawn before (`steadyLiveRows`), so the transcript's
// layout and row memos keep them and a record costs what it changed, not the whole running turn.
import { expect, test } from "bun:test";
import type { AcpmuxRow } from "../model";
import { turnViewFrom } from "./turns";

const prompt: AcpmuxRow = { id: "prompt", version: 1, at: 1_000, kind: "user", text: "coordinate the lanes" };

function tool(index: number, status = "completed"): AcpmuxRow {
  return {
    id: `tool-${index}`,
    version: 1,
    at: 2_000 + index * 10,
    kind: "activity",
    items: [
      {
        kind: "tool",
        text: "Bash",
        tool: { id: `call-${index}`, title: `step ${index}`, kind: "execute", status, command: `echo ${index}` },
      },
    ],
    toolCount: 1,
  };
}

function reply(index: number): AcpmuxRow {
  return {
    id: `reply-${index}`,
    version: 1,
    at: 2_005 + index * 10,
    kind: "assistant",
    text: `Lane ${index} is green.`,
  };
}

/// A running coordinator turn: calls with a reply after every fourth, `count` records long.
function liveTurn(count: number): AcpmuxRow[] {
  const rows: AcpmuxRow[] = [prompt];
  for (let index = 0; index < count; index += 1) rows.push(index % 4 === 3 ? reply(index) : tool(index));
  return rows;
}

const options = (now: number) => ({ now, working: true, turnStartedAtMs: 1_000 });
const stacks = new Map<string, number>();
let on = false;
function countedTool(index: number, reads: { count: number }): AcpmuxRow {
  const row = tool(index);
  const call = row.items![0]!.tool!;
  const command = call.command!;
  Object.defineProperty(call, "command", { enumerable: true, get: () => { reads.count += 1; if (on) { const s = (new Error().stack ?? "").split("\n").slice(2, 7).map((l) => l.trim().replace(/\(.*\//, "(")).join(" < "); stacks.set(s, (stacks.get(s) ?? 0) + 1); } return command; } });
  return row;
}
test("zz trace", () => {
  const folds = new Set<string>();
  const reads = { count: 0 };
  const rows: AcpmuxRow[] = [prompt];
  for (let index = 0; index < 200; index += 1) rows.push(index % 4 === 3 ? reply(index) : countedTool(index, reads));
  let view = turnViewFrom(rows, folds, options(10_000));
  view = turnViewFrom([...rows], folds, options(10_000), view);
  const perRecord: number[] = [];
  for (let record = 200; record < 220; record += 1) {
    reads.count = 0; on = true;
    rows.push(record % 4 === 3 ? reply(record) : tool(record));
    view = turnViewFrom([...rows], folds, options(10_000), view);
    perRecord.push(reads.count);
    if (reads.count > 100) { console.log("ZZREC", record, reads.count); for (const [k, v] of [...stacks].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log("ZZSTACK", v, k); }
    stacks.clear();
  }
  console.log("ZZPER", perRecord.join(","));
});
