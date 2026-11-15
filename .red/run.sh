echo "=== GREEN (head)"; python3 tests/test_ios_link_ffi_key.py 2>&1 | grep -E 'FAIL|ERROR|Ran|^OK'; echo "green exit=${PIPESTATUS[0]}"
for t in tests/test_ci_pull_request_caches_are_read_only.py tests/test_ios_app_review_gate.py tests/test_supplychain_security.py; do python3 "$t" >/tmp/o.txt 2>&1; echo "$t exit=$?"; done
echo "=== RED (previous commit's key script and workflows)"; cp .red/*.yml .github/workflows/; cp .red/ios_link_ffi_key.py .github/scripts/
python3 tests/test_ios_link_ffi_key.py 2>&1 | grep -E '^(FAIL|ERROR):|AssertionError|Ran|FAILED'; echo "red exit=${PIPESTATUS[0]}"
