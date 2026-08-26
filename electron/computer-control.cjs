const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const MAX_READ_BYTES = 240000;
const MAX_LIST_ITEMS = 250;
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".html", ".htm",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".css", ".scss", ".py", ".r", ".sql", ".yaml",
  ".yml", ".toml", ".ini", ".cfg", ".log", ".tex", ".bib", ".ps1", ".bat", ".cmd",
]);
const SENSITIVE_SEGMENTS = new Set([".ssh", ".aws", ".azure", ".gnupg", "credentials", "credential", "cookies", "login data"]);
const SENSITIVE_EXTENSIONS = new Set([".pem", ".pfx", ".p12", ".key", ".kdbx"]);

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realPathForScope(target, allowMissing) {
  if (fs.existsSync(target)) return fs.realpathSync.native(target);
  if (!allowMissing) return target;
  let parent = path.dirname(target);
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const realParent = fs.realpathSync.native(parent);
  return path.resolve(realParent, path.relative(parent, target));
}

function resolveScopedPath(root, input, { allowMissing = false } = {}) {
  const base = path.resolve(root);
  const target = path.resolve(path.isAbsolute(String(input || "")) ? String(input) : path.join(base, String(input || ".")));
  if (!inside(base, target)) throw new Error("路径超出已授权的用户目录");
  const realBase = fs.realpathSync.native(base);
  const realTarget = realPathForScope(target, allowMissing);
  if (!inside(realBase, realTarget)) throw new Error("路径通过链接或联接点超出已授权的用户目录");
  const parts = target.toLowerCase().split(/[\\/]+/);
  if (parts.some((part) => SENSITIVE_SEGMENTS.has(part)) || SENSITIVE_EXTENSIONS.has(path.extname(target).toLowerCase())) {
    throw new Error("该路径可能包含凭据或密钥，Anru 不允许访问");
  }
  if (!allowMissing && !fs.existsSync(target)) throw new Error("路径不存在");
  return target;
}

function encodedPowerShell(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}

async function runPowerShell(script, timeout = 12000) {
  const { stdout, stderr } = await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedPowerShell(script),
  ], { timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
  if (stderr && !stdout) throw new Error(String(stderr).trim().slice(0, 1200));
  return String(stdout || "").trim();
}

function compactEntry(entry) {
  return {
    name: entry.name,
    kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
  };
}

class ComputerControl {
  constructor({ root, shell, clipboard, captureScreen, requestApproval, onLog } = {}) {
    this.root = path.resolve(root);
    this.shell = shell;
    this.clipboard = clipboard;
    this.captureScreen = captureScreen;
    this.requestApproval = requestApproval || (async () => false);
    this.onLog = onLog || (() => {});
  }

  scope() {
    return { root: this.root, policy: "user-directory; credentials blocked; mutations require approval" };
  }

  async listWindows() {
    const script = [
      "$items = Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First 80 Id,ProcessName,MainWindowTitle",
      "$items | ConvertTo-Json -Compress",
    ].join("\n");
    const raw = await runPowerShell(script);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  async screenshot() {
    if (!this.captureScreen) throw new Error("当前运行时不支持屏幕捕获");
    const image = await this.captureScreen();
    this.onLog("computer", `screen captured ${image.width}x${image.height}`);
    return image;
  }

  async list(input = ".") {
    const target = resolveScopedPath(this.root, input);
    if (!fs.statSync(target).isDirectory()) throw new Error("目标不是文件夹");
    const entries = fs.readdirSync(target, { withFileTypes: true }).slice(0, MAX_LIST_ITEMS).map(compactEntry);
    return { path: target, entries, truncated: fs.readdirSync(target).length > MAX_LIST_ITEMS };
  }

  async read(input) {
    const target = resolveScopedPath(this.root, input);
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new Error("目标不是文件");
    if (!TEXT_EXTENSIONS.has(path.extname(target).toLowerCase())) throw new Error("只允许读取常见文本或代码文件");
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES));
    const handle = fs.openSync(target, "r");
    try { fs.readSync(handle, buffer, 0, buffer.length, 0); } finally { fs.closeSync(handle); }
    return { path: target, size: stat.size, truncated: stat.size > buffer.length, text: buffer.toString("utf8").replace(/\0/g, "") };
  }

  async search(input, pattern) {
    const root = resolveScopedPath(this.root, input || ".");
    const term = String(pattern || "").trim().toLowerCase();
    if (!term) throw new Error("搜索词不能为空");
    const matches = [];
    const walk = (directory, depth) => {
      if (depth > 6 || matches.length >= 120) return;
      let entries = [];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (matches.length >= 120) break;
        if (SENSITIVE_SEGMENTS.has(entry.name.toLowerCase())) continue;
        const full = path.join(directory, entry.name);
        if (entry.name.toLowerCase().includes(term)) matches.push({ path: full, kind: entry.isDirectory() ? "directory" : "file" });
        if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full, depth + 1);
      }
    };
    walk(root, 0);
    return { root, pattern: term, matches, truncated: matches.length >= 120 };
  }

  async approve(tool, summary) {
    const approved = await this.requestApproval({ tool, summary: String(summary).slice(0, 600) });
    if (!approved) throw new Error("用户拒绝或未及时批准电脑操作");
  }

  async click(x, y, button = "left") {
    const px = Math.max(0, Math.round(Number(x)));
    const py = Math.max(0, Math.round(Number(y)));
    const choice = button === "right" ? "right" : "left";
    await this.approve("desktop_click", `${choice} click at (${px}, ${py})`);
    const down = choice === "right" ? "0x0008" : "0x0002";
    const up = choice === "right" ? "0x0010" : "0x0004";
    await runPowerShell(`Add-Type @'\nusing System.Runtime.InteropServices; public static class AnruMouse { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,System.UIntPtr e); }\n'@\n[AnruMouse]::SetCursorPos(${px},${py}) | Out-Null\n[AnruMouse]::mouse_event(${down},0,0,0,[UIntPtr]::Zero)\n[AnruMouse]::mouse_event(${up},0,0,0,[UIntPtr]::Zero)`);
    this.onLog("computer", `${choice} click ${px},${py}`);
    return { ok: true, x: px, y: py, button: choice };
  }

  async type(text) {
    const value = String(text || "").slice(0, 8000);
    if (!value) throw new Error("输入文本不能为空");
    await this.approve("desktop_type", `Type ${value.length} characters: ${value.slice(0, 180)}`);
    const previous = this.clipboard?.readText?.() || "";
    this.clipboard?.writeText?.(value);
    try {
      await runPowerShell("Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 120; [System.Windows.Forms.SendKeys]::SendWait('^v')");
    } finally {
      setTimeout(() => this.clipboard?.writeText?.(previous), 350);
    }
    this.onLog("computer", `typed ${value.length} characters`);
    return { ok: true, characters: value.length };
  }

  async press(keys) {
    const normalized = String(keys || "").trim().toUpperCase();
    const map = {
      ENTER: "{ENTER}", ESC: "{ESC}", TAB: "{TAB}", "SHIFT+TAB": "+{TAB}",
      "CTRL+A": "^a", "CTRL+C": "^c", "CTRL+V": "^v", "CTRL+F": "^f", "CTRL+L": "^l", "CTRL+S": "^s",
      "ALT+TAB": "%{TAB}", UP: "{UP}", DOWN: "{DOWN}", LEFT: "{LEFT}", RIGHT: "{RIGHT}",
      PAGEUP: "{PGUP}", PAGEDOWN: "{PGDN}", HOME: "{HOME}", END: "{END}", DELETE: "{DELETE}", BACKSPACE: "{BACKSPACE}",
    };
    if (!map[normalized]) throw new Error("不支持的按键组合");
    await this.approve("desktop_keys", `Press ${normalized}`);
    const escaped = map[normalized].replaceAll("'", "''");
    await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`);
    this.onLog("computer", `pressed ${normalized}`);
    return { ok: true, keys: normalized };
  }

  async open(target) {
    const raw = String(target || "").trim();
    if (!raw) throw new Error("目标不能为空");
    await this.approve("computer_open", `Open ${raw.slice(0, 500)}`);
    if (/^https?:\/\//i.test(raw)) {
      await this.shell.openExternal(new URL(raw).toString());
      return { ok: true, target: raw, kind: "url" };
    }
    const local = resolveScopedPath(this.root, raw);
    const error = await this.shell.openPath(local);
    if (error) throw new Error(error);
    return { ok: true, target: local, kind: "local" };
  }

  async write(input, content, overwrite = false) {
    const target = resolveScopedPath(this.root, input, { allowMissing: true });
    if (fs.existsSync(target) && !overwrite) throw new Error("文件已存在；需要明确设置 overwrite=true");
    const value = String(content || "");
    if (Buffer.byteLength(value, "utf8") > MAX_READ_BYTES) throw new Error("单次写入不能超过 240 KB");
    await this.approve("file_write", `${fs.existsSync(target) ? "Overwrite" : "Create"} ${target} (${value.length} characters)`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value, "utf8");
    this.onLog("computer", `wrote ${target}`);
    return { ok: true, path: target, bytes: Buffer.byteLength(value, "utf8") };
  }

  async mkdir(input) {
    const target = resolveScopedPath(this.root, input, { allowMissing: true });
    await this.approve("folder_create", `Create folder ${target}`);
    fs.mkdirSync(target, { recursive: true });
    return { ok: true, path: target };
  }

  async move(from, to) {
    const source = resolveScopedPath(this.root, from);
    const target = resolveScopedPath(this.root, to, { allowMissing: true });
    if (fs.existsSync(target)) throw new Error("目标路径已存在");
    await this.approve("file_move", `Move ${source} to ${target}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
    return { ok: true, from: source, to: target };
  }

  async trash(input) {
    const target = resolveScopedPath(this.root, input);
    if (target === this.root) throw new Error("不能删除授权根目录");
    await this.approve("file_trash", `Move to Windows Recycle Bin: ${target}`);
    await this.shell.trashItem(target);
    this.onLog("computer", `trashed ${target}`);
    return { ok: true, path: target, recoverable: true };
  }
}

module.exports = { ComputerControl, MAX_READ_BYTES, inside, resolveScopedPath, runPowerShell };
