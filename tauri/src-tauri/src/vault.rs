use crate::{
    account::{value_string, AccountState},
    util::{
        atomic_write, ensure_dir, escape_toml, home_dir, keychain_get, keychain_set,
        public_message, read_toml, read_top_level, remove_top_level, replace_table, stable_id,
        upsert_top_level, validate_endpoint,
    },
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::{Client, Method};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}};

const VAULT_KEY: &str = "token-vault-v2";
const DEFAULT_MODEL: &str = "gpt-5.6-sol";
const DEFAULT_EFFORT: &str = "high";
pub const TOKEN_TARGETS: [(&str, &str); 9] = [
    ("0丨福利-GPT（用不了就换）", "0丨福利-GPT（用不了就换）"),
    ("GPT-PLUS-1", "A丨GPT-plus-1"),
    ("GPT-PLUS-2", "A丨GPT-plus-2"),
    ("GPT-PLUS-3", "A丨GPT-plus-3"),
    ("GPT-PLUS-4", "A丨GPT-plus-4"),
    ("GPT-PRO-1", "B丨GPT-Pro-1"),
    ("GPT-PRO-2", "B丨GPT-Pro-2"),
    ("GPT-PRO-3", "B丨GPT-Pro-3"),
    ("GPT-PRO-4", "B丨GPT-Pro-4"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub source: String,
    pub source_id: String,
    pub endpoint_url: String,
    pub model: String,
    pub reasoning_effort: String,
    pub api_key: String,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            source: String::new(),
            source_id: String::new(),
            endpoint_url: String::new(),
            model: DEFAULT_MODEL.to_string(),
            reasoning_effort: DEFAULT_EFFORT.to_string(),
            api_key: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VaultState {
    pub schema_version: u32,
    pub profiles: Vec<Profile>,
    pub current_profile_id: String,
    pub last_api_profile_id: String,
    pub official_mode: bool,
    pub official_auth_base64: String,
    pub migration_completed: bool,
    #[serde(skip)]
    pub codex_home: PathBuf,
    #[serde(skip)]
    pub cc_switch_db_path: PathBuf,
}

impl Default for VaultState {
    fn default() -> Self {
        let home = home_dir().unwrap_or_else(|_| PathBuf::from("."));
        Self {
            schema_version: 2,
            profiles: Vec::new(),
            current_profile_id: String::new(),
            last_api_profile_id: String::new(),
            official_mode: false,
            official_auth_base64: String::new(),
            migration_completed: false,
            codex_home: home.join(".codex"),
            cc_switch_db_path: home.join(".cc-switch").join("cc-switch.db"),
        }
    }
}

impl VaultState {
    pub fn load() -> Self {
        let mut state = keychain_get(VAULT_KEY)
            .and_then(|bytes| serde_json::from_slice::<Self>(&bytes).ok())
            .unwrap_or_default();
        let home = home_dir().unwrap_or_else(|_| PathBuf::from("."));
        state.codex_home = home.join(".codex");
        state.cc_switch_db_path = home.join(".cc-switch").join("cc-switch.db");
        state
    }

    pub fn save(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(self).map_err(|error| error.to_string())?;
        keychain_set(VAULT_KEY, &bytes)
    }

    pub fn initialize(&mut self) -> Result<(), String> {
        let mut changed = self.capture_official_auth();
        if !self.migration_completed {
            let config = self.read_config();
            let provider = read_top_level(&config, "model_provider");
            self.official_mode = matches!(provider.as_str(), "openai" | "openai-chatgpt")
                || (provider.is_empty() && !self.official_auth_base64.is_empty());
            self.migration_completed = true;
            changed = true;
        }
        if changed {
            self.save()?;
        }
        Ok(())
    }

    pub fn view(&mut self) -> Value {
        self.capture_official_auth();
        let mut profiles: Vec<Value> = self
            .profiles
            .iter()
            .map(|profile| {
                json!({
                    "id": profile.id,
                    "name": profile.name,
                    "source": profile.source
                })
            })
            .collect();
        profiles.sort_by(|left, right| {
            let a = format!(
                "{}|{}",
                left.get("source").and_then(Value::as_str).unwrap_or(""),
                left.get("name").and_then(Value::as_str).unwrap_or("")
            );
            let b = format!(
                "{}|{}",
                right.get("source").and_then(Value::as_str).unwrap_or(""),
                right.get("name").and_then(Value::as_str).unwrap_or("")
            );
            a.cmp(&b)
        });
        json!({
            "profiles": profiles,
            "currentId": self.current_profile_id,
            "officialMode": self.official_mode,
            "officialAvailable": !self.official_auth_base64.is_empty(),
            "ccSwitchImportAvailable": self.cc_switch_db_path.is_file()
        })
    }

    fn find_profile(&self, id: &str) -> Option<&Profile> {
        self.profiles.iter().find(|profile| profile.id == id)
    }

    pub fn select_profile(&mut self, id: &str) -> Result<(), String> {
        let profile = self
            .find_profile(id)
            .cloned()
            .ok_or_else(|| "目标令牌不存在，请重新导入。".to_string())?;
        self.apply_api_profile(&profile)?;
        self.current_profile_id = id.to_string();
        self.last_api_profile_id = id.to_string();
        self.official_mode = false;
        self.save()
    }

    pub fn set_official_mode(&mut self, enabled: bool) -> Result<(), String> {
        if enabled {
            self.capture_official_auth();
            self.apply_official_profile(true)?;
            self.official_mode = true;
            self.current_profile_id.clear();
        } else {
            let profile = self
                .find_profile(&self.last_api_profile_id)
                .or_else(|| self.profiles.first())
                .cloned()
                .ok_or_else(|| "当前没有可用 API，请先导入并选择令牌。".to_string())?;
            self.apply_api_profile(&profile)?;
            self.official_mode = false;
            self.current_profile_id = profile.id;
        }
        self.save()
    }

    pub fn ensure_current_configuration(&self) -> Result<(), String> {
        if self.official_mode {
            self.apply_official_profile(false)
        } else if let Some(profile) = self.find_profile(&self.current_profile_id) {
            self.apply_api_profile(profile)
        } else {
            Ok(())
        }
    }

    fn read_config(&self) -> String {
        fs::read_to_string(self.codex_home.join("config.toml")).unwrap_or_default()
    }

    fn normalize_config(&self, config: &str) -> String {
        let mut value = remove_top_level(&remove_top_level(config, "base_url"), "wire_api");
        if read_top_level(&value, "service_tier").to_lowercase() == "default" {
            value = remove_top_level(&value, "service_tier");
        }
        value
    }

    fn apply_api_profile(&self, profile: &Profile) -> Result<(), String> {
        validate_endpoint(&profile.endpoint_url)?;
        ensure_dir(&self.codex_home)?;
        let auth_path = self.codex_home.join("auth.json");
        let config_path = self.codex_home.join("config.toml");
        let mut config = self.normalize_config(&self.read_config());
        config = upsert_top_level(&config, "model_provider", "\"custom\"");
        config = upsert_top_level(
            &config,
            "model",
            &format!("\"{}\"", escape_toml(&profile.model)),
        );
        config = upsert_top_level(
            &config,
            "model_reasoning_effort",
            &format!("\"{}\"", escape_toml(&profile.reasoning_effort)),
        );
        config = upsert_top_level(&config, "disable_response_storage", "true");
        config = replace_table(
            &config,
            "model_providers.custom",
            &[
                "[model_providers.custom]".to_string(),
                format!("name = \"{}\"", escape_toml(&profile.name)),
                format!(
                    "base_url = \"{}\"",
                    escape_toml(profile.endpoint_url.trim_end_matches('/'))
                ),
                "wire_api = \"responses\"".to_string(),
                "requires_openai_auth = true".to_string(),
                format!(
                    "experimental_bearer_token = \"{}\"",
                    escape_toml(&profile.api_key)
                ),
            ],
        );
        let auth = serde_json::to_vec(&json!({
            "auth_mode": "apikey",
            "OPENAI_API_KEY": profile.api_key
        }))
        .map_err(|error| error.to_string())?;
        apply_pair(&auth_path, Some(&auth), &config_path, config.as_bytes())
    }

    fn apply_official_profile(&self, force_login: bool) -> Result<(), String> {
        ensure_dir(&self.codex_home)?;
        let auth_path = self.codex_home.join("auth.json");
        let config_path = self.codex_home.join("config.toml");
        let mut config = self.normalize_config(&self.read_config());
        config = upsert_top_level(&config, "model_provider", "\"openai\"");
        config = remove_top_level(&config, "experimental_bearer_token");
        config = replace_table(&config, "model_providers.custom", &[]);
        let mut auth = None;
        if !force_login {
            if let Ok(existing) = fs::read(&auth_path) {
                if is_official_auth(&existing) {
                    auth = Some(existing);
                }
            }
            if auth.is_none() && !self.official_auth_base64.is_empty() {
                auth = BASE64.decode(&self.official_auth_base64).ok();
            }
        }
        apply_pair(&auth_path, auth.as_deref(), &config_path, config.as_bytes())
    }

    fn capture_official_auth(&mut self) -> bool {
        let path = self.codex_home.join("auth.json");
        let Ok(bytes) = fs::read(path) else {
            return false;
        };
        if !is_official_auth(&bytes) {
            return false;
        }
        let encoded = BASE64.encode(bytes);
        let changed = encoded != self.official_auth_base64;
        self.official_auth_base64 = encoded;
        changed
    }

    pub fn upsert_managed_profiles(
        &mut self,
        tokens: &[(String, String)],
        endpoint_url: &str,
        replace_all: bool,
    ) -> Result<(), String> {
        let endpoint = validate_endpoint(endpoint_url)?;
        let replacements: Vec<Profile> = tokens
            .iter()
            .filter(|(name, key)| !name.is_empty() && !key.is_empty())
            .map(|(name, key)| Profile {
                id: stable_id("account", name),
                name: name.trim().to_string(),
                source: "CodexLink".to_string(),
                source_id: name.trim().to_string(),
                endpoint_url: endpoint.clone(),
                model: DEFAULT_MODEL.to_string(),
                reasoning_effort: DEFAULT_EFFORT.to_string(),
                api_key: key.trim().to_string(),
            })
            .collect();
        if replacements.len() != TOKEN_TARGETS.len() {
            return Err("没有拿到完整的 9 个 API 密钥，未保存令牌。".to_string());
        }
        if replace_all {
            self.profiles = replacements.clone();
        } else {
            for item in &replacements {
                if let Some(index) = self.profiles.iter().position(|profile| profile.id == item.id) {
                    self.profiles[index] = item.clone();
                } else {
                    self.profiles.push(item.clone());
                }
            }
        }
        let current = self
            .find_profile(&self.current_profile_id)
            .cloned()
            .unwrap_or_else(|| replacements[0].clone());
        if !self.official_mode {
            self.current_profile_id = current.id.clone();
        }
        self.last_api_profile_id = current.id;
        self.save()
    }

    pub fn import_from_cc_switch(&mut self) -> Result<(usize, usize), String> {
        if !self.cc_switch_db_path.is_file() {
            return Ok((0, 0));
        }
        let connection = Connection::open_with_flags(
            &self.cc_switch_db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT id,name,settings_config,COALESCE(meta,'{}') \
                 FROM providers WHERE app_type='codex' ORDER BY sort_index,name",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut imported = 0;
        let mut skipped = 0;
        for row in rows {
            let Ok((id, name, settings, meta)) = row else {
                skipped += 1;
                continue;
            };
            let profile = parse_cc_switch(&id, &name, &settings, &meta).ok();
            let Some(profile) = profile else {
                skipped += 1;
                continue;
            };
            let duplicate = self.profiles.iter().any(|item| {
                item.id == profile.id
                    || (same_endpoint(&item.endpoint_url, &profile.endpoint_url)
                        && (item.api_key == profile.api_key
                            || item.name.eq_ignore_ascii_case(&profile.name)))
            });
            if duplicate {
                skipped += 1;
            } else {
                self.profiles.push(profile);
                imported += 1;
            }
        }
        self.save()?;
        Ok((imported, skipped))
    }
}

pub async fn import_managed_tokens(
    account: &mut AccountState,
    vault: &mut VaultState,
    client: &Client,
    replace_all: bool,
) -> Result<Vec<String>, String> {
    account.ensure_logged_in()?;
    let endpoint = format!("{}/v1", account.base_url.trim_end_matches('/'));
    let mut existing = account.list_all_tokens(client).await?;
    let mut operations = Vec::new();
    for (name, group) in TOKEN_TARGETS {
        let found = existing
            .iter()
            .find(|item| item.get("name").and_then(Value::as_str) == Some(name));
        let mut body = json!({
            "name": name,
            "expired_time": -1,
            "remain_quota": 0,
            "unlimited_quota": true,
            "model_limits_enabled": false,
            "model_limits": "",
            "allow_ips": "",
            "group": group,
            "cross_group_retry": false
        });
        if let Some(item) = found {
            body["id"] = json!(item.get("id").and_then(Value::as_i64).unwrap_or_default());
            account
                .request(client, "/api/token/", Method::PUT, Some(body))
                .await?;
            operations.push(format!("{name}:updated"));
        } else {
            account
                .request(client, "/api/token/", Method::POST, Some(body))
                .await?;
            operations.push(format!("{name}:created"));
        }
    }
    existing = account.list_all_tokens(client).await?;
    let mut ids = Vec::new();
    let mut final_tokens = Vec::new();
    for (name, _) in TOKEN_TARGETS {
        let item = existing
            .iter()
            .find(|token| token.get("name").and_then(Value::as_str) == Some(name))
            .ok_or_else(|| format!("创建后未找到令牌：{name}"))?;
        let id = item.get("id").and_then(Value::as_i64).unwrap_or_default();
        ids.push(id);
        final_tokens.push((id, name.to_string()));
    }
    let keys = match account
        .request(
            client,
            "/api/token/batch/keys",
            Method::POST,
            Some(json!({ "ids": ids })),
        )
        .await
    {
        Ok(key_data) => key_data
            .get("keys")
            .or_else(|| key_data.get("value"))
            .cloned()
            .unwrap_or(key_data),
        Err(error) => {
            operations.push(format!("batch-keys-fallback:{}", public_message(&error)));
            let mut fallback = serde_json::Map::new();
            for id in &ids {
                let data = account.get_token_key(client, *id).await?;
                if let Some(key) = data
                    .get("key")
                    .or_else(|| data.get("token"))
                    .and_then(Value::as_str)
                {
                    fallback.insert(id.to_string(), json!(key));
                }
            }
            Value::Object(fallback)
        }
    };
    let mut tokens = Vec::new();
    for (id, name) in final_tokens {
        let mut key = pick_key(&keys, id, &name);
        if key.is_empty() || matches!(key.as_str(), "sk" | "sk-") {
            return Err("没有拿到完整的 9 个 API 密钥，未保存令牌。".to_string());
        }
        if !key.starts_with("sk-") {
            key = format!("sk-{}", key.trim_start_matches("sk").trim_start_matches('-'));
        }
        tokens.push((name, key));
    }
    vault.upsert_managed_profiles(&tokens, &endpoint, replace_all)?;
    Ok(operations)
}

fn pick_key(keys: &Value, id: i64, name: &str) -> String {
    if let Some(items) = keys.as_array() {
        if let Some(found) = items.iter().find(|item| {
            item.get("id")
                .or_else(|| item.get("token_id"))
                .and_then(Value::as_i64)
                == Some(id)
                || item.get("name").and_then(Value::as_str) == Some(name)
        }) {
            return value_string(found.get("key").or_else(|| found.get("token")));
        }
    }
    if let Some(map) = keys.as_object() {
        if let Some(value) = map
            .get(&id.to_string())
            .or_else(|| map.get(name))
        {
            if value.is_string() {
                return value_string(Some(value));
            }
            return value_string(value.get("key").or_else(|| value.get("token")));
        }
    }
    String::new()
}

fn apply_pair(
    first_path: &Path,
    first_bytes: Option<&[u8]>,
    second_path: &Path,
    second_bytes: &[u8],
) -> Result<(), String> {
    let old_first = fs::read(first_path).ok();
    let old_second = fs::read(second_path).ok();
    let result = (|| {
        if let Some(bytes) = first_bytes {
            atomic_write(first_path, bytes)?;
        } else if first_path.exists() {
            fs::remove_file(first_path).map_err(|error| error.to_string())?;
        }
        atomic_write(second_path, second_bytes)
    })();
    if let Err(error) = result {
        if let Some(bytes) = old_first {
            let _ = atomic_write(first_path, bytes);
        } else {
            let _ = fs::remove_file(first_path);
        }
        if let Some(bytes) = old_second {
            let _ = atomic_write(second_path, bytes);
        } else {
            let _ = fs::remove_file(second_path);
        }
        return Err(error);
    }
    Ok(())
}

fn is_official_auth(bytes: &[u8]) -> bool {
    serde_json::from_slice::<Value>(bytes).ok().is_some_and(|auth| {
        auth.get("auth_mode")
            .and_then(Value::as_str)
            .is_some_and(|mode| mode.eq_ignore_ascii_case("chatgpt"))
            || auth
                .get("tokens")
                .and_then(Value::as_object)
                .is_some_and(|tokens| !tokens.is_empty())
    })
}

fn same_endpoint(left: &str, right: &str) -> bool {
    left.trim_end_matches('/')
        .eq_ignore_ascii_case(right.trim_end_matches('/'))
}

fn parse_cc_switch(
    id: &str,
    name: &str,
    settings_json: &str,
    meta_json: &str,
) -> Result<Profile, String> {
    let settings: Value = serde_json::from_str(settings_json).map_err(|error| error.to_string())?;
    let meta: Value = serde_json::from_str(meta_json).map_err(|error| error.to_string())?;
    let format = settings
        .get("apiFormat")
        .or_else(|| meta.get("apiFormat"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let config = settings.get("config").and_then(Value::as_str).unwrap_or("");
    let responses = format == "openai_responses"
        || regex::Regex::new(r#"(?im)^\s*wire_api\s*=\s*["']responses["']"#)
            .expect("responses regex")
            .is_match(config);
    if !responses || matches!(format.as_str(), "openai_chat" | "anthropic") {
        return Err("不支持的 API 格式。".to_string());
    }
    let endpoint = settings
        .get("base_url")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            let value = read_toml(config, "base_url");
            (!value.is_empty()).then_some(value)
        })
        .or_else(|| meta.get("base_url").and_then(Value::as_str).map(ToOwned::to_owned))
        .ok_or_else(|| "缺少 API 地址。".to_string())?;
    let key = settings
        .get("auth")
        .and_then(|auth| auth.get("OPENAI_API_KEY"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            let value = read_toml(config, "experimental_bearer_token");
            (!value.is_empty()).then_some(value)
        })
        .ok_or_else(|| "缺少 API 密钥。".to_string())?;
    if name.trim().is_empty() {
        return Err("缺少名称。".to_string());
    }
    Ok(Profile {
        id: stable_id("cc-switch", id),
        name: name.trim().to_string(),
        source: "CC Switch".to_string(),
        source_id: id.to_string(),
        endpoint_url: validate_endpoint(&endpoint)?,
        model: {
            let value = read_toml(config, "model");
            if value.is_empty() { DEFAULT_MODEL.to_string() } else { value }
        },
        reasoning_effort: {
            let value = read_toml(config, "model_reasoning_effort");
            if value.is_empty() { DEFAULT_EFFORT.to_string() } else { value }
        },
        api_key: key.trim().to_string(),
    })
}
