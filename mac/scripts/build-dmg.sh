#!/bin/bash
set -euo pipefail

ARCH="${1:-}"
if [[ "$ARCH" != "arm64" && "$ARCH" != "x64" ]]; then
  echo "Usage: $0 arm64|x64" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
PACKAGE_DIR="$DIST_DIR/CodexLink-darwin-$ARCH"
APP_PATH="$PACKAGE_DIR/CodexLink.app"
STAGE_DIR="$DIST_DIR/dmg-stage-$ARCH"
OUTPUT_DIR="$ROOT_DIR/output"
DMG_PATH="$OUTPUT_DIR/2026-08-17_CodexLink_mac安装版_${ARCH}_v1.0.27.dmg"
MOUNT_DIR="$DIST_DIR/dmg-mount-$ARCH"

rm -rf "$DIST_DIR" "$OUTPUT_DIR"
mkdir -p "$DIST_DIR" "$OUTPUT_DIR"

cd "$ROOT_DIR"
npx electron-packager . CodexLink \
  --platform=darwin \
  --arch="$ARCH" \
  --electron-version=37.2.4 \
  --out="$DIST_DIR" \
  --overwrite \
  --asar \
  --prune=true \
  --icon="$ROOT_DIR/build/CodexLink.icns" \
  --app-bundle-id=top.baorongxs.codexlink \
  --app-version=1.0.27 \
  --build-version=1.0.27 \
  --ignore='^/(build|dist|output|scripts|tests)(/|$)'

PLIST="$APP_PATH/Contents/Info.plist"
/usr/bin/ditto "$ROOT_DIR/build/CodexLink.icns" "$APP_PATH/Contents/Resources/CodexLink.icns"
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconFile" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string CodexLink.icns" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :LSMinimumSystemVersion" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :LSMinimumSystemVersion string 14.0" "$PLIST"

# Windows cannot perform Apple bundle signing. The macOS runner applies a
# complete ad-hoc signature so the delivered app is internally valid.
/usr/bin/codesign --force --deep --sign - --timestamp=none "$APP_PATH"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"

APP_ARCHS="$(/usr/bin/lipo -archs "$APP_PATH/Contents/MacOS/CodexLink")"
EXPECTED_ARCH="$ARCH"
if [[ "$ARCH" == "x64" ]]; then
  EXPECTED_ARCH="x86_64"
fi
if [[ " $APP_ARCHS " != *" $EXPECTED_ARCH "* ]]; then
  echo "Unexpected executable architecture: $APP_ARCHS" >&2
  exit 1
fi

mkdir -p "$STAGE_DIR"
/usr/bin/ditto "$APP_PATH" "$STAGE_DIR/CodexLink.app"
ln -s /Applications "$STAGE_DIR/Applications"

/usr/bin/hdiutil create \
  -volname "CodexLink" \
  -srcfolder "$STAGE_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"
/usr/bin/hdiutil verify "$DMG_PATH"

mkdir -p "$MOUNT_DIR"
ATTACH_OUTPUT="$(/usr/bin/hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT_DIR" "$DMG_PATH")"
cleanup() {
  /usr/bin/hdiutil detach "$MOUNT_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

test -d "$MOUNT_DIR/CodexLink.app"
test -L "$MOUNT_DIR/Applications"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$MOUNT_DIR/CodexLink.app"
echo "$ATTACH_OUTPUT"
cleanup
trap - EXIT

/usr/bin/shasum -a 256 "$DMG_PATH" > "$DMG_PATH.sha256"
/usr/bin/split -b 32m "$DMG_PATH" "$DMG_PATH.part-"
ls -lh "$DMG_PATH" "$DMG_PATH.sha256" "$DMG_PATH".part-*
