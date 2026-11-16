set -uo pipefail
out="${FAST_CHECKS_OUT:-/tmp/out}"; mkdir -p "$out"
status=0
step() { echo "=== $*"; "$@" > >(tee -a "$out/log.txt") 2>&1 || { echo "FAILED: $*" | tee -a "$out/failed.txt"; status=1; }; }
host=cmux-tui/crates/cmux-app-host
step bun $host/js/build.ts
step bun $host/tools/gen-cmux-global.ts
step bun samples/apps/build.ts
step bun examples/extensions/build.ts
step bash scripts/cmux-next/sync-app-runtime.sh
step bash -c "cd $host/js && bun test"
step bash -c "cd $host/app-test && bun test"
step bash -c "cd samples/apps && bun test"
step bun first-party-apps/fork-check.ts
step python3 scripts/cmux-next/check-motion-tokens.py
(cd webviews && bunx vp fmt src/apps/scene test/no-breathing-dots.test.ts test/popover-instant-open.test.ts test/agent-pane-no-capsules.test.ts) > /dev/null 2>&1
step bash -c "git fetch -q --depth=200 origin feat-cmux-next 2>/dev/null; base=\$(git merge-base HEAD FETCH_HEAD 2>/dev/null || true); mkdir -p $out/rd; if [ -n \"\$base\" ]; then python3 scripts/ci/react_doctor_gate.py --changed-from \$base --out-dir $out/rd; else python3 scripts/ci/react_doctor_gate.py --project webviews --out-dir $out/rd; fi"
step bash scripts/cmux-next/build-agent-pane-web.sh
cd webviews
step bun test src/apps/scene
step bun test test/no-breathing-dots.test.ts test/popover-instant-open.test.ts test/agent-pane-no-capsules.test.ts
step bunx vp lint src/apps/scene
step bun scripts/check-design-tokens.ts
step bunx vp check --no-fmt --no-lint
cd ..
git diff --binary > "$out/regen.patch"
git status --porcelain > "$out/status.txt"
exit $status
