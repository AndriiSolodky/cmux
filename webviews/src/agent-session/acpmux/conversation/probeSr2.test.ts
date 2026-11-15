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
