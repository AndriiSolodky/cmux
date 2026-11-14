#!/usr/bin/env bash
# Scratch job (not committed): after, the other suites, the captures, then before on the old files.
cd "$(dirname "$0")/../.."
set +e
T=src/agent-session/acpmux/subagents
echo "=== AFTER head-still"
bun test test/composer-hat-head-still.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|error:|Expected|Received|^ *[0-9]+ (pass|fail)" | cut -c1-600
echo "=== SUITES"
bun test test/composer-hat-tuck.test.tsx test/composer-hat-fold-balance.test.ts test/subagent-tray-trailing.test.ts \
  test/subagent-tray-kinds.test.ts test/subagent-tray-columns.test.ts test/agent-pane-composer-dock-motion.test.ts \
  test/subagent-tray-composer-geometry.test.ts test/composer-hat-line-gap.test.ts test/tray-pull-tab-style.test.ts \
  test/gallery-coverage.test.ts test/subagent-tray.test.tsx test/subagent-tray-expand-shift.test.ts 2>&1 \
  | grep -E "\(fail\)|error:|Expected|Received|^ *[0-9]+ (pass|fail)|^test/" | cut -c1-600
echo "=== CHECKS"
bun run check:design-tokens 2>&1 | tail -8
bun run check:browser-lanes 2>&1 | tail -4
bun run check:popup-hover-reveals 2>&1 | tail -4
vp lint 2>&1 | tail -8
vp check --no-fmt --no-lint 2>&1 | tail -15
echo "=== CAPTURE"
bun test test/zz-hat-tuck-capture.scratch.test.ts 2>&1 | grep -E "tuck |\(pass\)|\(fail\)|error" | cut -c1-400
echo "=== BEFORE head-still (old subagents.css and SubagentTray.tsx)"
cp test/.scratch-old/subagents.css $T/subagents.css
cp test/.scratch-old/SubagentTray.tsx $T/SubagentTray.tsx
bun test test/composer-hat-head-still.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|error: .*(left|right):|^ *[0-9]+ (pass|fail)" | cut -c1-400
echo "=== DONE"
