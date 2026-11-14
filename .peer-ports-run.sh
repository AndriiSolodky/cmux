set -u
git apply -R .peer-ports-fix.patch || { echo "REVERSE APPLY FAILED"; exit 9; }
echo "=== RED: base code, new test ==="
(cd cmux-tui && timeout 1500 cargo test -p cmux-tui-core --test terminal_ports 2>&1 | tail -40; exit ${PIPESTATUS[0]})
red=$?
echo "RED_EXIT=$red"
git apply .peer-ports-fix.patch || { echo "APPLY FAILED"; exit 9; }
echo "=== GREEN: fix ==="
(cd cmux-tui && timeout 1500 cargo test -p cmux-tui-core --test terminal_ports 2>&1 | tail -40; exit ${PIPESTATUS[0]})
green=$?
echo "GREEN_EXIT=$green"
echo "=== UNIT ==="
(cd cmux-tui && cargo test -p cmux-tui-core --lib terminal_port_watch 2>&1 | tail -15; exit ${PIPESTATUS[0]})
unit=$?
echo "=== FMT ==="
(cd cmux-tui && cargo fmt -p cmux-tui-core -- --check 2>&1 | head -150; exit ${PIPESTATUS[0]})
fmt=$?
echo "=== CLIPPY ==="
(cd cmux-tui && cargo clippy -p cmux-tui-core --all-targets -- -D warnings 2>&1 | grep -v '^\s*Compiling\|^\s*Checking' | tail -80; exit ${PIPESTATUS[0]})
clippy=$?
echo "RED_EXIT=$red GREEN_EXIT=$green UNIT_EXIT=$unit FMT_EXIT=$fmt CLIPPY_EXIT=$clippy"
[ "$red" -ne 0 ] && [ "$green" -eq 0 ] && [ "$unit" -eq 0 ] && [ "$fmt" -eq 0 ] && [ "$clippy" -eq 0 ]
