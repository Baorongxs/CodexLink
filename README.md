<div align="center">

<img src="./docs/images/codexlink-logo.png" width="112" alt="CodexLink Logo" />

# CodexLink

**让 Codex 的安装、配置、令牌切换和启动管理更简单。**

[![Latest Release](https://img.shields.io/github/v/release/Baorongxs/CodexLink?style=flat-square&label=release&color=0a84ff)](https://github.com/Baorongxs/CodexLink/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Baorongxs/CodexLink/total?style=flat-square&label=downloads&color=16a34a)](https://github.com/Baorongxs/CodexLink/releases)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078d4?style=flat-square)
![Architecture](https://img.shields.io/badge/architecture-x64-64748b?style=flat-square)
![Runtime](https://img.shields.io/badge/UI-WebView2-7c3aed?style=flat-square)

[下载最新版](https://github.com/Baorongxs/CodexLink/releases/latest) · [查看更新记录](https://github.com/Baorongxs/CodexLink/releases) · [反馈问题](https://github.com/Baorongxs/CodexLink/issues)

</div>

---

## 项目介绍

CodexLink 是一款面向 Windows 用户的 Codex 第三方辅助工具。它把 Codex 安装、CC Switch 安装、New API 账户登录、余额查看、API 导入、令牌切换以及 Codex 启动管理整合到同一个桌面界面中，减少重复配置和手动操作。

> [!IMPORTANT]
> CodexLink 是社区第三方工具，与 OpenAI 官方没有隶属、授权或合作关系。Codex、OpenAI、ChatGPT 等名称和商标归其各自权利人所有。

## 核心功能

| 功能 | 说明 |
| --- | --- |
| Codex 安装 | 支持 Microsoft Store 和离线包两种安装方式，并显示离线下载进度 |
| CC Switch 安装 | 内置安装流程，方便后续统一管理 API 配置 |
| 账户与余额 | 登录 New API 账户，查看当前余额和账户状态 |
| API 导入 | 自动创建或复用可用令牌，并写入 CC Switch |
| 令牌切换 | 在 CodexLink 中直接选择已导入的令牌或路线 |
| Codex 启动管理 | 启动或重启 Codex，并自动连接调试端口完成辅助功能注入 |
| Microsoft Store 兼容 | 通过 Windows 应用包身份启动商店版 Codex，避免直接访问 `WindowsApps` 被拒绝 |
| 自动更新提示 | 启动时检查 GitHub Releases，也可以点击左上角版本号手动检查 |
| 诊断日志 | 记录安装、导入、启动和更新检查过程，便于定位问题 |
| 高 DPI 适配 | 适配 Windows 125%–250% 显示缩放和不同窗口尺寸 |

## 快速开始

1. 前往 [GitHub Releases](https://github.com/Baorongxs/CodexLink/releases/latest) 下载最新版本。
2. 推荐普通用户下载 `CodexLink_Setup_v*.exe`；需要免安装时选择 `CodexLink_Portable_v*.exe`。
3. 启动 CodexLink，根据界面提示完成 Codex 和 CC Switch 安装。
4. 登录账户后点击“导入 API”，再选择需要使用的令牌或路线。
5. 点击“启动 Codex”进入工作环境。

| 下载文件 | 适用场景 |
| --- | --- |
| `CodexLink_Setup_v*.exe` | 推荐；安装到本机并创建快捷方式 |
| `CodexLink_Portable_v*.exe` | 免安装；下载后直接运行 |
| `CodexLink_Source_v*.zip` | 源码、资源、依赖与构建脚本 |

## 推荐使用流程

```mermaid
flowchart LR
    A[安装 Codex] --> B[安装 CC Switch]
    B --> C[登录账户]
    C --> D[导入 API]
    D --> E[选择令牌或路线]
    E --> F[启动 Codex]
```

首次使用建议按上图顺序完成配置。已经安装过 Codex 或 CC Switch 的用户可以直接跳过对应步骤。

## 自动更新

从 `v1.0.17` 开始，CodexLink 会在启动后读取本仓库的最新 GitHub Release：

- 发现更高版本时显示版本号、更新说明和下载按钮。
- 点击窗口左上角的版本号可以手动检查。
- 下载时优先选择 Release 中的安装版。
- 网络不可用或检查失败时只记录诊断日志，不影响其他功能。

`v1.0.16` 及更早版本不包含更新检查代码，需要先手动安装一次 `v1.0.17` 或更高版本。

## 系统要求

- Windows 10 或 Windows 11
- x64 处理器架构
- Microsoft Edge WebView2 Runtime
- 可访问 Microsoft Store、GitHub Releases 和所配置 API 服务的网络环境

CodexLink 同时兼容 Microsoft Store 版 Codex 和普通桌面安装版 Codex。

## 数据与安全

- 账户密码使用 Windows DPAPI 在当前用户环境下加密保存。
- 请只从本仓库的 Releases 页面下载程序，并核对 Release 中提供的 SHA-256。
- 不要在 Issue、日志或截图中公开 API Key、密码、`auth.json`、Cookie 等敏感信息。
- 不建议修改或接管 `C:\Program Files\WindowsApps` 的目录权限。
- 使用第三方 API 服务前，请自行确认其服务条款、稳定性和数据处理方式。
- 当前安装包未进行商业代码签名，Windows 或安全软件可能显示未知发布者提示。

## 常见问题

<details>
<summary><strong>启动 Codex 时提示“拒绝访问”</strong></summary>

旧版本可能尝试直接运行 `WindowsApps` 中受保护的程序。`v1.0.16` 起已改为使用 AUMID 和 Windows 应用激活接口启动 Microsoft Store 版 Codex，请升级到最新版后重试。

</details>

<details>
<summary><strong>程序没有显示新版本提示</strong></summary>

请点击左上角版本号手动检查，并确认当前网络可以访问 GitHub。`v1.0.16` 及更早版本需要先手动升级，之后才具备自动检查能力。

</details>

<details>
<summary><strong>高缩放比例下界面显示不完整</strong></summary>

请关闭后重新打开 CodexLink。程序会在启动时读取当前 Windows 显示缩放比例，并自动调整窗口尺寸。

</details>

<details>
<summary><strong>离线安装或 API 导入失败</strong></summary>

点击界面底部的“诊断日志”，检查网络连接、Windows 应用部署服务、依赖版本、CC Switch 数据库状态以及接口返回信息。反馈问题时请先删除日志中的账户和令牌信息。

</details>

## 从源码构建

1. 从 [Releases](https://github.com/Baorongxs/CodexLink/releases) 下载对应版本的 `CodexLink_Source_v*.zip`。
2. 解压后，在 Windows PowerShell 中运行 `Build-Setup.ps1`。
3. 构建脚本会生成便携版和安装版，WebView2 编译依赖已经包含在源码归档中。

## 反馈与支持

- 功能异常或改进建议：[提交 Issue](https://github.com/Baorongxs/CodexLink/issues/new)
- 版本下载与更新记录：[查看 Releases](https://github.com/Baorongxs/CodexLink/releases)

提交问题时请附上 CodexLink 版本、Windows 版本、复现步骤和脱敏后的诊断日志。

## 免责声明

本项目按现状提供，不保证在所有电脑、网络环境、Codex 版本或第三方 API 服务中都能正常运行。使用者应自行承担软件安装、账户配置、第三方服务、数据安全及相关操作可能产生的风险。

