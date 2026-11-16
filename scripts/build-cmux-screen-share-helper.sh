#!/usr/bin/env bash
# Builds "cmux Screen Share.app", the helper that holds Screen Recording and
# Accessibility for cmux's screen share (design D9), modeled on the Computer
# Use helper (scripts/build-cmux-cua.sh --helper-app).
#
#   scripts/build-cmux-screen-share-helper.sh (--app <cmux.app> | --output-app <helper.app>)
#       [--archs "arm64 x86_64"] [--bundle-id ID] [--display-name NAME]
#
#   --app PATH         put the helper at PATH/Contents/Library/<display name>.app
#   --output-app PATH  put the helper at PATH
#   --archs            slices to build (default "arm64 x86_64"); one is copied,
#                      more are joined with lipo
#   --bundle-id ID     CFBundleIdentifier and code identifier
#                      (default com.cmuxterm.screenshare; DEV builds pass
#                      com.cmuxterm.screenshare.dev, as cmux Computer Use (dev)
#                      is com.cmuxterm.cua.dev)
#   --display-name N   CFBundleName and the name in Privacy & Security
#                      (default "cmux Screen Share")
#
# The main executable, Contents/MacOS/cmux-screen-share, is the standalone
# `cmux-rd` binary of cmux-tui/crates/cmux-rd-host (its own Cargo workspace),
# built with --no-default-features --features link: `cmux-rd serve` and the
# macOS host, no OpenH264 and no bench code. It gets its own CARGO_TARGET_DIR
# (CMUX_SCREEN_SHARE_TARGET_DIR, default build/cmux-screen-share/target).
#
# The bundle is signed ad hoc with an explicit designated requirement on its
# bundle id, as the Computer Use helper is; release packaging signs it with
# the Developer ID (scripts/sign-cmux-bundle.sh) and notarizes and staples it
# on its own (scripts/ci/notarize-computer-use-helper.sh), because cmux copies
# it out of the app before it runs it (macOS 26 checks Screen Recording of a
# nested helper as the outer app).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE_DIR="$REPO_ROOT/cmux-tui/crates/cmux-rd-host"
HELPER_EXECUTABLE="cmux-screen-share"
HELPER_OWNER_FILE=".cmux-screen-share-managed-helper"
HELPER_OWNER_VALUE="cmux-screen-share-helper-v1"
ENTITLEMENTS="$REPO_ROOT/cmux-screen-share-helper.entitlements"

# Xcode build phases and reload.sh do not inherit a login-shell PATH: fall
# back to rustup's bin directory, then the Homebrew prefixes (as build-cmux-cua.sh).
export PATH="${PATH:+${PATH}:}${CARGO_HOME:-${HOME}/.cargo}/bin:/opt/homebrew/bin:/usr/local/bin"

APP=""
OUTPUT_APP=""
ARCHS_RAW="arm64 x86_64"
HELPER_ID="com.cmuxterm.screenshare"
HELPER_DISPLAY="cmux Screen Share"

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0" >&2; }

while (($#)); do
  case "$1" in
    --app) [[ $# -ge 2 ]] || { usage; exit 2; }; APP="$2"; shift 2 ;;
    --output-app) [[ $# -ge 2 ]] || { usage; exit 2; }; OUTPUT_APP="$2"; shift 2 ;;
    --archs) [[ $# -ge 2 ]] || { usage; exit 2; }; ARCHS_RAW="$2"; shift 2 ;;
    --bundle-id) [[ $# -ge 2 ]] || { usage; exit 2; }; HELPER_ID="$2"; shift 2 ;;
    --display-name) [[ $# -ge 2 ]] || { usage; exit 2; }; HELPER_DISPLAY="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -n "$APP" && -n "$OUTPUT_APP" ]] || [[ -z "$APP" && -z "$OUTPUT_APP" ]]; then
  echo "error: pass exactly one of --app or --output-app" >&2
  exit 2
fi
[[ "$HELPER_ID" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ ]] || { echo "error: --bundle-id '$HELPER_ID' is not a reverse-DNS name" >&2; exit 2; }
[[ -n "$HELPER_DISPLAY" && "$HELPER_DISPLAY" != */* ]] || { echo "error: --display-name must be a non-empty file name" >&2; exit 2; }
if [[ -n "$APP" ]]; then
  [[ -d "$APP/Contents" ]] || { echo "error: no app bundle at $APP" >&2; exit 1; }
  OUTPUT_APP="$APP/Contents/Library/$HELPER_DISPLAY.app"
fi
[[ "$OUTPUT_APP" == *.app ]] || { echo "error: the helper path must end in .app: $OUTPUT_APP" >&2; exit 2; }
[[ -f "$CRATE_DIR/Cargo.toml" && -f "$CRATE_DIR/Cargo.lock" ]] || { echo "error: cmux-rd-host crate not found at $CRATE_DIR" >&2; exit 1; }
[[ -f "$ENTITLEMENTS" ]] || { echo "error: helper entitlements not found at $ENTITLEMENTS" >&2; exit 1; }
command -v cargo >/dev/null 2>&1 || { echo "error: cargo not found; cmux Screen Share needs the Rust toolchain cmux-tui pins (cmux-tui/rust-toolchain.toml)" >&2; exit 1; }

read -r -a ARCHS <<<"$ARCHS_RAW"
((${#ARCHS[@]} > 0)) || { echo "error: --archs is empty" >&2; exit 2; }

# The toolchain cmux-tui pins (cmux-rd-host sits under cmux-tui, so rustup
# would find it too; set it so a caller's RUSTUP_TOOLCHAIN still wins).
if [[ -z "${RUSTUP_TOOLCHAIN:-}" ]] && command -v rustup >/dev/null 2>&1; then
  toolchain="$(sed -n 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/cmux-tui/rust-toolchain.toml" 2>/dev/null | head -1 || true)"
  [[ -z "$toolchain" ]] || export RUSTUP_TOOLCHAIN="$toolchain"
fi
# shellcheck source=scripts/lib/rust-targets.sh
source "$REPO_ROOT/scripts/lib/rust-targets.sh"

# The app's macOS floor (embed-cua-helper-dev.sh checks the same floor).
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
TARGET_DIR="${CMUX_SCREEN_SHARE_TARGET_DIR:-$REPO_ROOT/build/cmux-screen-share/target}"
mkdir -p "$TARGET_DIR"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cmux-screen-share.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

BUILT=()
for arch in "${ARCHS[@]}"; do
  case "$arch" in
    arm64|aarch64) arch=arm64; target=aarch64-apple-darwin ;;
    x86_64|amd64) arch=x86_64; target=x86_64-apple-darwin ;;
    *) echo "error: unsupported architecture: $arch" >&2; exit 1 ;;
  esac
  if command -v rustup >/dev/null 2>&1; then
    ensure_rust_targets "$target"
  fi
  cargo_status=0
  for attempt in 1 2 3; do
    if (cd "$CRATE_DIR" && \
      CARGO_TARGET_DIR="$TARGET_DIR" \
      CARGO_NET_RETRY="${CARGO_NET_RETRY:-5}" \
      CARGO_HTTP_MULTIPLEXING="${CARGO_HTTP_MULTIPLEXING:-false}" \
      cargo build --locked --release --target "$target" \
        --no-default-features --features link --bin cmux-rd); then
      cargo_status=0
      break
    else
      cargo_status=$?
    fi
    if [[ "$attempt" -lt 3 ]]; then
      echo "cmux-rd Cargo build failed for $target (attempt $attempt/3); retrying transient dependency fetches" >&2
      sleep $((attempt * 5))
    fi
  done
  [[ "$cargo_status" -eq 0 ]] || exit "$cargo_status"
  slice="$WORK/cmux-rd-$arch"
  cp "$TARGET_DIR/$target/release/cmux-rd" "$slice"
  BUILT+=("$slice")
done

binary="$WORK/$HELPER_EXECUTABLE"
if ((${#BUILT[@]} == 1)); then
  cp "${BUILT[0]}" "$binary"
else
  /usr/bin/lipo -create "${BUILT[@]}" -output "$binary"
fi
chmod 0755 "$binary"
# The release profile keeps line tables (debug = 1) for local profiling; the
# shipped helper does not need them or its local symbols.
/usr/bin/strip -Sx "$binary"

# Replace only a bundle this script made (its owner marker), never an
# arbitrary directory that happens to sit at the output path.
if [[ -e "$OUTPUT_APP" || -L "$OUTPUT_APP" ]]; then
  if [[ -L "$OUTPUT_APP" || ! -d "$OUTPUT_APP" ]] \
    || [[ "$(cat "$OUTPUT_APP/Contents/Resources/$HELPER_OWNER_FILE" 2>/dev/null || true)" != "$HELPER_OWNER_VALUE" ]]; then
    echo "error: refusing to replace unmanaged helper bundle: $OUTPUT_APP" >&2
    echo "  move it aside or remove it, then rerun the build" >&2
    exit 1
  fi
  /bin/rm -rf -- "$OUTPUT_APP"
fi
host_contents=""
if [[ "$(basename "$(dirname "$OUTPUT_APP")")" == Library && "$(basename "$(dirname "$(dirname "$OUTPUT_APP")")")" == Contents ]]; then
  host_contents="$(dirname "$(dirname "$OUTPUT_APP")")"
fi
mkdir -p \
  "$OUTPUT_APP/Contents/MacOS" \
  "$OUTPUT_APP/Contents/Resources/en.lproj" \
  "$OUTPUT_APP/Contents/Resources/ja.lproj"
printf '%s\n' "$HELPER_OWNER_VALUE" > "$OUTPUT_APP/Contents/Resources/$HELPER_OWNER_FILE"
cp "$binary" "$OUTPUT_APP/Contents/MacOS/$HELPER_EXECUTABLE"
chmod 0755 "$OUTPUT_APP/Contents/MacOS/$HELPER_EXECUTABLE"
# cmux copies the helper out of the app before it runs it: the copy carries
# cmux's license (cmux-rd-host is GPL-3.0-or-later, first-party).
cp "$REPO_ROOT/LICENSE" "$OUTPUT_APP/Contents/Resources/LICENSE"
if [[ -n "$host_contents" && -f "$host_contents/Resources/AppIcon.icns" ]]; then
  cp "$host_contents/Resources/AppIcon.icns" "$OUTPUT_APP/Contents/Resources/AppIcon.icns"
elif [[ -n "$host_contents" && -f "$host_contents/Resources/AppIcon-Debug.icns" ]]; then
  cp "$host_contents/Resources/AppIcon-Debug.icns" "$OUTPUT_APP/Contents/Resources/AppIcon.icns"
fi

SCREEN_TEXT="${HELPER_DISPLAY} sends this screen to the devices you approve."
CONTROL_TEXT="${HELPER_DISPLAY} applies the clicks and keys of a viewer you allowed to control this Mac."
cat > "$OUTPUT_APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${HELPER_DISPLAY}</string>
  <key>CFBundleDisplayName</key><string>${HELPER_DISPLAY}</string>
  <key>CFBundleIdentifier</key><string>${HELPER_ID}</string>
  <key>CFBundleExecutable</key><string>${HELPER_EXECUTABLE}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>${MACOSX_DEPLOYMENT_TARGET}</string>
  <key>NSAccessibilityUsageDescription</key><string>${CONTROL_TEXT}</string>
  <key>NSScreenCaptureUsageDescription</key><string>${SCREEN_TEXT}</string>
</dict>
</plist>
PLIST
cat > "$OUTPUT_APP/Contents/Resources/en.lproj/InfoPlist.strings" <<STRINGS
"CFBundleDisplayName" = "${HELPER_DISPLAY}";
"NSAccessibilityUsageDescription" = "${CONTROL_TEXT}";
"NSScreenCaptureUsageDescription" = "${SCREEN_TEXT}";
STRINGS
cat > "$OUTPUT_APP/Contents/Resources/ja.lproj/InfoPlist.strings" <<STRINGS
"CFBundleDisplayName" = "${HELPER_DISPLAY}";
"NSAccessibilityUsageDescription" = "${HELPER_DISPLAY}は、このMacの操作を許可した閲覧者のクリックとキー入力を適用します。";
"NSScreenCaptureUsageDescription" = "${HELPER_DISPLAY}は、あなたが承認したデバイスにこの画面を送信します。";
STRINGS
/usr/bin/plutil -lint "$OUTPUT_APP/Contents/Info.plist" >/dev/null

# An ad hoc signature without an explicit designated requirement is a
# CDHash-only identity, which Privacy & Security cannot resolve back to the
# copied app. Hardened runtime and the helper's (empty) entitlements, as the
# Developer ID signature will have.
/usr/bin/codesign \
  --force \
  --sign - \
  --timestamp=none \
  --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --identifier "$HELPER_ID" \
  --requirements "=designated => identifier \"${HELPER_ID}\"" \
  "$OUTPUT_APP"
/usr/bin/codesign --verify --deep --strict "$OUTPUT_APP"
echo "$HELPER_DISPLAY.app assembled at: $OUTPUT_APP (id $HELPER_ID, $(/usr/bin/lipo -archs "$OUTPUT_APP/Contents/MacOS/$HELPER_EXECUTABLE"))"
