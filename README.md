# CodexLink

CodexLink 是一款面向 Windows 用户的 Codex 辅助启动与安装工具，将 Codex 安装、CC Switch 安装、API 导入、令牌切换和 Codex 启动管理整合到一个简洁的桌面界面中。

> 本项目是第三方辅助工具，与 OpenAI 官方无隶属或合作关系。

## 主要功能

- 一键安装 Codex
- 支持 Microsoft Store 与离线安装
- 实时显示离线包下载进度
- 自动下载并安装必要依赖
- 一键安装 CC Switch
- 导入和切换 API 令牌
- 启动或重启 Codex
- 自动连接 Codex 调试端口
- 显示账户状态与余额信息
- 提供完整诊断日志
- 支持最小化到系统托盘
- 适配 Windows 高 DPI 与 125%–250% 显示缩放
- 启动时自动检查 GitHub Releases 新版本
- 支持点击左上角版本号手动检查更新

## 系统要求

- Windows 10 或 Windows 11
- x64 系统
- 建议安装 Microsoft Edge WebView2 Runtime

CodexLink 同时兼容 Microsoft Store 版 Codex 和普通桌面安装版 Codex。对于位于 `WindowsApps` 目录中的商店版本，程序会通过 Windows 应用包身份启动，避免直接执行受保护文件时出现“拒绝访问”。

## 下载

请前往 [Releases](https://github.com/Baorongxs/CodexLink/releases) 下载最新版本：

- `CodexLink_Portable_v1.0.17.exe`：便携版启动器
- `CodexLink_Setup_v1.0.17.exe`：安装版
- `CodexLink_Source_v1.0.17.zip`：源码、资源、依赖和构建脚本

## 使用方法

1. 从 Releases 下载最新版本。
2. 运行安装版，或直接打开便携版启动器。
3. 根据需要选择安装 Codex、安装 CC Switch、导入 API 或切换令牌。
4. 使用“启动 Codex”或“重启 Codex”进入工作环境。
5. 如果操作失败，点击界面底部的“诊断日志”查看详细信息。

## 离线安装

离线安装模式会自动完成以下操作：

1. 查询 Microsoft Store 对应的 Codex 安装包。
2. 识别当前电脑架构。
3. 下载 Codex 主程序及必要依赖。
4. 实时显示文件大小和总体下载进度。
5. 注册 Windows 应用包。
6. 安装完成后启动 Codex。

下载的临时安装包默认保存在用户的 `Downloads\CodexOffline` 目录中。

## 常见问题

### 启动 Codex 时提示“拒绝访问”

旧版启动方式可能直接执行 `WindowsApps` 目录中的程序，而该目录受到 Windows 系统保护。`v1.0.16` 起改为通过应用包 AUMID 和 Windows 应用激活接口启动 Microsoft Store 版 Codex，无须修改 `WindowsApps` 权限。

### 高缩放比例下界面显示不完整

新版已经加入 DPI 自适应，会根据 Windows 当前显示缩放比例动态调整窗口，并针对窄屏和矮屏使用响应式布局。如果在程序运行期间修改了缩放比例，请关闭并重新打开 CodexLink。

### 如何检查 CodexLink 更新

`v1.0.17` 起，程序启动后会自动读取本仓库的最新 Release。发现更高版本时会显示新版说明和下载按钮，也可以点击窗口左上角的版本号手动检查。网络检查失败不会影响其他功能。

### 离线安装失败

请打开“诊断日志”，重点检查网络连接、Windows 应用部署服务、下载文件完整性、依赖版本冲突，以及 `Add-AppxPackage` 返回的错误信息。

## 安全提示

- 请仅从本仓库的 Releases 页面下载程序。
- 不要提交或分享自己的 API Key、密码、`auth.json` 或其他账户凭据。
- 不建议修改或接管 `C:\Program Files\WindowsApps` 的目录权限。
- 未签名的自编译程序可能触发 Windows 或杀毒软件提示，请根据文件来源和校验值自行判断。
- 使用第三方 API 服务前，请确认其服务条款和数据处理方式。

## 免责声明

Codex、OpenAI、ChatGPT 等名称和相关商标归其各自权利人所有。本项目仅作为第三方辅助工具提供，不保证在所有电脑、网络环境或 Codex 版本中都能正常运行。使用者应自行承担安装、账户配置、第三方 API 服务和数据安全方面的风险。
