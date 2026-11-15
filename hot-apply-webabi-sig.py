#!/usr/bin/env python3
"""Print the code signature facts of Mach-O files: ad-hoc or not, Team ID, identifier."""
import struct
import sys
import urllib.request

LC_CODE_SIGNATURE = 0x1D


def facts(data: bytes) -> dict:
    magic = struct.unpack_from("<I", data, 0)[0]
    if magic == 0xBEBAFECA or magic == 0xCAFEBABE:  # fat: take the first slice
        n = struct.unpack_from(">I", data, 4)[0]
        _, _, off, size, _ = struct.unpack_from(">IIIII", data, 8)
        return facts(data[off:off + size])
    assert magic == 0xFEEDFACF, hex(magic)
    ncmds = struct.unpack_from("<I", data, 16)[0]
    p = 32
    for _ in range(ncmds):
        cmd, size = struct.unpack_from("<II", data, p)
        if cmd == LC_CODE_SIGNATURE:
            off, sz = struct.unpack_from("<II", data, p + 8)
            return blob(data[off:off + sz])
        p += size
    return {"signed": False}


def blob(sb: bytes) -> dict:
    magic, length, count = struct.unpack_from(">III", sb, 0)
    out = {"signed": True, "cms": False}
    for i in range(count):
        typ, off = struct.unpack_from(">II", sb, 12 + 8 * i)
        m = struct.unpack_from(">I", sb, off)[0]
        if m == 0xFADE0C02:  # CodeDirectory
            version, flags = struct.unpack_from(">II", sb, off + 8)
            ident_off = struct.unpack_from(">I", sb, off + 20)[0]
            ident = sb[off + ident_off:].split(b"\0", 1)[0].decode()
            team = None
            if version >= 0x20200:
                team_off = struct.unpack_from(">I", sb, off + 48)[0]
                if team_off:
                    team = sb[off + team_off:].split(b"\0", 1)[0].decode()
            out.setdefault("identifier", ident)
            out.setdefault("team", team)
            out.setdefault("adhoc", bool(flags & 0x2))
        elif m == 0xFADE0B01:  # CMS signature wrapper
            out["cms"] = length > 0 and struct.unpack_from(">I", sb, off + 4)[0] > 8
    return out


for url in sys.argv[1:]:
    data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "sig-check"})).read() \
        if url.startswith("http") else open(url, "rb").read()
    print(url.rsplit("/", 2)[-2:], len(data), facts(data))
