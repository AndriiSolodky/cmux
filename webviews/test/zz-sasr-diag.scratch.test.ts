import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { rowsFromRecording } from "../src/gallery/fixtures/recording";
import { withSubagentLines } from "../src/agent-session/acpmux/subagents/runningTray";
import { turnView } from "../src/agent-session/acpmux/conversation/turns";
import { layoutConversation } from "../src/agent-session/acpmux/model";

test("diag", async () => {
  const text = readFileSync(new URL("./fixtures/zz-sasr-diag.scratch.ndjson", import.meta.url), "utf8");
  const raw = await rowsFromRecording(text, "claude");
  console.log("RAW", raw.map((r) => `${r.kind}:${r.id}:${r.incoming?.kind ?? ""}:${r.inBackground ?? ""}`).join("\n"));
  const lined = withSubagentLines(raw);
  const rows = turnView(lined, new Set(), { agentFamily: "claude" });
  const layout = layoutConversation(rows, 720, new Map());
  rows.forEach((r, i) =>
    console.log(
      "ROW",
      i,
      r.kind,
      r.id,
      `incoming=${r.incoming?.kind ?? ""}`,
      `bg=${r.inBackground ?? ""}`,
      `mark=${layout.marks?.[i]}`,
      `gap=${layout.gaps[i]}`,
      `h=${layout.heights[i]}`,
    ),
  );
});
