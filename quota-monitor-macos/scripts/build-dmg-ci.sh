#!/bin/bash
set -euo pipefail

ARCH="${1:-}"
if [[ "$ARCH" != "arm64" && "$ARCH" != "x64" ]]; then
  echo "用法：$0 arm64|x64" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
PACKAGE_DIR="$DIST_DIR/Codex 周额度监控-darwin-$ARCH"
APP_PATH="$PACKAGE_DIR/Codex 周额度监控.app"
STAGE_DIR="$DIST_DIR/dmg-stage-$ARCH"
MOUNT_DIR="$DIST_DIR/dmg-mount-$ARCH"
OUTPUT_DIR="$ROOT_DIR/output"
DMG_PATH="$OUTPUT_DIR/2026-07-30_Codex周额度监控_macOS安装版_${ARCH}_v3.0.dmg"
APP_ZIP_PATH="$OUTPUT_DIR/2026-07-30_Codex周额度监控_macOS应用程序_${ARCH}_v3.0.zip"
ICONSET="$DIST_DIR/CodexMonitor.iconset"
ICNS_PATH="$DIST_DIR/CodexMonitor.icns"
ZIP_VERIFY_DIR="$DIST_DIR/zip-verify-$ARCH"

rm -rf "$DIST_DIR" "$OUTPUT_DIR"
mkdir -p "$DIST_DIR" "$OUTPUT_DIR" "$ICONSET"

make_icon() {
  local size="$1"
  local scale="$2"
  local pixels=$((size * scale))
  local suffix=""
  if [[ "$scale" == "2" ]]; then
    suffix="@2x"
  fi
  /usr/bin/sips -z "$pixels" "$pixels" "$ROOT_DIR/build/icon.png" \
    --out "$ICONSET/icon_${size}x${size}${suffix}.png" >/dev/null
}

for size in 16 32 128 256 512; do
  make_icon "$size" 1
  make_icon "$size" 2
done
/usr/bin/iconutil -c icns "$ICONSET" -o "$ICNS_PATH"

cd "$ROOT_DIR"
npx electron-packager . "Codex 周额度监控" \
  --platform=darwin \
  --arch="$ARCH" \
  --electron-version=43.2.0 \
  --out="$DIST_DIR" \
  --overwrite \
  --asar \
  --prune=true \
  --icon="$ICNS_PATH" \
  --app-bundle-id=com.codexweeklymonitor.macos \
  --app-version=3.0.0 \
  --build-version=3.0.0 \
  --ignore='^/(\.github|build|dist|output|scripts|tests)(/|$)'

PLIST="$APP_PATH/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :LSMinimumSystemVersion" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :LSMinimumSystemVersion string 12.0" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :NSHighResolutionCapable" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :NSHighResolutionCapable bool true" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :NSHumanReadableCopyright" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :NSHumanReadableCopyright string Copyright © 2026 Codex 周额度监控" "$PLIST"

# 与 CodexLink 的已验证流程一致：macOS runner 执行完整 ad-hoc 签名。
/usr/bin/codesign --force --deep --sign - --timestamp=none "$APP_PATH"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"

APP_ARCHS="$(/usr/bin/lipo -archs "$APP_PATH/Contents/MacOS/Codex 周额度监控")"
EXPECTED_ARCH="$ARCH"
if [[ "$ARCH" == "x64" ]]; then
  EXPECTED_ARCH="x86_64"
fi
if [[ " $APP_ARCHS " != *" $EXPECTED_ARCH "* ]]; then
  echo "可执行文件架构错误：$APP_ARCHS" >&2
  exit 1
fi

/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$APP_ZIP_PATH"
mkdir -p "$ZIP_VERIFY_DIR"
/usr/bin/ditto -x -k "$APP_ZIP_PATH" "$ZIP_VERIFY_DIR"
test -d "$ZIP_VERIFY_DIR/Codex 周额度监控.app"
/usr/bin/codesign --verify --deep --strict --verbose=2 \
  "$ZIP_VERIFY_DIR/Codex 周额度监控.app"
ZIP_APP_ARCHS="$(/usr/bin/lipo -archs \
  "$ZIP_VERIFY_DIR/Codex 周额度监控.app/Contents/MacOS/Codex 周额度监控")"
if [[ " $ZIP_APP_ARCHS " != *" $EXPECTED_ARCH "* ]]; then
  echo "ZIP 中的可执行文件架构错误：$ZIP_APP_ARCHS" >&2
  exit 1
fi

mkdir -p "$STAGE_DIR"
/usr/bin/ditto "$APP_PATH" "$STAGE_DIR/Codex 周额度监控.app"
ln -s /Applications "$STAGE_DIR/Applications"

/usr/bin/hdiutil create \
  -volname "Codex 周额度监控" \
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

test -d "$MOUNT_DIR/Codex 周额度监控.app"
test -L "$MOUNT_DIR/Applications"
/usr/bin/codesign --verify --deep --strict --verbose=2 \
  "$MOUNT_DIR/Codex 周额度监控.app"
echo "$ATTACH_OUTPUT"
cleanup
trap - EXIT

/usr/bin/shasum -a 256 "$DMG_PATH" > "$DMG_PATH.sha256"
/usr/bin/shasum -a 256 "$APP_ZIP_PATH" > "$APP_ZIP_PATH.sha256"
/usr/bin/split -b 30m "$DMG_PATH" "$DMG_PATH.part-"
/usr/bin/split -b 30m "$APP_ZIP_PATH" "$APP_ZIP_PATH.part-"
ls -lh \
  "$DMG_PATH" "$DMG_PATH.sha256" "$DMG_PATH".part-* \
  "$APP_ZIP_PATH" "$APP_ZIP_PATH.sha256" "$APP_ZIP_PATH".part-*
