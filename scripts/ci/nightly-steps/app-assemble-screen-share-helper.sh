#!/usr/bin/env bash
# nightly.yml build-nightly-app: "Assemble the Screen Share helper". In a step script to keep nightly.yml under its
# size budget (tests/test_workflow_file_size.py); the step's env: sets HELPER_ARCHS.
#
# "cmux Screen Share.app" (com.cmuxterm.screenshare) holds Screen Recording and
# Accessibility for screen share (design D9), as cmux Computer Use.app does for
# Computer Use: assembled here at Contents/Library for Codesign apps to sign and
# notarize-computer-use-helper.sh to notarize and staple with the Computer Use
# helper. Built with the rustc cmux-tui pins (the notices check needs a reviewed
# rustc); a missing toolchain or a failed build fails the step.
set -euo pipefail
app="build-universal/Build/Products/Release/cmux.app"
toolchain="$(sed -n 's/^channel = "\(.*\)"$/\1/p' cmux-tui/rust-toolchain.toml)"
# shellcheck source=scripts/lib/rust-targets.sh
source scripts/lib/rust-targets.sh
ensure_rust_toolchain "$toolchain" --profile minimal
# Only the slices a variant ships: nightly-next and fast builds are arm64.
RUSTUP_TOOLCHAIN="$toolchain" \
CMUX_SCREEN_SHARE_TARGET_DIR="${CMUX_SCREEN_SHARE_TARGET_DIR:-$PWD/build/cmux-screen-share/target}" \
  ./scripts/build-cmux-screen-share-helper.sh \
    --app "$app" --archs "${HELPER_ARCHS}" --bundle-id com.cmuxterm.screenshare
./scripts/ci/verify-computer-use-helper.sh layout "$app" --require-screen-share
