const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const root = path.resolve(__dirname, "..");
  const source = path.join(root, "resources", "icon.svg");
  const destination = path.join(root, "resources", "icon.png");
  const window = new BrowserWindow({
    show: false,
    width: 512,
    height: 512,
    useContentSize: true,
    frame: false,
    backgroundColor: "#22201e",
  });
  const svg = fs.readFileSync(source, "utf8");
  const document = `<!doctype html><style>html,body{margin:0;width:512px;height:512px;overflow:hidden}svg{display:block;width:512px;height:512px}</style>${svg}`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`);
  await window.webContents.executeJavaScript("document.fonts.ready");
  window.showInactive();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.writeFileSync(destination, image.toPNG());
  window.destroy();
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
