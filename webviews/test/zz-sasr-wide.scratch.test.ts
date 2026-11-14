import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { rowsFromRecording } from "../src/gallery/fixtures/recording";
import { withSubagentLines } from "../src/agent-session/acpmux/subagents/runningTray";
import { turnView } from "../src/agent-session/acpmux/conversation/turns";
import { layoutConversation } from "../src/agent-session/acpmux/model";

test("wide diag", async () => {
  const text = readFileSync(
    new URL("../src/gallery/fixtures/recordings/zz-sasr-wide.scratch.ndjson", import.meta.url),
    "utf8",
  );
  const raw = await rowsFromRecording(text, "claude");
  const rows = turnView(withSubagentLines(raw), new Set(), { agentFamily: "claude" });
  const layout = layoutConversation(rows, 720, new Map());
  const at = rows.findIndex((r) => r.id === "subagentStarted:subagents-2865046");
  console.log("WIDE index", at, "of", rows.length);
  rows.forEach((r, i) => {
    if (r.kind !== "subagentStarted" && Math.abs(i - at) > 6) return;
    console.log(
      "WIDE",
      i,
      r.kind,
      r.id.slice(0, 60),
      `bg=${r.inBackground ?? ""}`,
      `incoming=${r.incoming?.kind ?? ""}`,
      `settled=${r.settled ?? ""}`,
      `mark=${layout.marks?.[i]}`,
      `gap=${layout.gaps[i]}`,
      `h=${layout.heights[i]}`,
    );
  });
});
