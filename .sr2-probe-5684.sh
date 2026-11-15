#!/usr/bin/env bash
# scratch: full output of the base reds (not committed)
show() { grep -A40 -E "^(FAIL|ERROR):" | grep -vE '^\s*File|^-+$' | head -60; }
echo "=== fleet"; python3 tests/test_ci_fleet_rule_lints.py 2>&1 | show
echo "=== outbound"; python3 tests/test_outbound_hosts.py 2>&1 | show
echo "=== routing"; python3 tests/test_runner_routing_table.py 2>&1 | show
echo "=== excuse"; python3 tests/test_base_red_excuse.py GuardJobsFollowTheWorkflows 2>&1 | show
echo "=== shortgates"; python3 scripts/lint-short-gates.py 2>&1 | tail -8
echo "=== tour"; python3 tests/test_cmux_next_tour.py CheckedInToursTests 2>&1 | grep -E "TourError" | head
echo "=== dom"; cd webviews && bun install --frozen-lockfile >/dev/null 2>&1; bun test test/dom-teardown-lint.test.ts 2>&1 | tail -40
