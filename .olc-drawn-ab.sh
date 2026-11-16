#!/bin/bash
# Scratch (not committed): drawn-height helper, head/base A/B of replay profile and turn-end shift in one job.
cd webviews
prof() {
  echo "##### $1 round $2 replay"
  PROFILE=1 bun bench/transcript-replay.bench.ts --only long 2>&1 | grep -E "PERF_ROW.*long\.(token|thought|tool_call)_ms|drawnHeightOf"
}
shift_() {
  echo "##### $1 shift"
  bun bench/transcript-turn-end-shift.bench.ts 3 --engines chromium 2>&1 | tail -25
}
prof head 1
shift_ head
(cd .. && git apply -R .olc-drawn.patch)
prof base 1
shift_ base
prof base 2
(cd .. && git apply .olc-drawn.patch)
prof head 2
