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
const config = JSON.parse(read("src-tauri/tauri.conf.json"));

assert.match(html, /<script src="tauri-bridge\.js"><\/script>/);
assert.match(bridge, /window\.chrome\.webview/);
assert.match(bridge, /invoke\(['"]handle_action['"]/);
assert.equal(config.app.withGlobalTauri, true);
assert.equal(config.bundle.macOS.minimumSystemVersion, "14.0");
assert.deepEqual(config.bundle.targets, ["app", "dmg"]);

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
