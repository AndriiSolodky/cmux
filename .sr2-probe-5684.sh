#!/usr/bin/env bash
# scratch: verify the base-red fixes (not committed)
rc=0
run() { local name="$1"; shift; if "$@" > /tmp/sr2-out.log 2>&1; then echo "PASS $name"; else echo "FAIL $name"; tail -25 /tmp/sr2-out.log; rc=1; fi; }
run fleet python3 tests/test_ci_fleet_rule_lints.py
run outbound python3 tests/test_outbound_hosts.py
run routing python3 tests/test_runner_routing_table.py
run excuse python3 tests/test_base_red_excuse.py GuardJobsFollowTheWorkflows
run shortgates python3 scripts/lint-short-gates.py
run tour python3 tests/test_cmux_next_tour.py
run hybrid python3 tests/test_cmux_next_hybrid_ref_capture.py
run never-silent python3 tests/test_cmux_next_same_tree_status_never_silent.py
run tree-key-embeds bash scripts/cmux-next/tests/tree-key-embeds.test.sh
run scrollbars bash scripts/cmux-next/check-scrollbars.sh .
run probe bash scripts/cmux-next/tests/pin-cmux-tui-probe.test.sh
export PATH="$HOME/.bun/bin:$PATH"
if command -v bun >/dev/null; then
  (cd webviews && bun install --frozen-lockfile >/dev/null 2>&1)
  run dom-lint bash -c 'cd webviews && bun test test/dom-teardown-lint.test.ts'
  run failed-send bash -c 'cd webviews && bun test test/failed-send-keeps-prompt.test.ts'
else
  echo "SKIP bun tests: no bun"
fi
echo "overall rc=$rc"
