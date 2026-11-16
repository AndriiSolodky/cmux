#!/bin/bash
# Scratch (gbcr-ro helper, not committed): name drawnHeightOf's caller in transcript-replay long.
cd webviews
PB=$(mktemp -d)/pb
PROFILE=1 PROFILE_BUILD=$PB bun bench/transcript-replay.bench.ts --only long > /tmp/prof.txt 2>&1
grep -vE "^\s*$" /tmp/prof.txt | awk '/^  token: total/{p=1} /^  thought: self/{p=0} p' | head -30
MAIN=$(ls $PB/assets/main-*.js | head -1)
for n in $(awk '/^  token: total/{p=1} /^  thought: self/{p=0} p' /tmp/prof.txt | grep -E "\(anon\) main-|drawnHeightOf|chaseFollow|rowTop" | grep -oE "main-[^ ]+\.js:[0-9]+" | cut -d: -f2 | sort -u); do
  echo "===== main line $n"
  sed -n "$((n-12)),$((n+6))p" $MAIN | cut -c1-160
done
