#!/bin/bash
# Scratch (gbcr-ro helper, not committed): transcript-replay long profile, token/thought sections in full.
cd webviews
PROFILE=1 PROFILE_LINES=1 bun bench/transcript-replay.bench.ts --only long > /tmp/prof.txt 2>&1
grep -vE "^\s*$" /tmp/prof.txt | awk '/^  (token|thought): /{p=1} /^  (tool_output|tool_call): /{p=0} /PERF_ROW/{p=0} p' | head -160
echo "#### no-lines"
PROFILE=1 bun bench/transcript-replay.bench.ts --only long > /tmp/prof2.txt 2>&1
grep -vE "^\s*$" /tmp/prof2.txt | awk '/^  (token|thought): total/{p=1} /^  (tool_output|tool_call|token|thought): (self|most)/{p=0} /PERF_ROW/{p=0} p' | head -100
