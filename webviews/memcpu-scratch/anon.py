#!/usr/bin/env python3
"""Anonymize an `acpmux session tail --json` log into a synthetic chat with the same shape, tiled N times.

Every free-text string becomes filler of the same length (its newlines kept), every id-like string a stable
synthetic id (per tile), structural values (kinds, methods, statuses, tool names) stay. seq is renumbered from 1.
  memcpu-anon.py IN OUT [--tiles N] [--limit RECORDS]
"""
import hashlib
import json
import re
import sys

STRUCT_KEYS = {"jsonrpc", "method", "sessionUpdate", "type", "kind", "status", "subtype", "role", "stop_reason",
               "stopReason", "dir", "state", "level", "category", "mode", "toolKind", "source", "event", "phase",
               "harness", "currentValue", "decision", "outcome", "optionId", "reason"}
NAME_KEYS = {"name", "tool_name", "toolName", "tool"}
ID_RE = re.compile(r"^(toolu_|call_|msg_|req_|p-|bg-|task_|srvtoolu_)?[0-9A-Za-z_-]*$")
UUIDISH = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore".split()
SESSION = "0190a000-0000-7000-8000-00000000c0de"
REAL = "ffffffff-ffff-7fff-bfff-ffffffffffff"


def h(text, tile, n):
    return hashlib.sha1(f"{tile}:{text}".encode()).hexdigest()[:n]


def map_id(text, tile):
    def uuid(m):
        d = h(m.group(0), tile, 32)
        return f"{d[:8]}-{d[8:12]}-{d[12:16]}-{d[16:20]}-{d[20:32]}"
    out = UUIDISH.sub(uuid, text)
    if out != text:
        return out
    m = re.match(r"^(toolu_|call_|msg_|req_|srvtoolu_|task_|bg-|p-)(.*)$", text)
    if m:
        return m.group(1) + h(text, tile, max(len(m.group(2)), 6))
    return h(text, tile, len(text))


def filler(text):
    out, i, w = [], 0, 0
    while i < len(text):
        c = text[i]
        if c in "\n\t":
            out.append(c)
            i += 1
            continue
        word = WORDS[w % len(WORDS)]
        w += 1
        take = min(len(word), len(text) - i)
        # stop before the next newline so line counts stay
        nl = [j for j in (text.find("\n", i), text.find("\t", i)) if j != -1]
        if nl:
            take = min(take, min(nl) - i)
        out.append(word[:take])
        i += take
        if i < len(text) and text[i] not in "\n\t":
            out.append(" ")
            i += 1
    return "".join(out)


def idlike(text):
    if any(ch.isspace() for ch in text) or len(text) > 200:
        return False
    if re.fullmatch(r"[0-9a-f-]{36}(/[0-9A-Za-z_-]+)?", text):
        return True
    return (len(text) >= 10 and " " not in text and ID_RE.match(text)
                                         and any(ch.isdigit() for ch in text))


def walk(value, key, tile):
    if isinstance(value, dict):
        return {k: walk(v, k, tile) for k, v in value.items()}
    if isinstance(value, list):
        return [walk(v, key, tile) for v in value]
    if isinstance(value, str):
        if key in STRUCT_KEYS:
            return value
        if key in NAME_KEYS and len(value) <= 40 and re.match(r"^[A-Za-z0-9_.:-]+$", value):
            return value
        if key in ("sessionId", "parentSessionId", "subagent") or idlike(value):
            if value.startswith(REAL) or value.startswith(SESSION):
                rest = value[36:]
                return SESSION + ("/" + map_id(rest[1:], tile) if rest.startswith("/") else rest)
            return map_id(value, tile)
        return filler(value)
    return value


def main():
    src, dst = sys.argv[1], sys.argv[2]
    tiles = int(sys.argv[sys.argv.index("--tiles") + 1]) if "--tiles" in sys.argv else 1
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    records = [json.loads(line) for line in open(src) if line.strip()]
    span = records[-1]["at"] - records[0]["at"] + 50
    seq = 0
    with open(dst, "w") as out:
        for tile in range(tiles):
            for r in records:
                if limit and seq >= limit:
                    break
                seq += 1
                msg = walk(r.get("msg", {}), "", tile)
                rec = {"sessionId": SESSION, "seq": seq, "at": r["at"] + tile * span, "dir": r.get("dir"),
                       "kind": r.get("kind"), "msg": msg}
                out.write(json.dumps(rec, separators=(",", ":")) + "\n")
    print(dst, seq, "records")


main()
