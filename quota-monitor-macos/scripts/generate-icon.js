const { app, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");

app.whenReady().then(() => {
  const root = path.resolve(__dirname, "..");
  const source = path.join(root, "build", "icon.ico");
  const target = path.join(root, "build", "icon.png");
  const icon = nativeImage.createFromPath(source);
  if (icon.isEmpty()) {
    throw new Error(`无法读取图标：${source}`);
  }
  const png = icon.resize({ width: 1024, height: 1024, quality: "best" }).toPNG();
  fs.writeFileSync(target, png);
  console.log(target);
  app.quit();
});
