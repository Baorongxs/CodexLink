use regex::Regex;
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use url::Url;
use uuid::Uuid;

pub const KEYCHAIN_SERVICE: &str = "top.baorongxs.codexlink";

pub fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())
}

pub fn atomic_write(path: &Path, bytes: impl AsRef<[u8]>) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "文件路径无效。".to_string())?;
    ensure_dir(parent)?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("data");
    let temp = parent.join(format!(".{name}.codexlink-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::File::create(&temp).map_err(|error| error.to_string())?;
        file.write_all(bytes.as_ref())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temp, path).map_err(|error| error.to_string())
    })();
    let _ = fs::remove_file(&temp);
    result
}

pub fn sha256(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

pub fn stable_id(source: &str, value: &str) -> String {
    let key = format!("{source}|{}", value.trim()).to_lowercase();
    format!("profile-{}", &sha256(key.as_bytes())[..24])
}

pub fn normalize_base(value: &str) -> Result<String, String> {
    let mut url = Url::parse(value.trim()).map_err(|_| "服务地址格式无效。".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("服务地址必须是 HTTP 或 HTTPS。".to_string());
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

pub fn validate_endpoint(value: &str) -> Result<String, String> {
    let endpoint = normalize_base(value)?;
    let url = Url::parse(&endpoint).map_err(|_| "API 请求地址无效。".to_string())?;
    if matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1")) {
        return Err("API 请求地址无效或需要本地路由。".to_string());
    }
    Ok(endpoint)
}

pub fn public_message(value: impl ToString) -> String {
    let mut text = value.to_string();
    let token = Regex::new(r"sk-[A-Za-z0-9._-]{8,}").expect("token regex");
    let path = Regex::new(r#"(?i)(?:/Users/|[A-Za-z]:\\Users\\)[^\s"'<>]+"#).expect("path regex");
    let url = Regex::new(r#"https?://[^\s"'<>]+"#).expect("url regex");
    text = token.replace_all(&text, "[已隐藏令牌]").into_owned();
    text = path.replace_all(&text, "[已隐藏路径]").into_owned();
    text = url.replace_all(&text, "[已隐藏地址]").into_owned();
    if text.chars().count() > 280 {
        text = text.chars().take(280).collect();
    }
    if text.is_empty() {
        return "操作失败，请稍后重试。".to_string();
    }
    let rules = [
        (r"(?i)username.*password|password.*incorrect|invalid credentials|login failed", "用户名或密码错误。"),
        (r"(?i)invalid params|invalid parameters|bad request", "请求参数无效，请检查填写内容。"),
        (r"(?i)password login.*disabled|password authentication.*disabled", "当前服务已关闭密码登录。"),
        (r"(?i)too many requests|rate limit|request.*frequent", "操作过于频繁，请稍后再试。"),
        (r"(?i)unauthorized|not logged in|auth.*expired|token.*expired|session.*expired|session.*revoked", "登录会话已过期，请重新登录。"),
        (r"(?i)user.*banned|user.*disabled|account.*disabled", "账号已被禁用，请联系管理员。"),
        (r"(?i)timed out|timeout|operation was canceled|task was canceled", "请求超时，请检查网络后重试。"),
        (r"(?i)sending the request|connection.*refused|name.*resolved|network.*unreachable|ssl|certificate|fetch failed", "无法连接服务器，请检查网络和服务地址。"),
        (r"(?i)internal server error|database error|service unavailable|bad gateway|gateway timeout", "服务器暂时异常，请稍后重试。"),
        (r"(?i)not found", "请求的接口不存在，请检查服务版本。"),
    ];
    for (pattern, message) in rules {
        if Regex::new(pattern).expect("message regex").is_match(&text) {
            return message.to_string();
        }
    }
    let has_chinese = Regex::new(r"[\u{3400}-\u{9fff}]").expect("Chinese regex").is_match(&text);
    let has_english = Regex::new(r"[A-Za-z]{3,}").expect("English regex").is_match(&text);
    if !has_chinese && has_english {
        "操作失败，请稍后重试。".to_string()
    } else {
        text
    }
}

pub fn keychain_get(account: &str) -> Option<Vec<u8>> {
    get_generic_password(KEYCHAIN_SERVICE, account).ok()
}

pub fn keychain_set(account: &str, bytes: &[u8]) -> Result<(), String> {
    set_generic_password(KEYCHAIN_SERVICE, account, bytes).map_err(|error| error.to_string())
}

pub fn keychain_delete(account: &str) {
    let _ = delete_generic_password(KEYCHAIN_SERVICE, account);
}

pub fn escape_toml(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn config_lines(config: &str) -> Vec<String> {
    config
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(ToOwned::to_owned)
        .collect()
}

fn is_table(line: &str) -> bool {
    let value = line.trim();
    value.starts_with('[') && value.contains(']')
}

pub fn upsert_top_level(config: &str, key: &str, raw_value: &str) -> String {
    let matcher = Regex::new(&format!(r"^\s*{}\s*=", regex::escape(key))).expect("key regex");
    let mut result = Vec::new();
    let mut inserted = false;
    let mut in_table = false;
    for line in config_lines(config) {
        if is_table(&line) {
            if !inserted {
                result.push(format!("{key} = {raw_value}"));
                inserted = true;
            }
            in_table = true;
        }
        if !in_table && matcher.is_match(&line) {
            if !inserted {
                result.push(format!("{key} = {raw_value}"));
                inserted = true;
            }
            continue;
        }
        result.push(line);
    }
    if !inserted {
        result.insert(0, format!("{key} = {raw_value}"));
    }
    format!("{}\n", result.join("\n").trim_end_matches('\n'))
}

pub fn remove_top_level(config: &str, key: &str) -> String {
    let matcher = Regex::new(&format!(r"^\s*{}\s*=", regex::escape(key))).expect("key regex");
    let mut result = Vec::new();
    let mut in_table = false;
    for line in config_lines(config) {
        if is_table(&line) {
            in_table = true;
        }
        if !in_table && matcher.is_match(&line) {
            continue;
        }
        result.push(line);
    }
    format!("{}\n", result.join("\n").trim_end_matches('\n'))
}

pub fn read_top_level(config: &str, key: &str) -> String {
    let matcher = Regex::new(&format!(
        r#"^\s*{}\s*=\s*["']([^"']*)["']"#,
        regex::escape(key)
    ))
    .expect("key regex");
    for line in config_lines(config) {
        if is_table(&line) {
            break;
        }
        if let Some(captures) = matcher.captures(&line) {
            return captures
                .get(1)
                .map(|value| value.as_str().trim().to_string())
                .unwrap_or_default();
        }
    }
    String::new()
}

pub fn replace_table(config: &str, table: &str, replacement: &[String]) -> String {
    let table_matcher = Regex::new(r"^\s*\[([^\]]+)\]\s*(?:#.*)?$").expect("table regex");
    let mut result = Vec::new();
    let mut skipping = false;
    for line in config_lines(config) {
        if let Some(captures) = table_matcher.captures(&line) {
            let name = captures.get(1).map(|value| value.as_str().trim()).unwrap_or("");
            if name == table {
                skipping = true;
                continue;
            }
            if skipping {
                skipping = false;
            }
        }
        if !skipping {
            result.push(line);
        }
    }
    while result.last().is_some_and(|line| line.trim().is_empty()) {
        result.pop();
    }
    if !replacement.is_empty() {
        if !result.is_empty() {
            result.push(String::new());
        }
        result.extend_from_slice(replacement);
    }
    format!("{}\n", result.join("\n"))
}

pub fn read_toml(config: &str, key: &str) -> String {
    let matcher = Regex::new(&format!(
        r#"(?im)^\s*{}\s*=\s*["']([^"']+)["']"#,
        regex::escape(key)
    ))
    .expect("toml regex");
    matcher
        .captures(config)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().trim().to_string())
        .unwrap_or_default()
}

pub fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "无法确定用户目录。".to_string())
}

pub fn compare_versions(left: &str, right: &str) -> i32 {
    let a: Vec<i64> = left.split('.').map(|part| part.parse().unwrap_or(0)).collect();
    let b: Vec<i64> = right.split('.').map(|part| part.parse().unwrap_or(0)).collect();
    for index in 0..a.len().max(b.len()) {
        let delta = a.get(index).copied().unwrap_or(0) - b.get(index).copied().unwrap_or(0);
        if delta != 0 {
            return delta.signum() as i32;
        }
    }
    0
}
