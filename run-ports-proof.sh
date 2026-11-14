set -u
git apply -R fix-ports.patch || { echo "REVERSE APPLY FAILED"; exit 9; }
echo "=== RED: base code, new test ==="
(cd cmux-tui && cargo test -p cmux-tui-core --test terminal_ports 2>&1 | tail -40; exit ${PIPESTATUS[0]})
red=$?
echo "RED_EXIT=$red"
git apply fix-ports.patch || { echo "APPLY FAILED"; exit 9; }
echo "=== GREEN: fix ==="
(cd cmux-tui && cargo test -p cmux-tui-core --test terminal_ports 2>&1 | tail -40; exit ${PIPESTATUS[0]})
green=$?
echo "GREEN_EXIT=$green"
(cd cmux-tui && cargo test -p cmux-tui-core --lib terminal_ports 2>&1 | tail -15; exit ${PIPESTATUS[0]})
unit=$?
(cd cmux-tui && cargo test -p cmux-tui-platform --lib listening_sockets 2>&1 | tail -15; exit ${PIPESTATUS[0]})
plat=$?
echo "UNIT_EXIT=$unit PLATFORM_EXIT=$plat"
[ "$red" -ne 0 ] && [ "$green" -eq 0 ] && [ "$unit" -eq 0 ] && [ "$plat" -eq 0 ]
