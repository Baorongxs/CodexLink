#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "错误：.app、通用二进制、签名与 DMG 必须在 macOS 上构建。" >&2
  exit 2
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "错误：未安装 Xcode Command Line Tools。" >&2
  exit 2
fi

if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  echo "错误：钥匙串中没有 Developer ID Application 证书。" >&2
  exit 2
fi

if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then
  :
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  :
elif [[ -n "${APPLE_KEYCHAIN:-}" && -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
  :
else
  echo "错误：未配置 Apple 公证凭据；拒绝生成会触发 Gatekeeper 的正式分发包。" >&2
  exit 2
fi

npm ci
npm test
npm run dist:mac
"$PROJECT_DIR/scripts/verify-macos.sh"
