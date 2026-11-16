#!/bin/bash
# Scratch (gbcr-ro helper, not committed): profile transcript-replay long, keep the build, print the
# bundle around each getBoundingClientRect caller line.
cd webviews
PB=$(mktemp -d)/pb
PROFILE=1 PROFILE_LINES=1 PROFILE_BUILD=$PB bun bench/transcript-replay.bench.ts --only long > /tmp/prof.txt 2>&1
grep -vE "^\s*$" /tmp/prof.txt | grep -E "self ms per record|getBoundingClientRect|PERF_ROW .*long\." 
MAIN=$(ls $PB/assets/main-*.js | head -1)
for n in $(grep -oE "getBoundingClientRect@[0-9]+" /tmp/prof.txt | cut -d@ -f2 | sort -u); do
  echo "===== main line $n ($MAIN)"
  # nearest enclosing function headers above
  awk -v n=$n 'NR<=n && /^(  )?(function |const [A-Za-z_$]+ = |var [A-Za-z_$]+ = )/ {h=NR": "$0} NR==n {print "enclosing: " h; exit}' $MAIN | cut -c1-200
  sed -n "$((n-30)),$((n+8))p" $MAIN | cut -c1-200
done
grep -n "//# sourceMappingURL\|^// src/agent-session/acpmux" $MAIN | awk -F: -v n="$(grep -oE "getBoundingClientRect@[0-9]+" /tmp/prof.txt | head -1 | cut -d@ -f2)" '$1<=n {last=$0} END {print "source section: " last}'
