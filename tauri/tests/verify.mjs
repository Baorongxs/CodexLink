import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("frontend/index.html");
const bridge = read("frontend/tauri-bridge.js");
const rust = read("src-tauri/src/lib.rs");
const cdp = read("src-tauri/src/cdp.rs");
const cargo = read("src-tauri/Cargo.toml");
const usageCore = read("frontend/inject/usage-core.js");
const contextBar = read("frontend/inject/context-bar.js");
const config = JSON.parse(read("src-tauri/tauri.conf.json"));

assert.match(html, /<script src="tauri-bridge\.js"><\/script>/);
assert.match(bridge, /window\.chrome\.webview/);
assert.match(bridge, /invoke\(['"]handle_action['"]/);
assert.equal(config.app.withGlobalTauri, true);
assert.equal(config.bundle.macOS.minimumSystemVersion, "14.0");
assert.deepEqual(config.bundle.targets, ["app", "dmg"]);
assert.equal(config.app.windows[0].decorations, true);
assert.equal(config.app.windows[0].titleBarStyle, "Overlay");
assert.equal(config.app.windows[0].hiddenTitle, true);
assert.match(html, /下载 Apple 芯片版/);
assert.match(html, /下载 Intel 芯片版/);
assert.match(html, /下载到“下载”文件夹/);
assert.doesNotMatch(html, /winget|install-online|install-offline/i);
assert.match(rust, /persistent\.oaistatic\.com\/codex-app-prod\/Codex\.dmg/);
assert.match(rust, /persistent\.oaistatic\.com\/codex-app-prod\/Codex-latest-x64\.dmg/);
assert.match(rust, /dirs::download_dir/);
assert.match(rust, /available_download_path/);
assert.match(rust, /Command::new\("\/usr\/bin\/open"\)/);
assert.match(rust, /\.arg\("-R"\)/);
assert.doesNotMatch(rust, /hdiutil|ditto|install_app_bundle|find_app_bundle/);
assert.match(cdp, /Command::new\("\/usr\/bin\/open"\)/);
assert.match(cdp, /"-a"\.to_string\(\)/);
assert.doesNotMatch(cdp, /"-F"\.to_string\(\)|"-na"\.to_string\(\)|"-n"\.to_string\(\)/);
assert.doesNotMatch(cdp, /join\("Contents"\).*join\("MacOS"\)/);
assert.match(cdp, /--remote-allow-origins=\*/);
assert.match(cdp, /parse_bundle_process_ids/);
assert.match(cdp, /signal_bundle_processes/);
assert.match(cdp, /TcpListener::bind/);
assert.match(cdp, /data:text\/html/);
assert.match(cdp, /\["\/json\/list", "\/json"\]/);
assert.match(cdp, /"page" \| "webview" \| "other"/);
assert.match(usageCore, /CONTEXT_UI_ENABLED = false/);
assert.match(usageCore, /__codexLauncherApplyRealtimeContext/);
assert.match(contextBar, /mac-composer-realtime-v3/);
assert.match(contextBar, /width:176px!important/);
assert.match(contextBar, /bottom:12px!important/);
assert.match(contextBar, /alignBelowComposer/);
assert.match(contextBar, /lastRealtimeAt/);
assert.match(rust, /if !already_stopped/);
assert.match(rust, /start_codex_action\(app, state, payload, true, true\)/);

const localOnly = new Set([
  "open-login",
  "open-register",
  "open-support",
  "open-logs",
  "open-install-codex",
  "open-usage-guide",
]);
const actions = new Set([
  ...[...html.matchAll(/send\(['"]([^'"]+)/g)]
    .map((match) => match[1])
    .filter((value) => !value.endsWith("-")),
  ...[...html.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]),
  "drag-window",
  "window-minimize",
  "window-maximize",
  "window-close",
]);
for (const action of [...actions].filter((value) => !localOnly.has(value))) {
  assert.ok(
    rust.includes(`"${action}"`),
    `Rust command dispatcher is missing frontend action: ${action}`,
  );
}

for (const tutorialToken of [
  "使用教程",
  "usage-guide-backdrop",
  "CodexLink 使用教程",
  "CodexLink 是一款简易高效的 Codex 启动工具",
  "详细使用步骤",
  "功能补充说明",
  "即可直接使用 Codex。",
  "if (action === 'open-usage-guide') { openModal('usage-guide'); return; }",
]) {
  assert.ok(html.includes(tutorialToken), `Missing built-in tutorial token: ${tutorialToken}`);
}
assert.doesNotMatch(rust, /"open-usage-guide"|usage-guide\.txt|CodexLink macOS 使用说明/);
assert.match(rust, /OFFICIAL_DOWNLOAD_URL: &str = "https:\/\/studio\.baorongxs\.top"/);
assert.match(rust, /official_download_url\(\)/);
assert.doesNotMatch(rust, /browser_download_url/);
assert.match(html, /前往官网下载/);

const account = read("src-tauri/src/account.rs");
for (const token of [
  'data.get("user")',
  'access_token',
  'Authorization',
  'Bearer',
  '/api/user/auth/refresh',
  'X-Auth-Session',
  'Accept-Language',
  'codexlink_ts',
  'no-cache, no-store',
  'Origin',
  'Referer',
  'page_size=100',
  'get_token_key',
  '/api/token/{id}/key',
]) {
  assert.ok(account.includes(token), `Missing New API auth compatibility token: ${token}`);
}

for (const asset of [
  "frontend/app-logo.png",
  "frontend/support-qr.png",
  "src-tauri/icons/icon.icns",
]) {
  assert.ok(fs.statSync(path.join(root, asset)).size > 0, `Missing asset: ${asset}`);
}
assert.equal(fs.existsSync(path.join(root, "frontend/usage-guide.txt")), false);

assert.doesNotMatch(cargo, /electron|chromium|cef/i);
assert.doesNotMatch(bridge, /api[_-]?key\s*[:=]\s*["'][^"']+/i);
console.log(`Static contract OK: ${actions.size - localOnly.size} host actions covered.`);
