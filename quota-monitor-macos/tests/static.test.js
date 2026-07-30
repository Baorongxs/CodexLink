const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const yaml = require("js-yaml");

const root = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

const pkg = JSON.parse(read("package.json"));
const main = read("main.js");
const preload = read("preload.js");
const renderer = read(path.join("renderer", "index.html"));
const entitlements = read(path.join("build", "entitlements.mac.plist"));

assert.strictEqual(pkg.version, "3.0.0");
assert.strictEqual(pkg.devDependencies["@electron/packager"], "18.4.4");
assert.strictEqual(pkg.build.mac.minimumSystemVersion, "12.0");
assert.strictEqual(pkg.build.mac.hardenedRuntime, true);
assert.strictEqual(pkg.build.mac.notarize, true);
assert.deepStrictEqual(
  pkg.build.mac.target.map((item) => item.target),
  ["dmg", "zip"]
);
assert(
  pkg.build.mac.target.every(
    (item) => item.arch.length === 1 && item.arch[0] === "universal"
  )
);

assert(main.includes('const IS_MAC = process.platform === "darwin"'));
assert(main.includes("buildApplicationMenu()"));
assert(main.includes('mainWindow.setVisibleOnAllWorkspaces(true'));
assert(main.includes('const windowLevel = IS_MAC ? "floating" : "screen-saver"'));
assert(main.includes("codexHomePath()"));
assert(main.includes('"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"'));
assert(main.includes('app.on("activate"'));
assert(main.includes("app.requestSingleInstanceLock()"));

assert(preload.includes("onAppCommand"));
assert(renderer.includes('role="button"'));
assert(renderer.includes('aria-pressed="false"'));
assert(renderer.includes("@media (prefers-reduced-motion: reduce)"));
assert(renderer.includes("window.codexMonitor.onAppCommand"));

assert(entitlements.includes("com.apple.security.cs.allow-jit"));
assert(!entitlements.includes("com.apple.security.app-sandbox"));
assert(fs.existsSync(path.join(root, "build", "icon.png")));
assert(fs.existsSync(path.join(root, "scripts", "build-dmg-ci.sh")));
assert(
  fs.existsSync(
    path.join(root, ".github", "workflows", "build-quota-monitor-macos-v3.yml")
  )
);
const workflow = yaml.load(
  read(path.join(".github", "workflows", "build-quota-monitor-macos-v3.yml"))
);
assert(workflow.jobs?.build);
assert(workflow.jobs?.collect);

for (const relativePath of ["main.js", "preload.js", "scripts/generate-icon.js"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, relativePath)], {
    encoding: "utf8"
  });
  assert.strictEqual(
    result.status,
    0,
    `${relativePath} 语法检查失败：${result.stderr || result.stdout}`
  );
}

console.log("macOS 移植静态验收通过");
