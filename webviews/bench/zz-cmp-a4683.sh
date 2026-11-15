# after then before, same runner
set -u
D=src/agent-session/acpmux/conversation
for n in 10000 2000; do echo "AFTER $(bun bench/live-turn-rows.bench.ts $n 300 5 2>&1 | grep 'live turn')"; done
echo "AFTER-SPLIT"; bun bench/zz-lt-split-a4683.ts 10000 2>&1 | grep -E "SPLIT"
echo "AFTER-TEST $(bun test $D/liveTurnIdentity.test.ts 2>&1 | grep -E '^ *[0-9]+ (pass|fail)' | tr '\n' ' ')"
cp bench/zz-base-a4683/turns.ts.txt $D/turns.ts; cp bench/zz-base-a4683/messageRuns.ts.txt $D/messageRuns.ts
for n in 10000 2000; do echo "BEFORE $(bun bench/live-turn-rows.bench.ts $n 300 5 2>&1 | grep 'live turn')"; done
echo "BEFORE-SPLIT"; bun bench/zz-lt-split-a4683.ts 10000 2>&1 | grep -E "SPLIT"
echo "BEFORE-TEST $(bun test $D/liveTurnIdentity.test.ts 2>&1 | grep -E '(pass|fail)$|Expected|Received' | head -6 | tr '\n' ' ')"
