#!/usr/bin/env bash
# Check that a cmux app carries the Computer Use helper onboarding grants
# (cx-urd.6). Onboarding and the legacy driver only use
# "Contents/Library/cmux Computer Use.app" with bundle id com.cmuxterm.cua and
# the team's Developer ID signature (CuaHelperIdentity.swift,
# scripts/cmux-cua-helper-trust.sh); without one the app offers no grant.
#
# The screen share helper (design D9), "Contents/Library/cmux Screen Share.app"
# with bundle id com.cmuxterm.screenshare and executable cmux-screen-share
# (scripts/build-cmux-screen-share-helper.sh), is checked the same way when the
# app carries it, and must be there with --require-screen-share (the nightly
# step that assembles it).
#
# Usage:
#   scripts/ci/verify-computer-use-helper.sh layout <app> [--require-screen-share]   before signing
#   scripts/ci/verify-computer-use-helper.sh signed <app> [--require-screen-share]   after Codesign
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mode="${1:-}"
app="${2:-}"
require_screen_share=false
if [[ $# -eq 3 && "$3" == --require-screen-share ]]; then
  require_screen_share=true
elif [[ $# -ne 2 ]]; then
  mode=""
fi
if [[ "$mode" != layout && "$mode" != signed ]]; then
  echo "usage: $0 layout|signed <app> [--require-screen-share]" >&2
  exit 2
fi

fail() {
  echo "error: $app: $*" >&2
  exit 1
}
bundle_id() {
  python3 -I -c 'import plistlib, sys; print(plistlib.load(open(sys.argv[1], "rb")).get("CFBundleIdentifier", ""))' \
    "$1/Contents/Info.plist" 2>/dev/null || true
}

helper="$app/Contents/Library/cmux Computer Use.app"
[[ -d "$helper" && ! -L "$helper" ]] || fail "missing Contents/Library/cmux Computer Use.app (scripts/build-cmux-cua.sh --helper-app)"
id="$(bundle_id "$helper")"
[[ "$id" == com.cmuxterm.cua ]] || fail "cmux Computer Use.app has bundle id '${id}', expected com.cmuxterm.cua"
[[ -f "$helper/Contents/MacOS/cmux-cua" && -x "$helper/Contents/MacOS/cmux-cua" ]] \
  || fail "cmux Computer Use.app has no executable Contents/MacOS/cmux-cua"

if [[ "$mode" == signed ]]; then
  "$ROOT/scripts/cmux-cua-helper-trust.sh" check "$helper" \
    || fail "cmux Computer Use.app fails the com.cmuxterm.cua Developer ID requirement (scripts/cmux-cua-helper-trust.sh)"
fi
echo "ok: $helper ($mode)"

share="$app/Contents/Library/cmux Screen Share.app"
if [[ ! -e "$share" && ! -L "$share" ]]; then
  [[ "$require_screen_share" == false ]] \
    || fail "missing Contents/Library/cmux Screen Share.app (scripts/build-cmux-screen-share-helper.sh)"
  echo "note: $app carries no cmux Screen Share.app"
  exit 0
fi
[[ -d "$share" && ! -L "$share" ]] || fail "cmux Screen Share.app is not a directory"
share_id="$(bundle_id "$share")"
[[ "$share_id" == com.cmuxterm.screenshare ]] \
  || fail "cmux Screen Share.app has bundle id '${share_id}', expected com.cmuxterm.screenshare"
[[ -f "$share/Contents/MacOS/cmux-screen-share" && -x "$share/Contents/MacOS/cmux-screen-share" ]] \
  || fail "cmux Screen Share.app has no executable Contents/MacOS/cmux-screen-share"
if [[ "$mode" == signed ]]; then
  # The Developer ID requirement of the release helper, as cmux-cua-helper-trust.sh
  # states it for com.cmuxterm.cua: an ad hoc, Apple Development or Apple
  # Distribution signature fails.
  share_requirement="=identifier \"com.cmuxterm.screenshare\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = \"7WLXT3NR37\""
  /usr/bin/codesign --verify --deep --strict -R "$share_requirement" "$share" >/dev/null 2>&1 \
    || fail "cmux Screen Share.app fails the com.cmuxterm.screenshare Developer ID requirement"
  /usr/bin/codesign -d --verbose=2 "$share" 2>&1 | grep -q 'flags=.*runtime' \
    || fail "cmux Screen Share.app is not signed with the hardened runtime"
fi
echo "ok: $share ($mode)"
