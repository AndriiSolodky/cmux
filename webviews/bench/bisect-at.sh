#!/usr/bin/env bash
# Temporary (cmux#24569 group 1): runs this checkout's bench files against the pane at each SHA given.
# For each SHA: a worktree at it, its own webviews deps, this tip's bench/ and test/support/ over it, then each bench.
#   bash bench/bisect-at.sh "turn-end:transcript-turn-end-shift.bench.ts 3 --engines chromium,webkit" -- SHA...
# Each bench spec is NAME:FILE ARGS; prints `BISECT <sha> <name> <line>` for every PERF_ROW, shift and miss line.
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
specs=()
while [[ $# -gt 0 && "$1" != "--" ]]; do specs+=("$1"); shift; done
shift
root="${TMPDIR:-/tmp}/bisect-at"
mkdir -p "$root"
for sha in "$@"; do
  git -C "$repo" fetch -q --depth=1 origin "$sha" || { echo "BISECT $sha fetch-failed"; continue; }
  full="$(git -C "$repo" rev-parse FETCH_HEAD)"
  tree="$root/${full:0:11}"
  git -C "$repo" worktree add -q --detach "$tree" "$full" || { echo "BISECT $sha worktree-failed"; continue; }
  (cd "$tree/webviews" && bun install --frozen-lockfile >/dev/null 2>&1) || echo "BISECT $sha install-failed"
  cp -R "$here/bench/." "$tree/webviews/bench/"
  mkdir -p "$tree/webviews/test/support"
  cp -R "$here/test/support/." "$tree/webviews/test/support/"
  [[ -f "$tree/webviews/src/gallery/shift.ts" ]] || cp "$here/src/gallery/shift.ts" "$tree/webviews/src/gallery/shift.ts"
  for spec in "${specs[@]}"; do
    name="${spec%%:*}"
    rest="${spec#*:}"
    envs=()
    if [[ "$rest" == *"|"* ]]; then read -r -a envs <<<"${rest%%|*}"; rest="${rest#*|}"; fi
    read -r -a cmd <<<"$rest"
    log="$root/${full:0:11}-$name.log"
    (cd "$tree/webviews" && env "${envs[@]}" timeout 900 bun "bench/${cmd[0]}" "${cmd[@]:1}") >"$log" 2>&1
    echo "BISECT ${full:0:11} $name exit $?"
    grep -E 'DETAIL|PERF_ROW|live shift|BUDGET MISS|^[0-9] \||turn-end-shift: .*FAILED|^  (layout-shift|box move)' "$log" \
      | sed "s/^/BISECT ${full:0:11} $name /" | head -120
    [[ -n "${FAST_CHECKS_OUT:-}" ]] && cp "$log" "$FAST_CHECKS_OUT/" 2>/dev/null
  done
  git -C "$repo" worktree remove --force "$tree"
done
