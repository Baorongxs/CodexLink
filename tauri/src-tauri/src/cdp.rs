use crate::{post_log, post_status, AppState};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::{Command, Stdio},
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

pub async fn stop_codex(app: &AppHandle) {
    stop_injection(app).await;
    let app_name = find_install()
        .and_then(|path| path.file_stem().map(|value| value.to_string_lossy().to_string()))
        .unwrap_or_else(|| "Codex".to_string())
        .replace('"', "\\\"");
    let _ = tokio::process::Command::new("/usr/bin/osascript")
        .args(["-e", &format!("tell application \"{app_name}\" to quit")])
        .kill_on_drop(true)
        .output()
        .await;
    tokio::time::sleep(Duration::from_millis(800)).await;
}

pub async fn start_codex(
    app: &AppHandle,
    debug_port: u16,
    restart: bool,
) -> Result<(), String> {
    let app_path = find_install().ok_or_else(|| "未找到 Codex，请先点击“安装 Codex”。".to_string())?;
    if restart {
        stop_codex(app).await;
    }
    post_status(app, "正在启动 Codex…");
    Command::new("/usr/bin/open")
        .args([
            "-na",
            app_path
                .to_str()
                .ok_or_else(|| "Codex 安装路径无效。".to_string())?,
            "--args",
            &format!("--remote-debugging-port={debug_port}"),
            "--remote-debugging-address=127.0.0.1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    post_log(app, "已启动 macOS Codex，正在连接页面增强功能。", "info");
    start_injection(app, debug_port).await
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
    let response = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("调试端口 HTTP {}", response.status().as_u16()));
    }
    let targets: Vec<Value> = response.json().await.map_err(|error| error.to_string())?;
    let candidates: Vec<&Value> = targets
        .iter()
        .filter(|target| {
            target.get("type").and_then(Value::as_str) == Some("page")
                && target
                    .get("webSocketDebuggerUrl")
                    .and_then(Value::as_str)
                    .is_some()
                && !target
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .starts_with("devtools://")
        })
        .collect();
    let preferred = candidates
        .iter()
        .copied()
        .find(|target| {
            let haystack = format!(
                "{} {}",
                target.get("title").and_then(Value::as_str).unwrap_or(""),
                target.get("url").and_then(Value::as_str).unwrap_or("")
            )
            .to_lowercase();
            haystack.contains("codex") || haystack.contains("chatgpt") || haystack.contains("index.html")
        })
        .or_else(|| candidates.first().copied())
        .ok_or_else(|| "未找到 Codex 页面".to_string())?;
    Ok(preferred
        .get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
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
