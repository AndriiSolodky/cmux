#!/usr/bin/env bash
# Scratch job (not committed): after, with full output; then base for the suites that failed.
cd "$(dirname "$0")/../.."
set +e
rm -f test/zz-hat-tuck-capture.scratch.test.ts
T=src/agent-session/acpmux/subagents
echo "=== AFTER head-still"
bun test test/composer-hat-head-still.test.ts 2>&1 | grep -v "^\s*$" | cut -c1-400 | tail -60
echo "=== AFTER expand-shift, coverage"
bun test test/subagent-tray-expand-shift.test.ts test/gallery-coverage.test.ts 2>&1 | grep -v "^\s*$" | cut -c1-300 | tail -60
echo "=== AFTER lint/types"
./node_modules/.bin/vp lint 2>&1 | tail -8
./node_modules/.bin/vp check --no-fmt --no-lint 2>&1 | tail -15
echo "=== BASE expand-shift, coverage"
rm -f $T/hatTuck.experiment.ts $T/ComposerHatTuck.gallery.ts test/composer-hat-head-still.test.ts
git checkout -q HEAD~3 -- src test 2>&1 | tail -2
git log --oneline -4 | cat
bun test test/subagent-tray-expand-shift.test.ts test/gallery-coverage.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|^ *[0-9]+ (pass|fail)" | cut -c1-300
echo "=== DONE"
