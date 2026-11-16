#!/usr/bin/env python3
"""Keep the records a v1 chat page is sent (hub/paging.rs transcript_may_match, roughly): drop raw harness lines
(`claude.*`), replies (`response`) and replays, renumbering seq from 1.  memcpu-pagefilter.py IN OUT"""
import json
import sys

seq = 0
with open(sys.argv[2], "w") as out:
    for line in open(sys.argv[1]):
        r = json.loads(line)
        k = r.get("kind") or ""
        if r.get("dir") == "in" and (k.startswith("claude.") or k == "response" or k.endswith(".replay")):
            continue
        if r.get("dir") == "out":
            continue
        seq += 1
        r["seq"] = seq
        out.write(json.dumps(r, separators=(",", ":")) + "\n")
print(sys.argv[2], seq)
