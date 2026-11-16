#!/usr/bin/env bash
set -u
echo "== SUITES (fix)"
cd cmux-tui; st=0
cargo test -p cmux-rd-core -p cmux-rd-engine > /tmp/t1.log 2>&1 || { st=1; echo T1; grep -E "FAILED|panicked|left:|right:|^error" -A3 /tmp/t1.log | head -40; }
cargo test --manifest-path crates/cmux-app-ffi/Cargo.toml -p cmux-rd-ffi > /tmp/t2.log 2>&1 || { st=1; echo T2; grep -E "FAILED|panicked|left:|right:|^error" -A3 /tmp/t2.log | head -40; }
cargo clippy -p cmux-rd-core -p cmux-rd-engine --all-targets -- -D warnings > /tmp/c1.log 2>&1 || { st=1; echo C1; tail -40 /tmp/c1.log; }
cargo clippy --manifest-path crates/cmux-app-ffi/Cargo.toml -p cmux-rd-ffi --all-targets -- -D warnings > /tmp/c2.log 2>&1 || { st=1; echo C2; tail -40 /tmp/c2.log; }
cargo check --manifest-path crates/cmux-rd-host/Cargo.toml --all-targets --no-default-features --features bench,link > /tmp/h.log 2>&1 || { st=1; echo H; tail -40 /tmp/h.log; }
echo STATUS=$st; exit $st
