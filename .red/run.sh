set -u
echo "=== GREEN (head)"; python3 tests/test_ios_link_ffi_key.py 2>&1 | tail -25; echo "green exit=${PIPESTATUS[0]}"
for t in tests/test_ci_pull_request_caches_are_read_only.py tests/test_ios_app_review_gate.py tests/test_supplychain_security.py; do [ -f "$t" ] && { python3 "$t" >/tmp/o.txt 2>&1; echo "$t exit=$?"; tail -3 /tmp/o.txt; }; done
command -v actionlint >/dev/null && actionlint .github/workflows/ios-review-gate.yml .github/workflows/first-user-journey-ios.yml .github/workflows/ios-reliability-matrix.yml; echo "actionlint exit=$?"
echo "=== RED (base workflows, no key script)"; cp .red/*.yml .github/workflows/; rm .github/scripts/ios_link_ffi_key.py
python3 tests/test_ios_link_ffi_key.py 2>&1 | tail -8; echo "red exit=${PIPESTATUS[0]}"
