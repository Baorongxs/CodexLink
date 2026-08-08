# CodexLink macOS Electron v1.0.26

Electron 版 macOS 源码，包含 Apple Silicon 与 Intel 双架构 DMG 构建脚本。

## 本地测试

```bash
npm ci
npm test
```

## macOS 构建

```bash
bash scripts/build-dmg.sh arm64
bash scripts/build-dmg.sh x64
```

本版本将“使用说明”改为软件内置的“使用教程”二级窗口，并移除了 `usage-guide.txt` 与原生消息框教程。
