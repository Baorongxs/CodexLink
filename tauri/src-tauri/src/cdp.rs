use crate::{post_log, post_status, AppState};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Clone)]
pub struct CdpClient {
    sender: mpsc::UnboundedSender<CdpCommand>,
}

enum CdpCommand {
    Request {
        method: String,
        params: Value,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Close,
}

impl CdpClient {
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let (reply, receiver) = oneshot::channel();
        self.sender
            .send(CdpCommand::Request {
                method: method.to_string(),
                params,
                reply,
            })
            .map_err(|_| "CDP 连接已关闭。".to_string())?;
        tokio::time::timeout(Duration::from_secs(10), receiver)
            .await
            .map_err(|_| format!("{method} 超时"))?
            .map_err(|_| "CDP 连接已关闭。".to_string())?
    }

    pub fn close(&self) {
        let _ = self.sender.send(CdpCommand::Close);
    }
}

pub fn find_install() -> Option<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    [
        PathBuf::from("/Applications/Codex.app"),
        home.join("Applications/Codex.app"),
        PathBuf::from("/Applications/ChatGPT.app"),
        home.join("Applications/ChatGPT.app"),
    ]
    .into_iter()
    .find(|path| path.exists())
}

pub fn normalize_port(value: i64) -> u16 {
    if (1024..=65535).contains(&value) {
        value as u16
    } else {
        9230
    }
}

pub async fn stop_codex(app: &AppHandle) -> Result<(), String> {
    stop_injection(app).await;
    let Some(app_path) = find_install() else {
        return Ok(());
    };
    if bundle_process_ids(&app_path).await.is_empty() {
        return Ok(());
    }
    let escaped_path = app_path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let _ = tokio::process::Command::new("/usr/bin/osascript")
        .args(["-e", &format!("tell application \"{escaped_path}\" to quit")])
        .kill_on_drop(true)
        .output()
        .await;
    if wait_for_bundle_exit(&app_path, Duration::from_secs(3)).await {
        return Ok(());
    }
    signal_bundle_processes(&app_path, "TERM").await;
    if wait_for_bundle_exit(&app_path, Duration::from_millis(2500)).await {
        return Ok(());
    }
    signal_bundle_processes(&app_path, "KILL").await;
    if wait_for_bundle_exit(&app_path, Duration::from_millis(2500)).await {
        return Ok(());
    }
    Err("Codex 仍在运行，无法安全重新打开。请先退出 Codex 后重试。".to_string())
}

async fn bundle_process_ids(app_path: &Path) -> Vec<i32> {
    let output = tokio::process::Command::new("/bin/ps")
        .args(["-ww", "-axo", "pid=,ppid=,command="])
        .kill_on_drop(true)
        .output()
        .await
        .ok();
    output
        .map(|value| parse_bundle_process_ids(&String::from_utf8_lossy(&value.stdout), app_path))
        .unwrap_or_default()
}

fn parse_bundle_process_ids(process_table: &str, app_path: &Path) -> Vec<i32> {
    let normalized = app_path.to_string_lossy().replace('\\', "/");
    let prefix = format!("{}/Contents/", normalized.trim_end_matches('/'));
    let rows: Vec<(i32, i32, String)> = process_table
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let parent = parts.next()?.parse().ok()?;
            let command = parts.collect::<Vec<_>>().join(" ").replace('\\', "/");
            Some((pid, parent, command))
        })
        .collect();
    let mut selected: HashSet<i32> = rows
        .iter()
        .filter(|(_, _, command)| {
            command.starts_with(&prefix) || command.starts_with(&format!("\"{prefix}"))
        })
        .map(|(pid, _, _)| *pid)
        .collect();
    loop {
        let before = selected.len();
        for (pid, parent, _) in &rows {
            if selected.contains(parent) {
                selected.insert(*pid);
            }
        }
        if selected.len() == before {
            break;
        }
    }
    let mut ids: Vec<i32> = selected.into_iter().collect();
    ids.sort_unstable_by(|left, right| right.cmp(left));
    ids
}

async fn wait_for_bundle_exit(app_path: &Path, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if bundle_process_ids(app_path).await.is_empty() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn signal_bundle_processes(app_path: &Path, signal: &str) {
    let ids = bundle_process_ids(app_path).await;
    if ids.is_empty() {
        return;
    }
    let mut command = tokio::process::Command::new("/bin/kill");
    command.arg(format!("-{signal}"));
    command.args(ids.iter().map(i32::to_string));
    let _ = command.kill_on_drop(true).output().await;
}

pub async fn start_codex(
    app: &AppHandle,
    debug_port: u16,
) -> Result<u16, String> {
    let app_path = find_install().ok_or_else(|| "未找到 Codex，请先点击“安装 Codex”。".to_string())?;
    let debug_port = select_available_debug_port(debug_port).await?;
    post_status(app, "正在启动 Codex…");
    let launch_args = build_launch_args(&app_path, debug_port)?;
    let output = tokio::process::Command::new("/usr/bin/open")
        .args(&launch_args)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    post_log(app, "已启动 macOS Codex，正在连接页面增强功能。", "info");
    start_injection(app, debug_port).await?;
    Ok(debug_port)
}

fn build_launch_args(app_path: &Path, debug_port: u16) -> Result<Vec<String>, String> {
    Ok(vec![
        "-a".to_string(),
        app_path
            .to_str()
            .ok_or_else(|| "Codex 安装路径无效。".to_string())?
            .to_string(),
        "--args".to_string(),
        format!("--remote-debugging-port={debug_port}"),
        "--remote-debugging-address=127.0.0.1".to_string(),
        "--remote-allow-origins=*".to_string(),
    ])
}

async fn select_available_debug_port(preferred: u16) -> Result<u16, String> {
    if let Ok(listener) = tokio::net::TcpListener::bind(("127.0.0.1", preferred)).await {
        drop(listener);
        return Ok(preferred);
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| error.to_string())?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    drop(listener);
    Ok(port)
}

pub async fn start_injection(app: &AppHandle, debug_port: u16) -> Result<(), String> {
    stop_injection(app).await;
    let state = app.state::<AppState>();
    let http = state.http.clone();
    let mut last_error = "超时".to_string();
    for _ in 0..30 {
        match find_page_socket(&http, debug_port).await {
            Ok(url) => match connect_cdp(app.clone(), &url).await {
                Ok(client) => {
                    *state.cdp.lock().await = Some(client);
                    post_status(app, "Codex 已连接");
                    post_log(app, "余额、上下文与对话工具已注入 Codex。", "ok");
                    return Ok(());
                }
                Err(error) => last_error = error,
            },
            Err(error) => last_error = error,
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    post_status(app, "Codex 已打开（增强功能未连接）");
    Err(format!("Codex 已打开，但页面增强功能连接失败：{last_error}"))
}

pub async fn stop_injection(app: &AppHandle) {
    let state = app.state::<AppState>();
    let client = {
        let mut guard = state.cdp.lock().await;
        guard.take()
    };
    if let Some(client) = client {
        client.close();
    }
}

async fn find_page_socket(client: &reqwest::Client, port: u16) -> Result<String, String> {
    let mut last_error = "未找到 Codex 页面".to_string();
    for endpoint in ["/json/list", "/json"] {
        let response = match client
            .get(format!("http://127.0.0.1:{port}{endpoint}"))
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                last_error = error.to_string();
                continue;
            }
        };
        if !response.status().is_success() {
            last_error = format!("调试端口 HTTP {}", response.status().as_u16());
            continue;
        }
        let targets: Vec<Value> = match response.json().await {
            Ok(targets) => targets,
            Err(error) => {
                last_error = error.to_string();
                continue;
            }
        };
        if let Some(socket) = select_page_socket(&targets) {
            return Ok(socket);
        }
    }
    Err(last_error)
}

fn select_page_socket(targets: &[Value]) -> Option<String> {
    targets
        .iter()
        .filter_map(|target| {
            let socket = target.get("webSocketDebuggerUrl")?.as_str()?;
            if !(socket.starts_with("ws://") || socket.starts_with("wss://")) {
                return None;
            }
            let target_type = target.get("type").and_then(Value::as_str).unwrap_or("").to_lowercase();
            if !target_type.is_empty() && !matches!(target_type.as_str(), "page" | "webview" | "other") {
                return None;
            }
            let url = target.get("url").and_then(Value::as_str).unwrap_or("");
            let title = target.get("title").and_then(Value::as_str).unwrap_or("");
            if url.starts_with("devtools://") || url.to_lowercase().starts_with("data:text/html") {
                return None;
            }
            let text = format!("{title} {url}").to_lowercase();
            let app_shell = text.contains("codex")
                || text.contains("chatgpt")
                || text.contains("index.html")
                || url.starts_with("app:")
                || url.starts_with("file:");
            if target_type == "other" && !app_shell {
                return None;
            }
            let avatar = text.contains("avatar-overlay");
            let startup_error = text.contains("failed to start")
                || text.contains("something went wrong")
                || text.contains("err_failed");
            let blank = url.is_empty() || url.eq_ignore_ascii_case("about:blank") || url.ends_with("://");
            let mut score = 50i32;
            if avatar { score -= 500; }
            if startup_error { score -= 500; }
            if blank { score -= 200; }
            if title.to_lowercase().contains("codex") { score += 120; }
            if url.to_lowercase().contains("codex") { score += 80; }
            if text.contains("chatgpt") { score += 40; }
            if url.to_lowercase().contains("index.html") && !avatar { score += 180; }
            if url.starts_with("app:") || url.starts_with("file:") { score += 60; }
            else if url.starts_with("http:") || url.starts_with("https:") { score += 10; }
            Some((score, socket.to_string()))
        })
        .filter(|(score, _)| *score >= 50)
        .max_by_key(|(score, _)| *score)
        .map(|(_, socket)| socket)
}

#[cfg(test)]
mod tests {
    use super::{build_launch_args, parse_bundle_process_ids, select_page_socket};
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn selects_macos_app_shell_and_skips_overlay() {
        let targets = vec![
            json!({ "type": "page", "url": "devtools://devtools", "webSocketDebuggerUrl": "ws://bad" }),
            json!({ "type": "page", "title": "avatar-overlay", "url": "file:///avatar-overlay.html", "webSocketDebuggerUrl": "ws://overlay" }),
            json!({ "type": "page", "title": "ChatGPT failed to start", "url": "data:text/html;charset=utf-8,%3Ch1%3ESomething%20went%20wrong", "webSocketDebuggerUrl": "ws://error" }),
            json!({ "type": "other", "url": "file:///Codex.app/Contents/Resources/app/index.html", "webSocketDebuggerUrl": "ws://codex" }),
        ];
        assert_eq!(select_page_socket(&targets).as_deref(), Some("ws://codex"));
    }

    #[test]
    fn reopens_one_launchservices_instance() {
        let args = build_launch_args(Path::new("/Applications/ChatGPT.app"), 9230).unwrap();
        assert_eq!(
            args.iter().take(3).map(String::as_str).collect::<Vec<_>>(),
            vec!["-a", "/Applications/ChatGPT.app", "--args"]
        );
        assert!(!args.iter().any(|value| matches!(value.as_str(), "-n" | "-na" | "-F")));
        assert!(args.iter().any(|value| value == "--remote-debugging-port=9230"));
    }

    #[test]
    fn finds_bundle_helpers_and_descendants_only() {
        let ids = parse_bundle_process_ids(
            r#"
  100     1 /Applications/Codex.app/Contents/MacOS/ChatGPT --remote-debugging-port=9230
  101   100 /Applications/Codex.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper
  102   101 /usr/bin/helper-child
  200     1 /usr/local/bin/codex
  201     1 /Applications/Other.app/Contents/MacOS/Other /Applications/Codex.app
  202     1 /Applications/Other.app/Contents/MacOS/Other /Applications/Codex.app/Contents/Resources/file
            "#,
            Path::new("/Applications/Codex.app"),
        );
        assert_eq!(ids, vec![102, 101, 100]);
    }
}

async fn connect_cdp(app: AppHandle, url: &str) -> Result<CdpClient, String> {
    let (socket, _) = connect_async(url).await.map_err(|error| error.to_string())?;
    let (mut writer, mut reader) = socket.split();
    let (sender, mut receiver) = mpsc::unbounded_channel::<CdpCommand>();
    let client = CdpClient { sender };
    let task_client = client.clone();
    let task_app = app.clone();

    tauri::async_runtime::spawn(async move {
        let mut sequence = 0u64;
        let mut pending: HashMap<u64, oneshot::Sender<Result<Value, String>>> = HashMap::new();
        loop {
            tokio::select! {
                command = receiver.recv() => {
                    match command {
                        Some(CdpCommand::Request { method, params, reply }) => {
                            sequence += 1;
                            let id = sequence;
                            let message = json!({ "id": id, "method": method, "params": params });
                            if writer.send(Message::Text(message.to_string().into())).await.is_err() {
                                let _ = reply.send(Err("CDP 写入失败。".to_string()));
                                break;
                            }
                            pending.insert(id, reply);
                        }
                        Some(CdpCommand::Close) | None => {
                            let _ = writer.close().await;
                            break;
                        }
                    }
                }
                message = reader.next() => {
                    let Some(message) = message else {
                        break;
                    };
                    let Ok(message) = message else {
                        break;
                    };
                    let Ok(text) = message.into_text() else {
                        continue;
                    };
                    let Ok(value) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    if let Some(id) = value.get("id").and_then(Value::as_u64) {
                        if let Some(reply) = pending.remove(&id) {
                            let result = if let Some(error) = value.get("error") {
                                Err(error
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("CDP 请求失败")
                                    .to_string())
                            } else {
                                Ok(value.get("result").cloned().unwrap_or(Value::Null))
                            };
                            let _ = reply.send(result);
                        }
                        continue;
                    }
                    if value.get("method").and_then(Value::as_str) == Some("Runtime.bindingCalled")
                        && value.pointer("/params/name").and_then(Value::as_str)
                            == Some("__codexLauncherBridge")
                    {
                        let params = value.get("params").cloned().unwrap_or_else(|| json!({}));
                        let binding_app = task_app.clone();
                        let binding_client = task_client.clone();
                        tauri::async_runtime::spawn(async move {
                            handle_binding(binding_app, binding_client, params).await;
                        });
                    }
                }
            }
        }
        for (_, reply) in pending {
            let _ = reply.send(Err("连接已关闭".to_string()));
        }
        post_status(&task_app, "Codex 页面增强连接已断开");
    });

    client.request("Runtime.enable", json!({})).await?;
    client.request("Page.enable", json!({})).await?;
    client
        .request(
            "Runtime.addBinding",
            json!({ "name": "__codexLauncherBridge" }),
        )
        .await?;
    let bundle = build_inject_bundle();
    client
        .request(
            "Page.addScriptToEvaluateOnNewDocument",
            json!({ "source": bundle }),
        )
        .await?;
    client
        .request(
            "Page.reload",
            json!({ "ignoreCache": false }),
        )
        .await?;
    tokio::time::sleep(Duration::from_millis(350)).await;
    Ok(client)
}

fn build_inject_bundle() -> String {
    [
        include_str!("../../frontend/inject/bridge.js"),
        include_str!("../../frontend/inject/usage-core.js"),
        include_str!("../../frontend/inject/balance-overlay.js"),
        include_str!("../../frontend/inject/usage-badge.js"),
        include_str!("../../frontend/inject/thread-delete.js"),
        include_str!("../../frontend/inject/context-bar.js"),
    ]
    .join("\n;\n")
}

async fn handle_binding(app: AppHandle, client: CdpClient, params: Value) {
    let request = params
        .get("payload")
        .and_then(Value::as_str)
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .unwrap_or_else(|| json!({}));
    let path = request.get("path").and_then(Value::as_str).unwrap_or("");
    let payload = request.get("payload").cloned().unwrap_or_else(|| json!({}));
    let result = match path {
        "/balance/get" => {
            let state = app.state::<AppState>();
            let account = state.account.lock().await;
            let mut value = account.balance_payload();
            value["ok"] = json!(true);
            value
        }
        "/usage/resolve" => {
            let state = app.state::<AppState>();
            let mut account = state.account.lock().await;
            match account.resolve_usage(&state.http, &payload).await {
                Ok(value) => value,
                Err(error) => json!({ "ok": false, "error": error }),
            }
        }
        "/context/get" => {
            let state = app.state::<AppState>();
            state.conversations.read_context(
                payload.get("threadId").and_then(Value::as_str).unwrap_or(""),
            )
        }
        "/thread/delete" => {
            let state = app.state::<AppState>();
            state
                .conversations
                .delete_thread(payload.get("threadId").and_then(Value::as_str).unwrap_or(""))
                .unwrap_or_else(|error| json!({ "ok": false, "error": error }))
        }
        _ => json!({ "ok": false, "error": "unsupported_path" }),
    };
    let envelope = json!({
        "id": request.get("id").and_then(Value::as_str).unwrap_or(""),
        "result": result
    })
    .to_string();
    let expression = format!(
        "window.__codexLauncherResolve({})",
        serde_json::to_string(&envelope).unwrap_or_else(|_| "\"{}\"".to_string())
    );
    let _ = client
        .request(
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "contextId": params.get("executionContextId").cloned().unwrap_or(Value::Null),
                "returnByValue": true
            }),
        )
        .await;
}
