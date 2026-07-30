# Codex 周额度监控 macOS V3.0

这是从 Windows Electron V2.3 移植的 macOS 通用应用源码。界面与数据逻辑保持一致，并增加 macOS 标准应用菜单、Dock 激活、Finder 数据入口、辅助键盘焦点、减少动态效果支持及 Developer ID 签名/Apple 公证流程。

## 系统与架构

- macOS 12 Monterey 或更高版本
- Apple Silicon arm64 与 Intel x86_64 通用二进制
- Electron 43.2.0

## 开发运行

```bash
npm ci
npm test
npm start
```

## 正式构建

正式产物必须在 macOS 上构建。将 `Developer ID Application` 证书导入钥匙串，并按 electron-builder 支持的任一方式设置 Apple 公证凭据，然后执行：

```bash
chmod +x scripts/*.sh
./scripts/build-macos.sh
```

脚本会拒绝生成没有 Developer ID 签名或没有 Apple 公证配置的正式分发包。通过后，`.app`、`.zip` 与 `.dmg` 位于项目的 `outputs/` 目录。

## 数据路径

- Codex 会话：`~/.codex/sessions` 与 `~/.codex/archived_sessions`
- Codex 登录：`~/.codex/auth.json`
- 应用偏好：`~/Library/Application Support/Codex 周额度监控`

若 GUI 启动环境中存在 `CODEX_HOME`，会优先读取该路径。应用不启用 App Sandbox，因为它需要读取用户主目录中的现有 Codex 数据；渲染器本身仍启用 Electron 沙箱与上下文隔离。
