#!/bin/bash
# Coordinator-shaped chat (anonymized), played live into the pane at 1x and 10x its records: JS heap after GC.
set -u
cd "$(dirname "$0")"
gunzip -kf coord-page.jsonl.gz
python3 -I anon.py coord-page.jsonl coord-x10.jsonl --tiles 10
mkdir -p one ten; cp coord-page.jsonl one/long; cp coord-x10.jsonl ten/long
cd ..
for side in one ten; do
  echo "=== $side"
  HEAP_SNAPSHOT=memcpu-scratch/$side.heapsnapshot timeout 2400 bun bench/transcript-replay.bench.ts --only none --log memcpu-scratch/$side/long 2>&1 | grep -vE '^\s+(open|live) shift' | tail -25
done
ls -la memcpu-scratch/*.heapsnapshot
for side in one ten; do echo "=== heap $side"; [ -f memcpu-scratch/$side.heapsnapshot ] && bun memcpu-scratch/heapsum.ts memcpu-scratch/$side.heapsnapshot; done
