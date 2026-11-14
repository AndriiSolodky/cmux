#!/usr/bin/env bash
# Scratch job (not committed): after (head-still, the tray suites, lint, types), then base for
# head-still's failure and the suites that fail.
cd "$(dirname "$0")/../.."
set +e
S=test/.scratch-old
T=src/agent-session/acpmux/subagents
echo "=== AFTER head-still"
bun test test/composer-hat-head-still.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|error|Error|Expected|Received|intercepts|^ *[0-9]+ (pass|fail)" | cut -c1-400 | head -40
echo "=== AFTER suites"
bun test test/composer-hat-tuck.test.tsx test/composer-hat-fold-balance.test.ts test/subagent-tray-trailing.test.ts \
  test/subagent-tray-kinds.test.ts test/subagent-tray-columns.test.ts test/agent-pane-composer-dock-motion.test.ts \
  test/subagent-tray-composer-geometry.test.ts test/composer-hat-line-gap.test.ts test/tray-pull-tab-style.test.ts \
  test/subagent-tray.test.tsx test/subagent-tray-expand-shift.test.ts test/composer-hat-plan.test.tsx \
  test/background-tasks-open.test.tsx test/agent-pane-dock-gutters.test.ts test/hat-header-time-width.test.ts \
  test/running-strip.test.ts test/gallery-coverage.test.ts 2>&1 \
  | grep -E "\(fail\)|intercepts|^ *[0-9]+ (pass|fail)" | cut -c1-300 | head -40
echo "=== AFTER lint/types"
./node_modules/.bin/vp lint 2>&1 | tail -4
./node_modules/.bin/vp check --no-fmt --no-lint 2>&1 | grep -E "error|Found" | cut -c1-300 | head -20
bun run check:design-tokens 2>&1 | tail -2
bun run check:browser-lanes 2>&1 | tail -2
echo "=== BASE"
cp $S/SubagentTray.tsx.base.txt $T/SubagentTray.tsx
cp $S/SubagentTrayOpen.gallery.ts.base.txt $T/SubagentTrayOpen.gallery.ts
cp $S/subagents.css.base.txt $T/subagents.css
cp $S/registry.ts.base.txt src/experiments/registry.ts
cp $S/ComposerHatHeadStage.tsx.base.txt src/gallery/fixtures/ComposerHatHeadStage.tsx
rm -f $T/hatTuck.experiment.ts $T/ComposerHatTuck.gallery.ts
bun test test/gallery-coverage.test.ts test/subagent-tray-expand-shift.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|^ *[0-9]+ (pass|fail)" | cut -c1-300
echo "=== DONE"
