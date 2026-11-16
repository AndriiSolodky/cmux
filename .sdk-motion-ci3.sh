set -uo pipefail
out="${FAST_CHECKS_OUT:-/tmp/out}"; mkdir -p "$out"
status=0
step() { echo "=== $*"; "$@" > >(tee -a "$out/log.txt") 2>&1 || { echo "FAILED: $*" | tee -a "$out/failed.txt"; status=1; }; }
host=cmux-tui/crates/cmux-app-host
step bun $host/js/build.ts --check
step bun $host/tools/gen-cmux-global.ts --check
step bun samples/apps/build.ts
step bun examples/extensions/build.ts
step bash scripts/cmux-next/sync-app-runtime.sh
step bash -c "cd $host/js && bun test"
step bash -c "cd $host/app-test && bun test"
step bash -c "cd samples/apps && bun test"
step bun first-party-apps/fork-check.ts
step bash -c "cd cmux-tui/crates/cmux-extension-sdk/typescript && ls && (bunx tsc --version || true)"
cd webviews
step bunx vp fmt src/apps/scene
step bun test src/apps/scene
step bun test src/apps/scene/SceneRenderer.test.tsx
step bun test src/apps/scene/store.test.ts
step bun test src/apps/scene/panels.test.tsx
step bunx vp lint src/apps/scene
step bun scripts/check-design-tokens.ts
step bunx vp check --no-fmt --no-lint
cd ..
git diff --binary > "$out/regen.patch"
git status --porcelain > "$out/status.txt"
exit $status
