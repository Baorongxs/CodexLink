use crate::util::{atomic_write, ensure_dir, home_dir, sha256};
use chrono::Utc;
use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Cursor, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;
use walkdir::WalkDir;
use zip::{write::FileOptions, CompressionMethod, ZipArchive, ZipWriter};

const ALLOWED_FILES: [&str; 3] = ["state_5.sqlite", ".codex-global-state.json", "session_index.jsonl"];
const ALLOWED_DIRS: [&str; 2] = ["sessions", "archived_sessions"];

#[derive(Debug, Clone)]
pub struct ConversationService {
    pub codex_home: PathBuf,
    pub backup_root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    path: String,
    length: usize,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format_version: u32,
    excludes_auth: bool,
    platform: String,
    created_at_utc: String,
    files: Vec<ManifestFile>,
}

impl ConversationService {
    pub fn new() -> Result<Self, String> {
        let codex_home = home_dir()?.join(".codex");
        let backup_root = codex_home.join("backups").join("codexlink-conversations");
        Ok(Self {
            codex_home,
            backup_root,
        })
    }

    fn list_source_files(&self) -> Vec<(PathBuf, String)> {
        let mut files = Vec::new();
        for name in ALLOWED_FILES {
            let path = self.codex_home.join(name);
            if is_regular_file(&path) {
                files.push((path, name.to_string()));
            }
        }
        for directory in ALLOWED_DIRS {
            let root = self.codex_home.join(directory);
            if !root.is_dir() {
                continue;
            }
            for entry in WalkDir::new(&root).follow_links(false).into_iter().filter_map(Result::ok) {
                if entry.file_type().is_file() {
                    if let Ok(relative) = entry.path().strip_prefix(&root) {
                        files.push((
                            entry.path().to_path_buf(),
                            format!("{directory}/{}", relative.to_string_lossy().replace('\\', "/")),
                        ));
                    }
                }
            }
        }
        files
    }

    pub fn create_backup<F>(&self, prefix: &str, mut progress: F) -> Result<Value, String>
    where
        F: FnMut(u32, &str),
    {
        ensure_dir(&self.backup_root)?;
        let sources = self.list_source_files();
        if sources.is_empty() {
            return Err("没有找到可备份的 Codex 对话数据。".to_string());
        }
        progress(15, "正在扫描本地对话…");
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options = FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o600);
        let mut manifest = Manifest {
            format_version: 1,
            excludes_auth: true,
            platform: "darwin".to_string(),
            created_at_utc: Utc::now().to_rfc3339(),
            files: Vec::new(),
        };
        for (index, (path, relative)) in sources.iter().enumerate() {
            let bytes = fs::read(path).map_err(|error| error.to_string())?;
            writer
                .start_file(relative, options)
                .map_err(|error| error.to_string())?;
            writer.write_all(&bytes).map_err(|error| error.to_string())?;
            manifest.files.push(ManifestFile {
                path: relative.clone(),
                length: bytes.len(),
                sha256: sha256(&bytes),
            });
            let percent = 15 + (((index + 1) as f64 / sources.len() as f64) * 65.0).round() as u32;
            progress(percent, relative);
        }
        writer
            .start_file("manifest.json", options)
            .map_err(|error| error.to_string())?;
        writer
            .write_all(
                serde_json::to_string_pretty(&manifest)
                    .map_err(|error| error.to_string())?
                    .as_bytes(),
            )
            .map_err(|error| error.to_string())?;
        let bytes = writer
            .finish()
            .map_err(|error| error.to_string())?
            .into_inner();
        let stamp = Utc::now().format("%Y%m%dT%H%M%SZ");
        let output = self.backup_root.join(format!(
            "{prefix}-{stamp}-{}.zip",
            &Uuid::new_v4().to_string()[..8]
        ));
        atomic_write(&output, &bytes)?;
        progress(100, output.file_name().and_then(|name| name.to_str()).unwrap_or(""));
        Ok(json!({
            "path": output,
            "fileCount": sources.len(),
            "size": bytes.len()
        }))
    }

    fn get_backups(&self) -> Result<Vec<PathBuf>, String> {
        ensure_dir(&self.backup_root)?;
        let matcher = Regex::new(
            r"(?i)^codexlink-conversations-\d{8}T\d{6}Z-[a-f0-9-]+\.zip$",
        )
        .expect("backup regex");
        let mut backups: Vec<PathBuf> = fs::read_dir(&self.backup_root)
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| matcher.is_match(name))
                    && is_regular_file(path)
            })
            .collect();
        backups.sort_by_key(|path| {
            std::cmp::Reverse(
                fs::metadata(path)
                    .and_then(|metadata| metadata.modified())
                    .ok(),
            )
        });
        Ok(backups)
    }

    pub fn restore_latest<F>(&self, mut progress: F) -> Result<Value, String>
    where
        F: FnMut(u32, &str),
    {
        let backup = self
            .get_backups()?
            .into_iter()
            .next()
            .ok_or_else(|| "没有找到可恢复的对话备份。".to_string())?;
        progress(5, "正在验证备份…");
        let (manifest, payloads) = validate_backup(&backup)?;
        let safety_backup = if self.list_source_files().is_empty() {
            String::new()
        } else {
            self.create_backup("codexlink-safety-before-restore", |_, _| {})?
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let mut restored = 0usize;
        let mut skipped = 0usize;
        for (index, item) in manifest.files.iter().enumerate() {
            let bytes = payloads
                .get(&item.path)
                .ok_or_else(|| format!("备份缺少文件：{}", item.path))?;
            let target = safe_target(&self.codex_home, &item.path)?;
            if let Some(parent) = target.parent() {
                ensure_dir(parent)?;
            }
            if item.path == "state_5.sqlite" && target.exists() {
                restored += merge_state_database(&target, bytes)?;
            } else if !target.exists() {
                atomic_write(&target, bytes)?;
                restored += 1;
            } else if matches!(item.path.as_str(), ".codex-global-state.json" | "session_index.jsonl") {
                restored += merge_text_metadata(&target, bytes, &item.path)?;
            } else {
                skipped += 1;
            }
            let percent = 10
                + (((index + 1) as f64 / manifest.files.len() as f64) * 85.0).round() as u32;
            progress(percent, &item.path);
        }
        progress(100, "恢复完成");
        Ok(json!({
            "backup": backup,
            "safetyBackup": safety_backup,
            "restored": restored,
            "skipped": skipped
        }))
    }

    pub fn repair_sidebar(&self) -> Result<Value, String> {
        let database = self.codex_home.join("state_5.sqlite");
        if !database.is_file() {
            return Err("未找到 Codex 对话数据库。".to_string());
        }
        let connection = Connection::open(&database).map_err(|error| error.to_string())?;
        let table_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !table_exists {
            return Err("当前 Codex 数据库缺少 threads 表。".to_string());
        }
        let mut statement = connection
            .prepare("PRAGMA table_info(threads)")
            .map_err(|error| error.to_string())?;
        let columns: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .collect();
        let archived = columns
            .into_iter()
            .find(|column| matches!(column.to_lowercase().as_str(), "archived" | "is_archived"));
        let changed = if let Some(column) = archived {
            let quoted = quote_identifier(&column);
            connection
                .execute(
                    &format!("UPDATE threads SET {quoted}=0 WHERE {quoted} IS NOT 0"),
                    [],
                )
                .map_err(|error| error.to_string())?
        } else {
            0
        };
        Ok(json!({ "changed": changed }))
    }

    pub fn read_context(&self, thread_id: &str) -> Value {
        let normalized = normalize_thread_id(thread_id);
        let mut candidates = Vec::new();
        for directory in ALLOWED_DIRS {
            let root = self.codex_home.join(directory);
            if !root.is_dir() {
                continue;
            }
            candidates.extend(WalkDir::new(&root)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry.file_type().is_file()
                        && entry.path().extension().is_some_and(|extension| extension == "jsonl")
                        && entry
                            .file_name()
                            .to_string_lossy()
                            .to_lowercase()
                            .contains(&normalized)
                })
                .map(|entry| entry.into_path()));
        }
        if candidates.is_empty() && !normalized.is_empty() {
            return self.read_context("");
        }
        candidates.sort_by_key(|path| {
            std::cmp::Reverse(
                fs::metadata(path)
                    .and_then(|metadata| metadata.modified())
                    .ok(),
            )
        });
        for path in candidates {
            if let Some((used, limit)) = read_context_tail(&path) {
                return json!({
                    "ok": true,
                    "available": true,
                    "threadId": thread_id,
                    "usedTokens": used,
                    "contextWindow": limit
                });
            }
        }
        json!({ "ok": true, "available": false })
    }

    pub fn delete_thread(&self, thread_id: &str) -> Result<Value, String> {
        let normalized = normalize_thread_id(thread_id);
        if normalized.is_empty() {
            return Ok(json!({ "ok": false, "error": "thread_missing" }));
        }
        let mut removed = 0usize;
        for directory in ALLOWED_DIRS {
            let root = self.codex_home.join(directory);
            if !root.is_dir() {
                continue;
            }
            let files: Vec<PathBuf> = WalkDir::new(&root)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry.file_type().is_file()
                        && entry
                            .file_name()
                            .to_string_lossy()
                            .to_lowercase()
                            .contains(&normalized)
                })
                .map(|entry| entry.into_path())
                .collect();
            for file in files {
                fs::remove_file(file).map_err(|error| error.to_string())?;
                removed += 1;
            }
        }
        let index = self.codex_home.join("session_index.jsonl");
        if index.is_file() {
            let text = fs::read_to_string(&index).map_err(|error| error.to_string())?;
            let before: Vec<&str> = text.lines().collect();
            let after: Vec<&str> = before
                .iter()
                .copied()
                .filter(|line| !line.to_lowercase().contains(&normalized))
                .collect();
            if after.len() != before.len() {
                atomic_write(&index, format!("{}\n", after.join("\n")))?;
                removed += before.len() - after.len();
            }
        }
        Ok(json!({ "ok": removed > 0, "removed": removed }))
    }
}

fn validate_backup(path: &Path) -> Result<(Manifest, BTreeMap<String, Vec<u8>>), String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    let manifest: Manifest = {
        let mut entry = archive
            .by_name("manifest.json")
            .map_err(|_| "备份缺少 manifest.json。".to_string())?;
        let mut text = String::new();
        entry.read_to_string(&mut text).map_err(|error| error.to_string())?;
        serde_json::from_str(&text).map_err(|error| error.to_string())?
    };
    if manifest.format_version != 1 || !manifest.excludes_auth {
        return Err("备份格式无效。".to_string());
    }
    let mut payloads = BTreeMap::new();
    for item in &manifest.files {
        if !is_allowed_relative(&item.path) {
            return Err("备份包含不允许的路径。".to_string());
        }
        let mut entry = archive
            .by_name(&item.path)
            .map_err(|_| format!("备份缺少文件：{}", item.path))?;
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        if bytes.len() != item.length || sha256(&bytes) != item.sha256 {
            return Err(format!("备份校验失败：{}", item.path));
        }
        payloads.insert(item.path.clone(), bytes);
    }
    Ok((manifest, payloads))
}

fn merge_state_database(live_path: &Path, backup_bytes: &[u8]) -> Result<usize, String> {
    let temp = live_path.with_extension(format!("backup-{}.sqlite", Uuid::new_v4()));
    atomic_write(&temp, backup_bytes)?;
    let result = (|| {
        let connection = Connection::open(live_path).map_err(|error| error.to_string())?;
        connection
            .execute("ATTACH DATABASE ?1 AS backupdb", params![temp.to_string_lossy()])
            .map_err(|error| error.to_string())?;
        let live_tables = table_names(&connection, "main")?;
        let backup_tables = table_names(&connection, "backupdb")?;
        let mut changed = 0usize;
        for table in backup_tables
            .into_iter()
            .filter(|name| live_tables.contains(name) && !name.starts_with("sqlite_"))
        {
            let quoted = quote_identifier(&table);
            let live_columns = table_columns(&connection, "main", &table)?;
            let backup_columns: HashSet<String> =
                table_columns(&connection, "backupdb", &table)?.into_iter().collect();
            let columns: Vec<String> = live_columns
                .into_iter()
                .filter(|column| backup_columns.contains(column))
                .collect();
            if columns.is_empty() {
                continue;
            }
            let column_sql = columns
                .iter()
                .map(|column| quote_identifier(column))
                .collect::<Vec<_>>()
                .join(",");
            changed += connection
                .execute(
                    &format!(
                        "INSERT OR IGNORE INTO main.{quoted} ({column_sql}) \
                         SELECT {column_sql} FROM backupdb.{quoted}"
                    ),
                    [],
                )
                .map_err(|error| error.to_string())?;
        }
        connection
            .execute("DETACH DATABASE backupdb", [])
            .map_err(|error| error.to_string())?;
        Ok(changed)
    })();
    let _ = fs::remove_file(temp);
    result
}

fn table_names(connection: &Connection, schema: &str) -> Result<HashSet<String>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT name FROM {schema}.sqlite_master WHERE type='table'"
        ))
        .map_err(|error| error.to_string())?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(names)
}

fn table_columns(
    connection: &Connection,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(&format!(
            "PRAGMA {schema}.table_info({})",
            quote_identifier(table)
        ))
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(columns)
}

fn merge_text_metadata(target: &Path, backup_bytes: &[u8], name: &str) -> Result<usize, String> {
    let backup = String::from_utf8_lossy(backup_bytes);
    let live = fs::read_to_string(target).map_err(|error| error.to_string())?;
    if name == "session_index.jsonl" {
        let existing: HashSet<&str> = live.lines().filter(|line| !line.is_empty()).collect();
        let additions: Vec<&str> = backup
            .lines()
            .filter(|line| !line.is_empty() && !existing.contains(line))
            .collect();
        if !additions.is_empty() {
            atomic_write(
                target,
                format!("{}\n{}\n", live.trim_end(), additions.join("\n")),
            )?;
        }
        return Ok(additions.len());
    }
    let mut live_json: Value = match serde_json::from_str(&live) {
        Ok(value) => value,
        Err(_) => return Ok(0),
    };
    let backup_json: Value = match serde_json::from_str(&backup) {
        Ok(value) => value,
        Err(_) => return Ok(0),
    };
    let (Some(live_map), Some(backup_map)) = (live_json.as_object_mut(), backup_json.as_object())
    else {
        return Ok(0);
    };
    let mut changed = 0usize;
    for (key, value) in backup_map {
        if !live_map.contains_key(key) {
            live_map.insert(key.clone(), value.clone());
            changed += 1;
        } else if let (Some(live_nested), Some(backup_nested)) = (
            live_map.get_mut(key).and_then(Value::as_object_mut),
            value.as_object(),
        ) {
            for (nested_key, nested_value) in backup_nested {
                if !live_nested.contains_key(nested_key) {
                    live_nested.insert(nested_key.clone(), nested_value.clone());
                    changed += 1;
                }
            }
        }
    }
    if changed > 0 {
        atomic_write(
            target,
            format!("{}\n", serde_json::to_string(&live_json).map_err(|error| error.to_string())?),
        )?;
    }
    Ok(changed)
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

fn is_allowed_relative(relative: &str) -> bool {
    let normalized = relative.replace('\\', "/");
    ALLOWED_FILES.contains(&normalized.as_str())
        || ALLOWED_DIRS
            .iter()
            .any(|directory| normalized.starts_with(&format!("{directory}/")))
}

fn safe_target(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if !is_allowed_relative(relative) {
        return Err("恢复路径不在允许范围内。".to_string());
    }
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return Err("恢复路径越界。".to_string());
    }
    Ok(root.join(relative_path))
}

fn normalize_thread_id(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|character| character.is_ascii_hexdigit() || *character == '-')
        .collect()
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn value_u64(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Number(number)) => number.as_u64().unwrap_or_default(),
        Some(Value::String(text)) => text.parse().unwrap_or_default(),
        _ => 0,
    }
}

fn read_context_tail(path: &Path) -> Option<(u64, u64)> {
    const TAIL_BYTES: u64 = 1024 * 1024;
    let mut file = fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let start = length.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut text = String::new();
    file.read_to_string(&mut text).ok()?;
    let mut lines = text.lines();
    if start > 0 {
        lines.next();
    }
    lines.filter_map(parse_context_line).last()
}

fn parse_context_line(line: &str) -> Option<(u64, u64)> {
    let data = serde_json::from_str::<Value>(line).ok()?;
    let payload = data.get("payload").unwrap_or(&data);
    if payload.get("type").and_then(Value::as_str) == Some("token_count") {
        let info = payload.get("info")?;
        let usage = info
            .get("last_token_usage")
            .or_else(|| info.get("total_token_usage"))?;
        let used = value_u64(
            usage
                .get("total_tokens")
                .or_else(|| usage.get("total")),
        );
        let limit = value_u64(
            info.get("model_context_window")
                .or_else(|| info.get("context_window")),
        );
        return (limit > 0).then_some((used, limit));
    }
    let usage = payload
        .get("token_usage")
        .or_else(|| data.get("token_usage"))
        .or_else(|| data.get("usage"))?;
    let used = value_u64(
        usage
            .get("total_tokens")
            .or_else(|| usage.get("total")),
    );
    let limit = value_u64(
        usage
            .get("model_context_window")
            .or_else(|| usage.get("context_window")),
    );
    (limit > 0).then_some((used, limit))
}

#[cfg(test)]
mod context_tests {
    use super::parse_context_line;

    #[test]
    fn parses_current_token_count_records() {
        let line = r#"{"payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":24576},"model_context_window":258400}}}"#;
        assert_eq!(parse_context_line(line), Some((24576, 258400)));
    }

    #[test]
    fn keeps_legacy_context_records_compatible() {
        let line = r#"{"payload":{"token_usage":{"total_tokens":1024,"model_context_window":200000}}}"#;
        assert_eq!(parse_context_line(line), Some((1024, 200000)));
    }

    #[test]
    fn ignores_non_usage_records() {
        assert_eq!(parse_context_line(r#"{"payload":{"type":"message"}}"#), None);
    }
}
