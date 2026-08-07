mod account;
mod cdp;
mod conversations;
mod util;
mod vault;

use account::{value_f64, AccountState};
use cdp::{normalize_port, start_codex, stop_codex, stop_injection, CdpClient};
use conversations::ConversationService;
use futures_util::StreamExt;
use reqwest::Client;
use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use url::Url;
use util::{
    atomic_write, compare_versions, ensure_dir, home_dir, keychain_delete, keychain_get,
    keychain_set, public_message,
};
use vault::{import_managed_tokens, VaultState};
use uuid::Uuid;

const APP_NAME: &str = "CodexLink";
const APP_VERSION: &str = "1.0.25";
const RELEASE_API: &str = "https://api.github.com/repos/Baorongxs/CodexLink/releases/latest";
const OFFICIAL_DOWNLOAD_URL: &str = "https://studio.baorongxs.top";
const CODEX_DMG_APPLE_SILICON: &str =
    "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg";
const CODEX_DMG_INTEL: &str =
    "https://persistent.oaistatic.com/codex-app-prod/Codex-latest-x64.dmg";
const SETTINGS_PASSWORD_KEY: &str = "settings-password-v2";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    base_url: String,
    username: String,
    debug_port: u16,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            base_url: "https://api.baorongxs.top".to_string(),
            username: String::new(),
            debug_port: 9230,
        }
    }
}

impl Settings {
    fn load(path: &Path) -> Self {
        fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn save(&self, path: &Path) -> Result<(), String> {
        atomic_write(
            path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(self).map_err(|error| error.to_string())?
            ),
        )
    }
}

struct AvailableUpdate {
    version: String,
}

pub struct AppState {
    http: Client,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    account: Mutex<AccountState>,
    vault: Mutex<VaultState>,
    conversations: ConversationService,
    cdp: Mutex<Option<CdpClient>>,
    history_busy: AtomicBool,
    available_update: Mutex<Option<AvailableUpdate>>,
}

#[tauri::command]
async fn handle_action(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<(), String> {
    let action = payload
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if state.history_busy.load(Ordering::SeqCst)
        && !matches!(
            action.as_str(),
            "window-minimize" | "window-maximize" | "window-close" | "clear-logs"
        )
    {
        post_toast(&app, "对话备份/恢复正在进行，请等待完成。", true);
        return Ok(());
    }
    let result = dispatch_action(&app, &state, &action, &payload).await;
    if let Err(error) = result {
        let message = public_message(error);
        post_toast(&app, &message, true);
        post_log(&app, &format!("操作失败：{message}"), "error");
        return Err(message);
    }
    Ok(())
}

async fn dispatch_action(
    app: &AppHandle,
    state: &AppState,
    action: &str,
    payload: &Value,
) -> Result<(), String> {
    match action {
        "ui-ready" => on_ui_ready(app, state).await,
        "drag-window" => {
            if let Some(window) = app.get_webview_window("main") {
                window.start_dragging().map_err(|error| error.to_string())?;
            }
            Ok(())
        }
        "window-minimize" => {
            if let Some(window) = app.get_webview_window("main") {
                window.minimize().map_err(|error| error.to_string())?;
            }
            Ok(())
        }
        "window-maximize" => {
            if let Some(window) = app.get_webview_window("main") {
                if window.is_maximized().map_err(|error| error.to_string())? {
                    window.unmaximize().map_err(|error| error.to_string())?;
                } else {
                    window.maximize().map_err(|error| error.to_string())?;
                }
            }
            Ok(())
        }
        "window-close" => {
            if let Some(window) = app.get_webview_window("main") {
                window.hide().map_err(|error| error.to_string())?;
            }
            Ok(())
        }
        "login" => login(app, state, payload).await,
        "register" => register(app, state, payload).await,
        "send-code" => {
            let settings = state.settings.lock().await.clone();
            let base_url = string_field(payload, "baseUrl", &settings.base_url);
            let email = string_field(payload, "email", "");
            state
                .account
                .lock()
                .await
                .send_email_code(&state.http, &base_url, &email)
                .await?;
            post_toast(app, "验证码已发送，请查收邮箱", false);
            post_log(app, "验证码已发送。", "ok");
            Ok(())
        }
        "logout" => {
            let mut account = state.account.lock().await;
            account.clear();
            post(app, account.balance_payload());
            post_log(app, "已退出登录。", "info");
            Ok(())
        }
        "refresh-balance" => {
            let mut account = state.account.lock().await;
            account.refresh_balance(&state.http).await?;
            post(app, account.balance_payload());
            post_log(app, &format!("余额已刷新：{}", account.balance_text), "ok");
            Ok(())
        }
        "open-topup" => {
            let mut account = state.account.lock().await;
            match account.get_topup_info(&state.http).await {
                Ok(info) => post(app, json!({ "type": "topup-info", "info": info })),
                Err(error) => {
                    post(
                        app,
                        json!({ "type": "topup-error", "stage": "load", "message": public_message(&error) }),
                    );
                    return Err(error);
                }
            }
            Ok(())
        }
        "calculate-topup" => {
            let amount = value_f64(payload.get("amount"));
            let payment_method = string_field(payload, "paymentMethod", "");
            let mut account = state.account.lock().await;
            match account.calculate_topup(&state.http, amount).await {
                Ok(payment_amount) => post(
                    app,
                    json!({
                        "type": "topup-amount",
                        "amount": amount,
                        "paymentMethod": payment_method,
                        "paymentAmount": payment_amount
                    }),
                ),
                Err(_) => post(
                    app,
                    json!({
                        "type": "topup-error",
                        "stage": "calculate",
                        "amount": amount,
                        "paymentMethod": payment_method
                    }),
                ),
            }
            Ok(())
        }
        "create-topup-payment" => {
            let amount = value_f64(payload.get("amount"));
            let payment_method = string_field(payload, "paymentMethod", "");
            let result = state
                .account
                .lock()
                .await
                .create_topup(&state.http, amount, &payment_method)
                .await;
            match result {
                Ok((url, fields)) => {
                    open_payment_window(app, &url, fields)?;
                    post(app, json!({ "type": "topup-payment-opened" }));
                    post_toast(app, "付款页面已打开，请扫码完成支付", false);
                    post_log(app, "已创建充值订单。", "ok");
                    Ok(())
                }
                Err(error) => {
                    post(
                        app,
                        json!({
                            "type": "topup-error",
                            "stage": "payment",
                            "message": public_message(&error)
                        }),
                    );
                    Err(error)
                }
            }
        }
        "open-site" => {
            let fallback = state.settings.lock().await.base_url.clone();
            let href = string_field(payload, "href", &fallback);
            open_external(&string_field(payload, "url", &href))
        }
        "check-update" => check_for_updates(app, state, true).await,
        "download-update" => {
            if state.available_update.lock().await.is_some() {
                open_external(official_download_url()?)?;
                post_toast(app, "已打开 CodexLink 官网下载页面", false);
            }
            Ok(())
        }
        "open-codex-root" => {
            let path = home_dir()?.join(".codex");
            ensure_dir(&path)?;
            open::that(path).map_err(|error| error.to_string())
        }
        "open-codex-config" => {
            let root = home_dir()?.join(".codex");
            ensure_dir(&root)?;
            let path = root.join("config.toml");
            if !path.exists() {
                atomic_write(&path, "")?;
            }
            open::that(path).map_err(|error| error.to_string())
        }
        "open-backup-folder" => {
            ensure_dir(&state.conversations.backup_root)?;
            open::that(&state.conversations.backup_root).map_err(|error| error.to_string())
        }
        "backup-conversations" => backup_conversations(app, state).await,
        "restore-conversations" => restore_conversations(app, state).await,
        "repair-conversation-sidebar" => repair_sidebar(app, state).await,
        "import-api" => import_api(app, state, false).await,
        "reset-api-profiles" => import_api(app, state, true).await,
        "select-route" => select_route(app, state, payload).await,
        "set-official-mode" => {
            set_official_mode(
                app,
                state,
                payload.get("enabled").and_then(Value::as_bool).unwrap_or(false),
            )
            .await
        }
        "import-ccswitch-profiles" => {
            let (imported, skipped) = state.vault.lock().await.import_from_cc_switch()?;
            refresh_routes(app, state).await;
            let message = format!("第三方 API 导入完成：导入 {imported} 条，跳过 {skipped} 条。");
            post_toast(app, &message, false);
            post_log(app, &message, "ok");
            Ok(())
        }
        "install-apple-silicon" => {
            download_codex_dmg(app, CODEX_DMG_APPLE_SILICON, "Apple 芯片版", "Codex.dmg")
                .await
        }
        "install-intel" => {
            download_codex_dmg(
                app,
                CODEX_DMG_INTEL,
                "Intel 芯片版",
                "Codex-latest-x64.dmg",
            )
            .await
        }
        "start-codex" => start_codex_action(app, state, payload, false).await,
        "restart-codex" => start_codex_action(app, state, payload, true).await,
        "stop-inject" => {
            stop_injection(app).await;
            post_status(app, "页面增强已停止");
            post_log(app, "已停止 Codex 页面增强功能。", "info");
            Ok(())
        }
        "clear-logs" | "" => Ok(()),
        _ => {
            post_log(app, &format!("暂不支持的操作：{action}"), "error");
            Ok(())
        }
    }
}

async fn on_ui_ready(app: &AppHandle, state: &AppState) -> Result<(), String> {
    state.vault.lock().await.initialize()?;
    post(
        app,
        json!({
            "type": "assets",
            "appLogo": "app-logo.png",
            "supportQr": "support-qr.png"
        }),
    );
    let settings = state.settings.lock().await.clone();
    let password = keychain_get(SETTINGS_PASSWORD_KEY)
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default();
    post(
        app,
        json!({
            "type": "settings",
            "baseUrl": settings.base_url,
            "username": settings.username,
            "password": password,
            "debugPort": settings.debug_port,
            "appVersion": APP_VERSION,
            "appName": format!("{APP_NAME} macOS")
        }),
    );
    {
        let account = state.account.lock().await;
        post(app, account.balance_payload());
    }
    post_status(app, "macOS Tauri 启动器就绪");
    refresh_routes(app, state).await;
    post_log(app, "CodexLink macOS Tauri 启动器就绪。", "ok");
    if state.account.lock().await.logged_in {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            let mut account = state.account.lock().await;
            if account.refresh_balance(&state.http).await.is_ok() {
                post(&app, account.balance_payload());
            }
        });
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let _ = check_for_updates(&app, &state, false).await;
    });
    Ok(())
}

async fn login(app: &AppHandle, state: &AppState, payload: &Value) -> Result<(), String> {
    let mut settings = state.settings.lock().await;
    settings.base_url = string_field(payload, "baseUrl", &settings.base_url);
    settings.username = string_field(payload, "username", "");
    settings.debug_port = normalize_port(
        payload
            .get("debugPort")
            .and_then(Value::as_i64)
            .unwrap_or(settings.debug_port as i64),
    );
    let password = string_field(payload, "password", "");
    settings.save(&state.settings_path)?;
    if password.is_empty() {
        keychain_delete(SETTINGS_PASSWORD_KEY);
    } else {
        keychain_set(SETTINGS_PASSWORD_KEY, password.as_bytes())?;
    }
    post_log(app, "正在登录。", "info");
    let base_url = settings.base_url.clone();
    let username = settings.username.clone();
    drop(settings);
    let mut account = state.account.lock().await;
    account
        .login(&state.http, &base_url, &username, &password)
        .await?;
    post(app, account.balance_payload());
    post_toast(app, "登录成功", false);
    post_log(app, "登录成功。", "ok");
    drop(account);
    refresh_balance_in_background(app.clone(), "登录成功，但余额刷新失败");
    Ok(())
}

async fn register(app: &AppHandle, state: &AppState, payload: &Value) -> Result<(), String> {
    let mut settings = state.settings.lock().await;
    settings.base_url = string_field(payload, "baseUrl", &settings.base_url);
    settings.username = string_field(payload, "username", "");
    settings.save(&state.settings_path)?;
    let password = string_field(payload, "password", "");
    keychain_set(SETTINGS_PASSWORD_KEY, password.as_bytes())?;
    let base_url = settings.base_url.clone();
    let username = settings.username.clone();
    drop(settings);
    state
        .account
        .lock()
        .await
        .register(
            &state.http,
            &base_url,
            &username,
            &password,
            &string_field(payload, "email", ""),
            &string_field(payload, "verificationCode", ""),
            &string_field(payload, "affCode", ""),
        )
        .await?;
    post(
        app,
        json!({ "type": "register-ok", "username": username, "password": password }),
    );
    post(app, state.account.lock().await.balance_payload());
    post_toast(app, "注册成功，已自动登录", false);
    post_log(app, "注册成功并已登录。", "ok");
    refresh_balance_in_background(app.clone(), "注册登录成功，但余额刷新失败");
    Ok(())
}

fn refresh_balance_in_background(app: AppHandle, failure_prefix: &'static str) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let mut account = state.account.lock().await;
        match account.refresh_balance(&state.http).await {
            Ok(()) => {
                post(&app, account.balance_payload());
                post_log(&app, &format!("余额已刷新：{}", account.balance_text), "ok");
            }
            Err(error) => post_log(
                &app,
                &format!("{failure_prefix}：{}", public_message(error)),
                "error",
            ),
        }
    });
}

async fn import_api(app: &AppHandle, state: &AppState, replace_all: bool) -> Result<(), String> {
    post(app, json!({ "type": "step", "id": "import-api", "state": "running" }));
    let title = if replace_all { "重建 API" } else { "导入 API" };
    post_progress(app, title, 10, "读取账号令牌…", true, false, false);
    post_status(app, if replace_all { "正在重建 API…" } else { "正在导入 API…" });
    let result = {
        let mut account = state.account.lock().await;
        let mut vault = state.vault.lock().await;
        import_managed_tokens(&mut account, &mut vault, &state.http, replace_all).await
    };
    match result {
        Ok(operations) => {
            for operation in operations {
                post_log(app, &operation, "info");
            }
            refresh_routes(app, state).await;
            post_progress(
                app,
                if replace_all { "API 重建完成" } else { "导入 API 完成" },
                100,
                "",
                false,
                true,
                false,
            );
            post(app, json!({ "type": "step", "id": "import-api", "state": "success" }));
            post_status(app, if replace_all { "重建完成" } else { "导入完成" });
            post_toast(
                app,
                if replace_all {
                    "已重新导入 9 条 API"
                } else {
                    "API 已通过 macOS 钥匙串加密保存"
                },
                false,
            );
            Ok(())
        }
        Err(error) => {
            post_progress(
                app,
                if replace_all { "API 重建失败" } else { "导入 API 失败" },
                100,
                "请确认登录后重试",
                false,
                true,
                true,
            );
            post(app, json!({ "type": "step", "id": "import-api", "state": "error" }));
            Err(error)
        }
    }
}

async fn refresh_routes(app: &AppHandle, state: &AppState) {
    let view = state.vault.lock().await.view();
    let profiles = view
        .get("profiles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let current_id = view.get("currentId").and_then(Value::as_str).unwrap_or("");
    let current = profiles
        .iter()
        .find(|profile| profile.get("id").and_then(Value::as_str) == Some(current_id))
        .and_then(|profile| profile.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    post(
        app,
        json!({
            "type": "routes",
            "routes": profiles.iter().filter_map(|profile| profile.get("name")).cloned().collect::<Vec<_>>(),
            "current": current,
            "profiles": profiles,
            "currentId": current_id,
            "officialMode": view.get("officialMode").cloned().unwrap_or(Value::Bool(false)),
            "officialAvailable": view.get("officialAvailable").cloned().unwrap_or(Value::Bool(false)),
            "ccSwitchImportAvailable": view.get("ccSwitchImportAvailable").cloned().unwrap_or(Value::Bool(false))
        }),
    );
}

async fn select_route(
    app: &AppHandle,
    state: &AppState,
    payload: &Value,
) -> Result<(), String> {
    let profile_id = string_field(payload, "profileId", "");
    if profile_id.is_empty() {
        return Err("未指定令牌。".to_string());
    }
    post_status(app, "正在切换令牌…");
    stop_codex(app).await;
    state.vault.lock().await.select_profile(&profile_id)?;
    refresh_routes(app, state).await;
    post_toast(app, "令牌已切换，正在重新打开 Codex", false);
    start_codex_action(app, state, payload, true).await
}

async fn set_official_mode(
    app: &AppHandle,
    state: &AppState,
    enabled: bool,
) -> Result<(), String> {
    post_status(
        app,
        if enabled {
            "正在切换官方渠道…"
        } else {
            "正在恢复 API…"
        },
    );
    stop_codex(app).await;
    state.vault.lock().await.set_official_mode(enabled)?;
    refresh_routes(app, state).await;
    post_toast(
        app,
        if enabled {
            "已打开官方账号登录"
        } else {
            "已恢复最近使用的 API"
        },
        false,
    );
    start_codex_action(app, state, &json!({}), true).await
}

async fn start_codex_action(
    app: &AppHandle,
    state: &AppState,
    payload: &Value,
    restart: bool,
) -> Result<(), String> {
    state.vault.lock().await.ensure_current_configuration()?;
    let mut settings = state.settings.lock().await;
    settings.debug_port = normalize_port(
        payload
            .get("debugPort")
            .and_then(Value::as_i64)
            .unwrap_or(settings.debug_port as i64),
    );
    settings.save(&state.settings_path)?;
    let debug_port = settings.debug_port;
    drop(settings);
    start_codex(app, debug_port, restart).await?;
    post_status(app, "Codex 已启动");
    Ok(())
}

async fn backup_conversations(app: &AppHandle, state: &AppState) -> Result<(), String> {
    state.history_busy.store(true, Ordering::SeqCst);
    post(app, json!({ "type": "history-operation", "busy": true }));
    let result = async {
        stop_codex(app).await;
        let value = state.conversations.create_backup(
            "codexlink-conversations",
            |percent, meta| {
                post_progress(app, "备份本地对话", percent, meta, false, false, false);
            },
        )?;
        let path = value.get("path").and_then(Value::as_str).unwrap_or("");
        let name = Path::new(path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        post_progress(app, "对话备份完成", 100, name, false, true, false);
        post_toast(
            app,
            &format!(
                "已备份 {} 个对话文件",
                value.get("fileCount").and_then(Value::as_u64).unwrap_or(0)
            ),
            false,
        );
        post_log(app, "本地对话已完成隐私范围备份（不包含账号和 API 令牌）。", "ok");
        Ok(())
    }
    .await;
    state.history_busy.store(false, Ordering::SeqCst);
    post(app, json!({ "type": "history-operation", "busy": false }));
    result
}

async fn restore_conversations(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let answer = MessageDialog::new()
        .set_level(MessageLevel::Warning)
        .set_title("恢复本地对话")
        .set_description("将从最新的 CodexLink 备份合并恢复缺失对话。继续前会自动创建安全备份。")
        .set_buttons(MessageButtons::OkCancel)
        .show();
    if answer != MessageDialogResult::Ok {
        return Ok(());
    }
    state.history_busy.store(true, Ordering::SeqCst);
    post(app, json!({ "type": "history-operation", "busy": true }));
    let result = async {
        stop_codex(app).await;
        let value = state.conversations.restore_latest(|percent, meta| {
            post_progress(app, "恢复本地对话", percent, meta, false, false, false);
        })?;
        post_progress(
            app,
            "对话恢复完成",
            100,
            &format!(
                "恢复 {} 项",
                value.get("restored").and_then(Value::as_u64).unwrap_or(0)
            ),
            false,
            true,
            false,
        );
        post_toast(app, "本地对话恢复完成", false);
        post_log(app, "本地对话已恢复，并保留了恢复前安全备份。", "ok");
        Ok(())
    }
    .await;
    state.history_busy.store(false, Ordering::SeqCst);
    post(app, json!({ "type": "history-operation", "busy": false }));
    result
}

async fn repair_sidebar(app: &AppHandle, state: &AppState) -> Result<(), String> {
    state.history_busy.store(true, Ordering::SeqCst);
    post(app, json!({ "type": "history-operation", "busy": true }));
    let result = async {
        stop_codex(app).await;
        let value = state.conversations.repair_sidebar()?;
        post_toast(
            app,
            &format!(
                "侧边栏修复完成，更新 {} 条记录",
                value.get("changed").and_then(Value::as_u64).unwrap_or(0)
            ),
            false,
        );
        post_log(app, "Codex 对话侧边栏已修复。", "ok");
        Ok(())
    }
    .await;
    state.history_busy.store(false, Ordering::SeqCst);
    post(app, json!({ "type": "history-operation", "busy": false }));
    result
}

async fn download_codex_dmg(
    app: &AppHandle,
    download_url: &str,
    architecture_name: &str,
    file_name: &str,
) -> Result<(), String> {
    post(app, json!({ "type": "step", "id": "install-codex", "state": "running" }));
    post_status(app, &format!("正在下载 Codex {architecture_name}…"));
    post_progress(
        app,
        &format!("下载 Codex {architecture_name}"),
        5,
        "正在连接官方下载服务器…",
        true,
        false,
        false,
    );

    let result =
        download_codex_dmg_inner(app, download_url, architecture_name, file_name).await;
    match result {
        Ok(downloaded_path) => {
            let reveal = tokio::process::Command::new("/usr/bin/open")
                .arg("-R")
                .arg(&downloaded_path)
                .output()
                .await;
            let revealed = reveal
                .as_ref()
                .is_ok_and(|output| output.status.success());
            post_progress(
                app,
                "Codex 下载完成",
                100,
                &format!("已保存到 {}", downloaded_path.display()),
                false,
                true,
                false,
            );
            post(
                app,
                json!({ "type": "step", "id": "install-codex", "state": "success" }),
            );
            post_status(app, "Codex 安装包已下载");
            post_toast(
                app,
                if revealed {
                    "下载完成，请在 Finder 中双击 DMG 安装"
                } else {
                    "下载完成，请到“下载”文件夹双击 DMG 安装"
                },
                false,
            );
            post_log(
                app,
                &format!(
                    "Codex {architecture_name}安装包已下载到 {}",
                    downloaded_path.display()
                ),
                "ok",
            );
            if !revealed {
                let detail = match &reveal {
                    Err(error) => error.to_string(),
                    Ok(output) => {
                        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                        if stderr.is_empty() {
                            format!("Finder 返回状态 {}", output.status)
                        } else {
                            stderr
                        }
                    }
                };
                post_log(
                    app,
                    &format!("安装包已下载，但无法在 Finder 中显示：{detail}"),
                    "info",
                );
            }
            Ok(())
        }
        Err(error) => {
            post_progress(
                app,
                "Codex 下载失败",
                100,
                &public_message(&error),
                false,
                true,
                true,
            );
            post(
                app,
                json!({ "type": "step", "id": "install-codex", "state": "error" }),
            );
            post_status(app, "Codex 下载失败");
            Err(error)
        }
    }
}

async fn download_codex_dmg_inner(
    app: &AppHandle,
    download_url: &str,
    architecture_name: &str,
    file_name: &str,
) -> Result<PathBuf, String> {
    let download_dir = dirs::download_dir().unwrap_or(home_dir()?.join("Downloads"));
    fs::create_dir_all(&download_dir)
        .map_err(|error| format!("无法创建下载文件夹：{error}"))?;
    let dmg_path = available_download_path(&download_dir, file_name);
    let partial_path = download_dir.join(format!(
        ".CodexLink-{}.part",
        Uuid::new_v4().simple()
    ));
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(20 * 60))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(download_url)
        .header("User-Agent", format!("CodexLink/{APP_VERSION}"))
        .send()
        .await
        .map_err(|error| format!("下载 Codex 失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "下载 Codex 失败：HTTP {}",
            response.status().as_u16()
        ));
    }

    let total = response.content_length();
    if total.is_some_and(|value| value > 1_500_000_000) {
        return Err("Codex 安装包大小异常，已停止下载。".to_string());
    }
    let mut file = tokio::fs::File::create(&partial_path)
        .await
        .map_err(|error| format!("无法创建下载文件：{error}"))?;
    let mut stream = response.bytes_stream();
    let mut downloaded = 0_u64;
    let mut last_percent = 5_u32;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(value) => value,
            Err(error) => {
                drop(file);
                let _ = tokio::fs::remove_file(&partial_path).await;
                return Err(format!("下载 Codex 失败：{error}"));
            }
        };
        if let Err(error) = file.write_all(&chunk).await {
            drop(file);
            let _ = tokio::fs::remove_file(&partial_path).await;
            return Err(format!("写入 Codex 安装包失败：{error}"));
        }
        downloaded += chunk.len() as u64;
        let percent = total
            .filter(|value| *value > 0)
            .map(|value| 5 + ((downloaded.saturating_mul(90) / value).min(90) as u32))
            .unwrap_or(50);
        if percent >= last_percent.saturating_add(2) {
            last_percent = percent;
            let detail = total
                .map(|value| {
                    format!(
                        "已下载 {:.1} / {:.1} MB",
                        downloaded as f64 / 1_048_576.0,
                        value as f64 / 1_048_576.0
                    )
                })
                .unwrap_or_else(|| {
                    format!("已下载 {:.1} MB", downloaded as f64 / 1_048_576.0)
                });
            post_progress(
                app,
                &format!("下载 Codex {architecture_name}"),
                percent,
                &detail,
                total.is_none(),
                false,
                false,
            );
        }
    }
    if let Err(error) = file.flush().await {
        drop(file);
        let _ = tokio::fs::remove_file(&partial_path).await;
        return Err(format!("保存 Codex 安装包失败：{error}"));
    }
    drop(file);
    if downloaded < 1_048_576 {
        let _ = tokio::fs::remove_file(&partial_path).await;
        return Err("下载到的 Codex 安装包不完整。".to_string());
    }
    tokio::fs::rename(&partial_path, &dmg_path)
        .await
        .map_err(|error| {
            let _ = fs::remove_file(&partial_path);
            format!("无法完成 Codex 安装包下载：{error}")
        })?;
    Ok(dmg_path)
}

fn available_download_path(download_dir: &Path, file_name: &str) -> PathBuf {
    let preferred = download_dir.join(file_name);
    if !preferred.exists() {
        return preferred;
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Codex");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("dmg");
    for index in 1..10_000 {
        let candidate = download_dir.join(format!("{stem} ({index}).{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    download_dir.join(format!("{stem}-{}.{}", Uuid::new_v4().simple(), extension))
}

async fn check_for_updates(
    app: &AppHandle,
    state: &AppState,
    manual: bool,
) -> Result<(), String> {
    let result = async {
        let response = state
            .http
            .get(RELEASE_API)
            .header("User-Agent", format!("CodexLink/{APP_VERSION}"))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }
        let release: Value = response.json().await.map_err(|error| error.to_string())?;
        let latest = release
            .get("tag_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim_start_matches(['v', 'V'])
            .to_string();
        if latest.is_empty() || compare_versions(&latest, APP_VERSION) <= 0 {
            if manual {
                post_toast(app, "当前已是最新版本", false);
            }
            return Ok(());
        }
        *state.available_update.lock().await = Some(AvailableUpdate { version: latest.clone() });
        post(
            app,
            json!({
                "type": "update-available",
                "latestVersion": latest,
                "currentVersion": APP_VERSION,
                "notes": release.get("body").and_then(Value::as_str).unwrap_or("新版已经发布，建议下载更新。")
            }),
        );
        Ok(())
    }
    .await;
    if let Err(error) = result {
        if manual {
            post_toast(app, &format!("检查更新失败：{}", public_message(error)), true);
        }
    }
    Ok(())
}

fn open_payment_window(app: &AppHandle, checkout_url: &str, fields: Value) -> Result<(), String> {
    let url = Url::parse(checkout_url).map_err(|_| "付款页面地址无效。".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
    {
        return Err("付款页面地址无效。".to_string());
    }
    if let Some(window) = app.get_webview_window("payment") {
        let _ = window.close();
    }
    let payment = json!({ "url": checkout_url, "fields": fields });
    let script = format!(
        "window.__TAURI_PAYMENT__ = {};",
        serde_json::to_string(&payment).map_err(|error| error.to_string())?
    );
    WebviewWindowBuilder::new(app, "payment", WebviewUrl::App("payment.html".into()))
        .title("CodexLink 安全支付")
        .inner_size(820.0, 760.0)
        .center()
        .initialization_script(&script)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn open_external(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|_| "只能打开 HTTP 或 HTTPS 地址。".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("只能打开 HTTP 或 HTTPS 地址。".to_string());
    }
    open::that(url.as_str()).map_err(|error| error.to_string())
}

fn official_download_url() -> Result<&'static str, String> {
    let url = Url::parse(OFFICIAL_DOWNLOAD_URL).map_err(|_| "官网下载地址无效。".to_string())?;
    if url.scheme() != "https" || url.host_str() != Some("studio.baorongxs.top") {
        return Err("官网下载地址无效。".to_string());
    }
    Ok(OFFICIAL_DOWNLOAD_URL)
}

fn string_field(payload: &Value, key: &str, fallback: &str) -> String {
    payload
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

pub fn post(app: &AppHandle, payload: Value) {
    let _ = app.emit("codexlink:host-message", payload);
}

pub fn post_log(app: &AppHandle, message: &str, level: &str) {
    post(
        app,
        json!({ "type": "log", "message": public_message(message), "level": level }),
    );
}

pub fn post_status(app: &AppHandle, text: &str) {
    post(app, json!({ "type": "status", "text": text }));
}

fn post_toast(app: &AppHandle, message: &str, error: bool) {
    post(
        app,
        json!({ "type": "toast", "message": public_message(message), "error": error }),
    );
}

fn post_progress(
    app: &AppHandle,
    label: &str,
    percent: u32,
    meta: &str,
    indeterminate: bool,
    done: bool,
    error: bool,
) {
    post(
        app,
        json!({
            "type": "progress",
            "label": label,
            "percent": percent,
            "meta": meta,
            "indeterminate": indeterminate,
            "done": done,
            "error": error
        }),
    );
}

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let open_item = MenuItem::with_id(app, "open", "打开 CodexLink", true, None::<&str>)?;
    let codex_item = MenuItem::with_id(app, "start-codex", "打开 Codex", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &codex_item, &separator, &quit_item])?;
    let mut builder = TrayIconBuilder::new()
        .tooltip("CodexLink macOS")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "start-codex" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    let _ = start_codex_action(&app, &state, &json!({}), false).await;
                });
            }
            "quit" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    stop_injection(&app).await;
                    app.exit(0);
                });
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data)?;
            let settings_path = app_data.join("settings.json");
            let http = Client::builder()
                .redirect(reqwest::redirect::Policy::limited(10))
                .timeout(std::time::Duration::from_secs(30))
                .build()?;
            app.manage(AppState {
                http,
                settings: Mutex::new(Settings::load(&settings_path)),
                settings_path,
                account: Mutex::new(AccountState::load()),
                vault: Mutex::new(VaultState::load()),
                conversations: ConversationService::new()
                    .map_err(std::io::Error::other)?,
                cdp: Mutex::new(None),
                history_busy: AtomicBool::new(false),
                available_update: Mutex::new(None),
            });
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                interval.tick().await;
                loop {
                    interval.tick().await;
                    let state = app_handle.state::<AppState>();
                    let mut account = state.account.lock().await;
                    if !account.logged_in {
                        continue;
                    }
                    match account.refresh_balance(&state.http).await {
                        Ok(()) => post(&app_handle, account.balance_payload()),
                        Err(error) => post_log(
                            &app_handle,
                            &format!("自动刷新余额失败：{}", public_message(error)),
                            "error",
                        ),
                    }
                }
            });
            setup_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![handle_action])
        .run(tauri::generate_context!())
        .expect("error while running CodexLink");
}
