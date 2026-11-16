#!/usr/bin/env bash
# Scratch, not committed: time hot-verify.py plan in a worker-shaped blobless clone (goal hot-verify-share).
set -u
W=$(mktemp -d)
export HOME="$W/home"; mkdir -p "$HOME"
HEAD_SHA=b05d8327cb0aac90bac255f1c845646623ca91f8   # cmux#44015's head, whose look timed out in plan (run 43779426587)
APP_SHA=6f62dcd92a67253a36c5b8cc8d6484745eac487a    # the nightly's CMUXCommit in that look
t0=$(date +%s)
git clone -q --no-checkout --filter=blob:none --shallow-since=45.days.ago --branch feat-cmux-next \
  https://github.com/manaflow-ai/cmux.git "$W/cmux"
git -C "$W/cmux" fetch -q --filter=blob:none --shallow-since=45.days.ago origin \
  "+refs/heads/feat-cmux-next:refs/remotes/origin/feat-cmux-next" "+refs/pull/44015/head:refs/hot-verify/pr"
git -C "$W/cmux" cat-file -e "$APP_SHA^{commit}" || git -C "$W/cmux" fetch -q --filter=blob:none origin "$APP_SHA"
echo "clone+fetch: $(( $(date +%s) - t0 )) s"
mkdir -p "$W/engine/scripts"
cp -R scripts/cmux-next "$W/engine/scripts/"
for run in cold warm; do
  t=$(date +%s)
  GIT_TRACE2_EVENT="$W/trace-$run.json" timeout 900 python3 -I "$W/engine/scripts/cmux-next/hot-verify.py" plan \
    --source "sha:$HEAD_SHA" --repo "$W/cmux" --json --base "$APP_SHA" > "$W/plan-$run.json" 2> "$W/plan-$run.err"
  echo "plan $run: exit $? in $(( $(date +%s) - t )) s"
  tail -n 3 "$W/plan-$run.err"
  python3 - "$W/trace-$run.json" <<'PY'
import json, sys, collections
starts, rows = {}, []
lazy = 0
for line in open(sys.argv[1], errors="replace"):
    try:
        e = json.loads(line)
    except ValueError:
        continue
    if e.get("event") == "start":
        starts[e["sid"]] = (e.get("t_abs", 0.0), " ".join(e.get("argv", []))[:160])
        if "--filter=blob:none" in e.get("argv", []) and "--stdin" in e.get("argv", []):
            lazy += 1
    elif e.get("event") == "exit" and e["sid"] in starts:
        t, argv = starts[e["sid"]]
        rows.append((e.get("t_abs", 0.0), argv))
print(f"git processes: {len(rows)}; lazy blob fetches: {lazy}")
by = collections.Counter()
for secs, argv in rows:
    by[" ".join(argv.split()[:4])] += secs
for argv, secs in by.most_common(12):
    print(f"{secs:8.1f}s  {argv}")
PY
done
