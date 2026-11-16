#!/bin/bash
# Scratch (helper rdmm): React Doctor detail, then composer-typing stream profile with the bundle kept.
cd webviews
bun install --frozen-lockfile >/dev/null 2>&1
MODE=${1:-diag}
rd() {
  rm -rf /tmp/rdmm-rd; mkdir -p /tmp/rdmm-rd
  (cd .. && python3 scripts/ci/react_doctor_gate.py --project webviews --out-dir /tmp/rdmm-rd 2>&1 | grep -vE "^##\[error\]" | grep -A30 "react-doctor: webviews" | head -40)
  bun -e 'const r=JSON.parse(require("fs").readFileSync("/tmp/rdmm-rd/webviews.json","utf8"));for(const d of r.diagnostics){const p=(d.id||"").split("::")[0]||d.filePath;if(d.severity==="error"&&/VirtualTranscript.tsx|Thinking.tsx|ThreadMinimap.tsx|inputPending/.test(p)&&/refs|no-ref-current|effect-needs-cleanup/.test(d.rule))console.log(p+":"+d.line+" "+d.plugin+"/"+d.rule+" "+(d.message||"").slice(0,160))}'
}
keep() { sed -i 's/releases.push(() => fs.rmSync(out, { recursive: true, force: true }));/console.log("BENCH_OUT " + out);/' bench/composer-typing.bench.ts; }
pr() {
  echo "##### profile $1"
  bun bench/composer-typing.bench.ts --lengths 1500 --keys 60 --modes stream --profile > /tmp/rdmm-$1.txt 2>&1
  grep -E "COMPOSER-TYPING|PROFILE|ms/key" /tmp/rdmm-$1.txt | grep -A25 "self:" | head -30
  grep -E "COMPOSER-TYPING" /tmp/rdmm-$1.txt
  out=$(grep -oE "BENCH_OUT \S+" /tmp/rdmm-$1.txt | tail -1 | cut -d" " -f2)
  for spec in $(grep -A6 "self:" /tmp/rdmm-$1.txt | grep -oE "main-[^ ]*\.js:[0-9]+" | head -4); do
    f=${spec%%:*}; l=${spec##*:}; file=$(find "$out" -name "$f" | head -1)
    echo "----- $spec ($file)"; sed -n "$((l-25)),$((l+30))p" "$file"
  done
}
swap() { (cd .. && git apply $1 .olc-fu.patch) || echo "SWAP FAILED $1"; }
if [ "$MODE" = diag ]; then rd; keep; pr head; fi
if [ "$MODE" = tests ]; then
  bun test test/transcript-pin-pass-no-forced-read.test.tsx test/thread-minimap-token-renders.test.tsx test/transcript-row-height-input-pending.test.tsx test/transcript-stream-no-commit-height-read.test.tsx src/agent-session/acpmux/conversation/ test/thread-minimap*.test.tsx test/thread-rail*.test.tsx test/chat-minimap*.test.tsx test/transcript-*.test.tsx test/drawn-height*.test.tsx 2>&1 | grep -E "\(fail\)| pass$| fail$|error:" | head -40
  bun run typecheck 2>&1 | tail -5
  rd
fi
if [ "$MODE" = ab ]; then
  keep
  ct() { echo "##### typing $1 $2"; bun bench/composer-typing.bench.ts --lengths 1500 --keys 60 --modes stream 2>&1 | grep -E "COMPOSER-TYPING|rows"; }
  swap -R; ct base 1; swap ""; ct head 1; ct head 2; swap -R; ct base 2
  pr base; swap ""; pr head
fi
