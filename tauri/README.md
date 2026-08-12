# CodexLink macOS Tauri v1.0.27

Tauri 2 轻量版 macOS 源码，使用系统 WKWebView，支持 Apple Silicon 与 Intel 双架构。

## 本地检查

```bash
npm ci
npm test
```

## macOS 构建

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri -- build --target aarch64-apple-darwin --bundles app
npm run tauri -- build --target x86_64-apple-darwin --bundles app
```

本版本将“使用说明”改为软件内置的“使用教程”二级窗口，并移除了 `usage-guide.txt` 与原生消息框教程。
