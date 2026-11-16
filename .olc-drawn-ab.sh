#!/bin/bash
# Scratch (not committed): drawn-height helper, test red/green and head/base replay profile in one job.
cd webviews
t() { echo "##### $1 test"; bun test test/transcript-stream-no-commit-height-read.test.tsx 2>&1 | grep -E "stream commit|\(pass\)|\(fail\)|^ *[0-9]+ (pass|fail)"; }
prof() {
  echo "##### $1 round $2 replay"
  PROFILE=1 bun bench/transcript-replay.bench.ts --only long 2>&1 | grep -E "PERF_ROW.*long\.(token|thought|tool_call)_ms|: (self|total) ms per record|: most self|drawnHeightOf|row\.measure|reportRow"
}
t head
bun test test/transcript-row-height-input-pending.test.tsx test/drawn-height-priority.test.tsx 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
prof head 1
(cd .. && git apply -R .olc-drawn.patch)
t base
prof base 1
prof base 2
(cd .. && git apply .olc-drawn.patch)
prof head 2
