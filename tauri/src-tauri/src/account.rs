use crate::util::{keychain_delete, keychain_get, keychain_set, normalize_base, public_message};
use chrono::Local;
use reqwest::{
    header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE, COOKIE, SET_COOKIE, USER_AGENT},
    Client, Method,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

const SESSION_KEY: &str = "session-v2";
const QUOTA_PER_UNIT: f64 = 500_000.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AccountState {
    pub logged_in: bool,
    pub base_url: String,
    pub username: String,
    pub display_name: String,
    pub user_id: String,
    pub cookie_header: String,
    pub access_token: String,
    pub access_expires_at: i64,
    pub auth_session_id: String,
    pub quota: f64,
    pub used_quota: f64,
    pub balance_text: String,
    pub used_text: String,
    pub refreshed_at: String,
}

impl Default for AccountState {
    fn default() -> Self {
        Self {
            logged_in: false,
            base_url: String::new(),
            username: String::new(),
            display_name: String::new(),
            user_id: String::new(),
            cookie_header: String::new(),
            access_token: String::new(),
            access_expires_at: 0,
            auth_session_id: String::new(),
            quota: 0.0,
            used_quota: 0.0,
            balance_text: "$--".to_string(),
            used_text: "$--".to_string(),
            refreshed_at: String::new(),
        }
    }
}

impl AccountState {
    pub fn load() -> Self {
        let mut state = keychain_get(SESSION_KEY)
            .and_then(|bytes| serde_json::from_slice::<Self>(&bytes).ok())
            .unwrap_or_default();
        state.apply_money_texts();
        state
    }

    pub fn save(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(self).map_err(|error| error.to_string())?;
        keychain_set(SESSION_KEY, &bytes)
    }

    pub fn clear(&mut self) {
        *self = Self::default();
        keychain_delete(SESSION_KEY);
    }

    pub fn ensure_logged_in(&self) -> Result<(), String> {
        if self.logged_in {
            Ok(())
        } else {
            Err("请先登录。".to_string())
        }
    }

    fn format_money(value: f64) -> String {
        let amount = if value.is_finite() { value } else { 0.0 };
        let mut result = if amount >= 100.0 {
            format!("{amount:.2}")
        } else {
            format!("{amount:.4}")
        };
        while result.contains('.') && result.ends_with('0') {
            result.pop();
        }
        if result.ends_with('.') {
            result.pop();
        }
        format!("${result}")
    }

    fn apply_money_texts(&mut self) {
        self.balance_text = Self::format_money(self.quota / QUOTA_PER_UNIT);
        self.used_text = Self::format_money(self.used_quota / QUOTA_PER_UNIT);
    }

    fn capture_cookies(&mut self, headers: &HeaderMap) {
        let mut cookies = BTreeMap::new();
        for item in self.cookie_header.split(';').map(str::trim).filter(|item| !item.is_empty()) {
            if let Some((key, value)) = item.split_once('=') {
                cookies.insert(key.to_string(), value.to_string());
            }
        }
        for value in headers.get_all(SET_COOKIE).iter() {
            if let Ok(text) = value.to_str() {
                if let Some(pair) = text.split(';').next() {
                    if let Some((key, value)) = pair.split_once('=') {
                        cookies.insert(key.to_string(), value.to_string());
                    }
                }
            }
        }
        if !cookies.is_empty() {
            self.cookie_header = cookies
                .into_iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
                .join("; ");
        }
    }

    async fn raw_request(
        &mut self,
        client: &Client,
        base_url: &str,
        relative_path: &str,
        method: Method,
        body: Option<Value>,
        authenticated: bool,
    ) -> Result<Value, String> {
        let base_url = normalize_base(base_url)?;
        if authenticated {
            self.ensure_logged_in()?;
            self.ensure_fresh_access_token(client, false).await?;
        }
        for attempt in 0..2 {
            if authenticated && attempt > 0 {
                self.ensure_fresh_access_token(client, true).await?;
            }
            let endpoint = format!("{base_url}{relative_path}");
            let mut request = client
                .request(method.clone(), endpoint)
                .header(ACCEPT, HeaderValue::from_static("application/json"))
                .header("Accept-Language", HeaderValue::from_static("zh-CN,zh;q=0.9"))
                .header(USER_AGENT, HeaderValue::from_static("CodexLink/1.0.25 Tauri macOS"));
            if authenticated && method == Method::GET {
                request = request
                    .header("Cache-Control", HeaderValue::from_static("no-cache, no-store"))
                    .header("Pragma", HeaderValue::from_static("no-cache"));
            }
            if let Some(ref json_body) = body {
                request = request
                    .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
                    .json(json_body);
            }
            if authenticated {
                if !self.cookie_header.is_empty() {
                    request = request.header(COOKIE, self.cookie_header.clone());
                }
                if !self.user_id.is_empty() {
                    request = request.header("New-Api-User", self.user_id.clone());
                }
                if !self.access_token.is_empty() {
                    request = request.header("Authorization", format!("Bearer {}", self.access_token));
                }
                if !self.auth_session_id.is_empty() {
                    request = request.header("X-Auth-Session", self.auth_session_id.clone());
                }
            }
            let response = request.send().await.map_err(|error| public_message(error))?;
            let status = response.status();
            self.capture_cookies(response.headers());
            let text = response.text().await.map_err(|error| public_message(error))?;
            let envelope: Value = if text.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&text)
                    .map_err(|_| format!("服务返回了无效数据（HTTP {}）。", status.as_u16()))?
            };
            if status.as_u16() == 401 && authenticated && attempt == 0 && self.is_modern_authentication() {
                continue;
            }
            if !status.is_success()
                || envelope.get("success").is_some_and(|value| value == &Value::Bool(false))
            {
                return Err(Self::api_failure_message(&envelope, status.as_u16()));
            }
            if authenticated {
                self.save()?;
            }
            return Ok(envelope);
        }
        Err("登录会话已过期，请重新登录。".to_string())
    }

    pub async fn request(
        &mut self,
        client: &Client,
        relative_path: &str,
        method: Method,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let base_url = self.base_url.clone();
        let envelope = self
            .raw_request(client, &base_url, relative_path, method, body, true)
            .await?;
        Ok(envelope.get("data").cloned().unwrap_or(envelope))
    }

    pub async fn login(
        &mut self,
        client: &Client,
        base_url: &str,
        username: &str,
        password: &str,
    ) -> Result<(), String> {
        let username = username.trim();
        if username.is_empty() || password.is_empty() {
            return Err("请输入用户名和密码。".to_string());
        }
        let base_url = normalize_base(base_url)?;
        let envelope = self
            .raw_request(
                client,
                &base_url,
                "/api/user/login",
                Method::POST,
                Some(json!({ "username": username, "password": password })),
                false,
            )
            .await?;
        let data = envelope.get("data").cloned().unwrap_or_else(|| json!({}));
        if data.get("require_2fa").and_then(Value::as_bool).unwrap_or(false) {
            return Err("该账号需要 2FA，请先在网页完成二次验证。".to_string());
        }
        let user = data.get("user").unwrap_or(&Value::Null);
        let mut user_id = value_string(
            data.get("id")
                .or_else(|| data.get("user_id"))
                .or_else(|| data.get("userId")),
        );
        if user_id.is_empty() {
            user_id = value_string(
                user.get("id")
                    .or_else(|| user.get("user_id"))
                    .or_else(|| user.get("userId")),
            );
        }
        if user_id.is_empty() {
            return Err("登录响应缺少用户信息，请确认 New API 已完整更新后重试。".to_string());
        }
        let auth_session = data.get("session").unwrap_or(&Value::Null);
        self.logged_in = true;
        self.base_url = base_url;
        self.username = username.to_string();
        self.display_name = user
            .get("display_name")
            .or_else(|| user.get("displayName"))
            .or_else(|| data.get("display_name"))
            .or_else(|| data.get("displayName"))
            .and_then(Value::as_str)
            .unwrap_or(username)
            .to_string();
        self.user_id = user_id;
        self.access_token = value_string(data.get("access_token").or_else(|| data.get("accessToken")));
        self.access_expires_at = value_f64(
            data.get("access_expires_at").or_else(|| data.get("accessExpiresAt")),
        ) as i64;
        self.auth_session_id = value_string(
            auth_session.get("sid").or_else(|| auth_session.get("id")),
        );
        self.save()?;
        Ok(())
    }

    fn is_modern_authentication(&self) -> bool {
        !self.access_token.is_empty()
    }

    async fn ensure_fresh_access_token(&mut self, client: &Client, force: bool) -> Result<(), String> {
        if !self.is_modern_authentication() {
            return Ok(());
        }
        let now = chrono::Utc::now().timestamp();
        if !force && (self.access_expires_at <= 0 || self.access_expires_at > now + 60) {
            return Ok(());
        }
        let base_url = normalize_base(&self.base_url)?;
        let endpoint = format!("{base_url}/api/user/auth/refresh");
        let mut request = client
            .post(endpoint)
            .header(ACCEPT, HeaderValue::from_static("application/json"))
            .header("Accept-Language", HeaderValue::from_static("zh-CN,zh;q=0.9"))
            .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
            .header(USER_AGENT, HeaderValue::from_static("CodexLink/1.0.25 Tauri macOS"))
            .header("Origin", base_url.clone())
            .header("Referer", format!("{base_url}/"))
            .header("Cache-Control", HeaderValue::from_static("no-cache, no-store"))
            .header("Pragma", HeaderValue::from_static("no-cache"))
            .json(&json!({}));
        if !self.cookie_header.is_empty() {
            request = request.header(COOKIE, self.cookie_header.clone());
        }
        if !self.auth_session_id.is_empty() {
            request = request.header("X-Auth-Session", self.auth_session_id.clone());
        }
        let response = request.send().await.map_err(|error| public_message(error))?;
        let status = response.status();
        self.capture_cookies(response.headers());
        let text = response.text().await.map_err(|error| public_message(error))?;
        let envelope: Value = serde_json::from_str(&text)
            .map_err(|_| "刷新登录会话失败，请重新登录。".to_string())?;
        if !status.is_success() || !envelope.get("success").and_then(Value::as_bool).unwrap_or(false) {
            return Err(Self::api_failure_message(&envelope, status.as_u16()));
        }
        let data = envelope.get("data").cloned().unwrap_or_else(|| json!({}));
        let token = value_string(data.get("access_token").or_else(|| data.get("accessToken")));
        if token.is_empty() {
            return Err("刷新登录会话失败，请重新登录。".to_string());
        }
        self.access_token = token;
        self.access_expires_at = value_f64(
            data.get("access_expires_at").or_else(|| data.get("accessExpiresAt")),
        ) as i64;
        if let Some(session) = data.get("session") {
            let session_id = value_string(session.get("sid").or_else(|| session.get("id")));
            if !session_id.is_empty() {
                self.auth_session_id = session_id;
            }
        }
        if let Some(user) = data.get("user") {
            let user_id = value_string(
                user.get("id")
                    .or_else(|| user.get("user_id"))
                    .or_else(|| user.get("userId")),
            );
            if !user_id.is_empty() {
                self.user_id = user_id;
            }
        }
        self.save()
    }

    fn api_failure_message(envelope: &Value, status: u16) -> String {
        if status == 401 {
            return "登录会话已过期，请重新登录。".to_string();
        }
        if status == 429 {
            return "操作过于频繁，请稍后再试。".to_string();
        }
        if status >= 500 && envelope.get("message").and_then(Value::as_str).unwrap_or("").is_empty() {
            return "服务器暂时异常，请稍后重试。".to_string();
        }
        let message = envelope
            .get("message")
            .or_else(|| envelope.get("error"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("请求失败（HTTP {status}）。"));
        public_message(message)
    }

    pub async fn register(
        &mut self,
        client: &Client,
        base_url: &str,
        username: &str,
        password: &str,
        email: &str,
        verification_code: &str,
        aff_code: &str,
    ) -> Result<(), String> {
        if username.is_empty() || password.is_empty() {
            return Err("请输入用户名和密码。".to_string());
        }
        if !(8..=20).contains(&password.chars().count()) {
            return Err("密码长度需为 8-20 位。".to_string());
        }
        if email.is_empty() || verification_code.is_empty() {
            return Err("请填写邮箱和邮箱验证码。".to_string());
        }
        let mut body = Map::new();
        body.insert("username".into(), json!(username));
        body.insert("password".into(), json!(password));
        body.insert("email".into(), json!(email));
        body.insert("verification_code".into(), json!(verification_code));
        if !aff_code.is_empty() {
            body.insert("aff_code".into(), json!(aff_code));
        }
        self.raw_request(
            client,
            base_url,
            "/api/user/register",
            Method::POST,
            Some(Value::Object(body)),
            false,
        )
        .await?;
        self.login(client, base_url, username, password).await
    }

    pub async fn send_email_code(
        &mut self,
        client: &Client,
        base_url: &str,
        email: &str,
    ) -> Result<(), String> {
        if email.is_empty() {
            return Err("请填写邮箱。".to_string());
        }
        let encoded: String = url::form_urlencoded::byte_serialize(email.as_bytes()).collect();
        self.raw_request(
            client,
            base_url,
            &format!("/api/verification?email={encoded}"),
            Method::GET,
            None,
            false,
        )
        .await?;
        Ok(())
    }

    pub async fn refresh_balance(&mut self, client: &Client) -> Result<(), String> {
        let path = format!("/api/user/self?codexlink_ts={}", chrono::Utc::now().timestamp_millis());
        let data = self.request(client, &path, Method::GET, None).await?;
        self.quota = value_f64(data.get("quota"));
        self.used_quota = value_f64(data.get("used_quota").or_else(|| data.get("usedQuota")));
        if let Some(value) = data.get("username").and_then(Value::as_str) {
            self.username = value.to_string();
        }
        if let Some(value) = data
            .get("display_name")
            .or_else(|| data.get("displayName"))
            .and_then(Value::as_str)
        {
            self.display_name = value.to_string();
        }
        let user_id = value_string(data.get("id").or_else(|| data.get("user_id")));
        if !user_id.is_empty() {
            self.user_id = user_id;
        }
        self.refreshed_at = Local::now().format("%Y/%m/%d %H:%M:%S").to_string();
        self.apply_money_texts();
        self.save()
    }

    pub fn balance_payload(&self) -> Value {
        json!({
            "type": "balance",
            "loggedIn": self.logged_in,
            "username": self.username,
            "displayName": self.display_name,
            "balanceText": self.balance_text,
            "usedText": self.used_text,
            "quota": self.quota,
            "usedQuota": self.used_quota,
            "refreshedAt": self.refreshed_at
        })
    }

    pub async fn get_topup_info(&mut self, client: &Client) -> Result<Value, String> {
        self.request(client, "/api/user/topup/info", Method::GET, None)
            .await
    }

    pub async fn calculate_topup(&mut self, client: &Client, amount: f64) -> Result<String, String> {
        if amount <= 0.0 {
            return Err("请输入有效的充值金额。".to_string());
        }
        let base_url = self.base_url.clone();
        let envelope = self
            .raw_request(
                client,
                &base_url,
                "/api/user/amount",
                Method::POST,
                Some(json!({ "amount": amount })),
                true,
            )
            .await?;
        let value = envelope.get("data").cloned().unwrap_or(Value::Null);
        if value.is_null() || value.as_str().is_some_and(str::is_empty) {
            return Err("未能计算待支付金额。".to_string());
        }
        Ok(value_string(Some(&value)))
    }

    pub async fn create_topup(
        &mut self,
        client: &Client,
        amount: f64,
        payment_method: &str,
    ) -> Result<(String, Value), String> {
        if amount <= 0.0 || payment_method.trim().is_empty() {
            return Err("请输入充值金额并选择付款方式。".to_string());
        }
        let base_url = self.base_url.clone();
        let envelope = self
            .raw_request(
                client,
                &base_url,
                "/api/user/pay",
                Method::POST,
                Some(json!({
                    "amount": amount,
                    "payment_method": payment_method.trim()
                })),
                true,
            )
            .await?;
        let url = envelope.get("url").and_then(Value::as_str).unwrap_or("");
        let fields = envelope.get("data").cloned().unwrap_or(Value::Null);
        if url.is_empty() || !fields.is_object() {
            return Err("付款页面创建失败，请稍后重试。".to_string());
        }
        Ok((url.to_string(), fields))
    }

    pub async fn list_all_tokens(&mut self, client: &Client) -> Result<Vec<Value>, String> {
        let mut all = Vec::new();
        for page in 1..100 {
            let data = self
                .request(
                    client,
                    &format!("/api/token/?p={page}&size=100"),
                    Method::GET,
                    None,
                )
                .await?;
            let items = data
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let count = items.len();
            all.extend(items);
            let total = value_f64(data.get("total")) as usize;
            if count < 100 || (total > 0 && page * 100 >= total) {
                break;
            }
        }
        Ok(all)
    }

    pub async fn resolve_usage(&mut self, client: &Client, request: &Value) -> Result<Value, String> {
        if !self.logged_in {
            return Ok(json!({
                "ok": true, "costReady": false, "costText": "需登录",
                "balanceText": "未登录", "loggedIn": false
            }));
        }
        let observed = request
            .get("observedAt")
            .and_then(Value::as_f64)
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis() as f64)
            / 1000.0;
        let path = format!(
            "/api/log/self?type=2&p=1&page_size=50&start_timestamp={}&end_timestamp={}",
            (observed as i64 - 180).max(0),
            observed as i64 + 30
        );
        let matched = self
            .request(client, &path, Method::GET, None)
            .await
            .ok()
            .and_then(|data| {
                data.get("items")
                    .or_else(|| data.get("data"))
                    .and_then(Value::as_array)
                    .and_then(|items| items.first())
                    .cloned()
            });
        self.refresh_balance(client).await?;
        let source = matched.as_ref();
        let input_tokens = value_f64(
            source
                .and_then(|value| value.get("prompt_tokens").or_else(|| value.get("promptTokens")))
                .or_else(|| request.get("inputTokens")),
        );
        let output_tokens = value_f64(
            source
                .and_then(|value| {
                    value
                        .get("completion_tokens")
                        .or_else(|| value.get("completionTokens"))
                })
                .or_else(|| request.get("outputTokens")),
        );
        let quota = source
            .and_then(|value| value.get("quota"))
            .map(|value| value_f64(Some(value)))
            .unwrap_or(-1.0);
        let estimated = (input_tokens / 1_000_000.0) * 2.5
            + (output_tokens / 1_000_000.0) * 10.0;
        let cost_text = if quota >= 0.0 {
            Self::format_money(quota / QUOTA_PER_UNIT)
        } else if estimated > 0.0 {
            format!("约 {}", Self::format_money(estimated))
        } else {
            "结算中…".to_string()
        };
        Ok(json!({
            "ok": true,
            "costReady": quota >= 0.0,
            "costText": cost_text,
            "costQuota": quota,
            "balanceText": self.balance_text,
            "usedText": self.used_text,
            "quota": self.quota,
            "usedQuota": self.used_quota,
            "username": self.username,
            "loggedIn": true,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "totalTokens": input_tokens + output_tokens,
            "model": source
                .and_then(|value| value.get("model_name").or_else(|| value.get("model")))
                .or_else(|| request.get("model"))
                .and_then(Value::as_str)
                .unwrap_or(""),
            "logId": value_string(source.and_then(|value| value.get("id")))
        }))
    }
}

pub fn value_f64(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(0.0),
        Some(Value::String(text)) => text.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

pub fn value_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}
