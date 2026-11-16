set -u
cd cmux-tui
A=crates/cmux-tui-core/src/apps
F=apps::supervisor_tests::under_load
echo "nproc $(nproc)"; uptime
echo "=== AFTER: apps tests"
cargo test -p cmux-tui-core --lib apps:: 2>&1 | grep -E "^test result|FAILED|panicked|^error|^failures|^    apps::" | head -60
echo "=== AFTER: host spawn tests"
cargo test -p cmux-tui-core --lib apps::host::spawn_tests 2>&1 | grep -E "^test |^test result"
echo "=== AFTER: bench"
CMUX_APPS_LOAD_BENCH=1 cargo test -p cmux-tui-core --lib $F::load_bench -- --nocapture --test-threads=1 2>&1 | grep -E "APPS-LOAD-BENCH|^test result|panicked"
mkdir -p /tmp/apps-after && cp $A/host.rs $A/hosts.rs $A/supervisor.rs /tmp/apps-after/
cp ../apps-ab-scratch/host.rs ../apps-ab-scratch/hosts.rs ../apps-ab-scratch/supervisor.rs $A/
echo "=== BEFORE: red tests"
cargo test -p cmux-tui-core --lib $F::a_slow 2>&1 | grep -E "^test |^test result|waited" | head -10
echo "=== BEFORE: bench"
CMUX_APPS_LOAD_BENCH=1 cargo test -p cmux-tui-core --lib $F::load_bench -- --nocapture --test-threads=1 2>&1 | grep -E "APPS-LOAD-BENCH|^test result|panicked"
cp /tmp/apps-after/* $A/
echo "=== AFTER again: bench"
CMUX_APPS_LOAD_BENCH=1 cargo test -p cmux-tui-core --lib $F::load_bench -- --nocapture --test-threads=1 2>&1 | grep -E "APPS-LOAD-BENCH|^test result|panicked"
