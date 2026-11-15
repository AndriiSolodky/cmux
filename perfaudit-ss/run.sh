#!/bin/bash
# perfaudit screen-share axis: the netem probe (cmux#42510's script) on the nightly's commit.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
echo "commit: $(git log -1 --format=%H%n%s | head -2 | tr '\n' ' ')"
which Xvfb >/dev/null || sudo -n apt-get install -y -q xvfb iproute2 ethtool >/dev/null 2>&1; which Xvfb tc ip cargo; sudo -n true && echo sudo-ok; sudo -n modprobe sch_netem && echo netem-ok
(cd cmux-tui && cargo build --release -p cmux-rd-host --bin cmux-rd 2>&1 | tail -5) || exit 3
BIN=$(pwd)/cmux-tui/target/release/cmux-rd
ls -la "$BIN" || exit 3
OUT=$(pwd)/perfaudit-ss/out; mkdir -p "$OUT"
P=cmux-tui/crates/cmux-rd-host/scripts
sudo -E python3 $P/screen-share-netem.py "$BIN" --rtt 2 --loss 0 --attempts 15 --samples 20 --out "$OUT/lan.jsonl" > /dev/null
sudo -E python3 $P/screen-share-netem.py "$BIN" --rtt 50 --loss 0 --attempts 15 --samples 20 --out "$OUT/rtt50.jsonl" > /dev/null
sudo -E python3 $P/screen-share-netem.py "$BIN" --rtt 50 --loss 2 --attempts 10 --samples 20 --out "$OUT/rtt50-loss2.jsonl" > /dev/null
sudo -E python3 $P/screen-share-netem.py "$BIN" --rtt 50 --loss 0 --attempts 4 --samples 20 --blip-at 3 --drop-seconds 2 --drop-seconds 10 --drop-seconds 60 --out "$OUT/drops.jsonl" > /dev/null
for f in "$OUT"/*.jsonl; do echo "== $(basename $f)"; python3 $P/screen-share-netem-summary.py "$f"; done
echo "== raw"
for f in "$OUT"/*.jsonl; do echo "-- $(basename $f)"; cat "$f"; done
