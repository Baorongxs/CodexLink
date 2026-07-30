#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="$(cd "$PROJECT_DIR/../.." && pwd)/outputs"
APP_PATH="$OUTPUT_DIR/mac-universal/Codex 周额度监控.app"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "错误：macOS 产物验收必须在 macOS 上运行。" >&2
  exit 2
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "错误：未找到 $APP_PATH" >&2
  exit 2
fi

EXECUTABLE_NAME="$(plutil -extract CFBundleExecutable raw "$APP_PATH/Contents/Info.plist")"
EXECUTABLE_PATH="$APP_PATH/Contents/MacOS/$EXECUTABLE_NAME"
MINIMUM_SYSTEM="$(plutil -extract LSMinimumSystemVersion raw "$APP_PATH/Contents/Info.plist")"

[[ "$MINIMUM_SYSTEM" == "12.0" ]]
lipo -verify_arch x86_64 arm64 "$EXECUTABLE_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl --assess --type execute --verbose=2 "$APP_PATH"

REPORT_PATH="${TMPDIR%/}/Codex周额度监控_Electron_交互验收.json"
rm -f "$REPORT_PATH"
"$EXECUTABLE_PATH" --qa-self-test
node -e '
  const fs = require("fs");
  const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!report.passed) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
' "$REPORT_PATH"

DMG_PATH="$(find "$OUTPUT_DIR" -maxdepth 1 -name '2026-07-30_Codex周额度监控_macOS_v3.0_universal.dmg' -print -quit)"
if [[ -z "$DMG_PATH" ]]; then
  echo "错误：未找到 DMG。" >&2
  exit 2
fi

hdiutil verify "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG_PATH"

echo "macOS 通用应用、签名、公证、Gatekeeper、DMG 与交互验收全部通过。"
