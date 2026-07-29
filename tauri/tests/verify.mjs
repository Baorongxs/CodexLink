import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("frontend/index.html");
const bridge = read("frontend/tauri-bridge.js");
const rust = read("src-tauri/src/lib.rs");
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
assert.match(html, /安装 Apple 芯片版/);
assert.match(html, /安装 Intel 芯片版/);
assert.doesNotMatch(html, /微软商店|winget|install-online|install-offline/i);
assert.match(rust, /persistent\.oaistatic\.com\/codex-app-prod\/Codex\.dmg/);
assert.match(rust, /persistent\.oaistatic\.com\/codex-app-prod\/Codex-latest-x64\.dmg/);
assert.match(rust, /hdiutil/);
assert.match(rust, /ditto/);
assert.match(usageCore, /CONTEXT_UI_ENABLED = false/);
assert.match(usageCore, /__codexLauncherApplyRealtimeContext/);
assert.match(contextBar, /mac-composer-realtime-v3/);
assert.match(contextBar, /width:176px!important/);
assert.match(contextBar, /bottom:12px!important/);
assert.match(contextBar, /alignBelowComposer/);
assert.match(contextBar, /lastRealtimeAt/);

const localOnly = new Set([
  "open-login",
  "open-register",
  "open-support",
  "open-logs",
  "open-install-codex",
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

for (const asset of [
  "frontend/app-logo.png",
  "frontend/support-qr.png",
  "frontend/usage-guide.txt",
  "src-tauri/icons/icon.icns",
]) {
  assert.ok(fs.statSync(path.join(root, asset)).size > 0, `Missing asset: ${asset}`);
}

assert.doesNotMatch(cargo, /electron|chromium|cef/i);
assert.doesNotMatch(bridge, /api[_-]?key\s*[:=]\s*["'][^"']+/i);
console.log(`Static contract OK: ${actions.size - localOnly.size} host actions covered.`);
