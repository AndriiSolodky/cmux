set +e
fails=0
while read -r f; do
  if ! timeout 300 python3 "$f" > /tmp/out.txt 2>&1; then
    fails=$((fails+1)); echo "FAIL $f"; tail -25 /tmp/out.txt
  fi
done < tests/sr2h-ab-tests2.txt
echo "DONE fails=$fails"
