O=$FAST_CHECKS_OUT
T="test/transcript-tail-scroll.test.ts test/transcript-older-scroll.test.ts test/transcript-older-pages-anchor.test.ts"
F=webviews/src/agent-session/acpmux/VirtualTranscript.tsx
(cd webviews && bun test $T > $O/A.txt 2>&1)
sed -i 's|userScrollIntent(node).isPressed(),|userScrollIntent(node).isHeld(),|' $F
grep -c "isHeld()," $F > $O/B-check.txt
(cd webviews && bun test $T > $O/B.txt 2>&1)
sed -i "0,/userScrollIntent(node).isHeld(),/s//userScrollIntent(node).isPressed(),/" $F; git apply .citest-base2-84dc.patch > $O/base-apply.txt 2>&1
git checkout -- webviews/test 2>/dev/null; git status --short >> $O/base-apply.txt
(cd webviews && bun test test/transcript-tail-scroll.test.ts test/transcript-older-scroll.test.ts > $O/base.txt 2>&1)
grep -hE "\(pass\)|\(fail\)" $O/A.txt $O/B.txt $O/base.txt
