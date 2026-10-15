// electron/main.ts
import { app, BrowserWindow, clipboard, ipcMain, shell, dialog } from "electron";
import path from "path";
import { spawn } from "child_process";
import fs from "fs";
import net from "node:net";
import { executeComputerTool } from "./computer-use";
import { AppServerConnection } from "./connection";
import { localImageToDataUrl } from "./image-attachment";
import { backendEnvironment } from "./backend-environment";

const LOG_FILE = path.join(
  process.env.USERPROFILE || process.env.HOME || "",
  "Desktop",
  "codex-stressced-logs.txt"
);
const DEBUG_LOGS = process.env.CODEX_STRESSCED_DEBUG_LOGS === "1";

try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
} catch {
  // ignore
}

function logToFile(msg: string) {
  try {
    const line = new Date().toISOString() + " " + msg + "\n";
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // ignore
  }
}

const isDev = !!(process.env.NODE_ENV === "development" || process.execPath.includes("electron"));

let mainWindow: BrowserWindow | null = null;
let appServerProc: ReturnType<typeof spawn> | null = null;
let isQuitting = false;

function sendToRenderer(channel: string, ...args: unknown[]) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel, ...args);
  } catch {
    // ignore when shutting down
  }
}

function logMain(...args: unknown[]) {
  try {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a ?? ""))).join(" ");
    logToFile(msg);
    mainWindow?.webContents?.send("main-log", ...args);
  } catch {
    // ignore
  }
}

function findCodexBinary(): string | null {
  const envBin = process.env.CODEX_BINARY;
  if (envBin) return envBin;

  const exeName = process.platform === "win32" ? "codexstressced.exe" : "codexstressced";
  const targetDir =
    process.env.CODEX_STRESSCED_CARGO_TARGET_DIR ||
    (process.platform === "win32" ? "D:\\codex-stressced-cargo-target" : path.join(process.env.TMPDIR || "/tmp", "codex-stressced-cargo-target"));
  const packagedBinary = path.join(process.resourcesPath, exeName);
  const devCandidates = [
    path.join(__dirname, "..", "dist-backend", exeName),
    path.join(targetDir, "debug", exeName),
    path.join(__dirname, "..", "..", "..", "..", "codex-rs", "target", "debug", exeName),
  ];
  const candidates = isDev ? [...devCandidates, packagedBinary] : [packagedBinary, ...devCandidates];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore
    }
  }
  return null;
}

async function probeAppServer(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const http = require("http");
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/healthz",
        timeout: 1000,
      },
      (res: any) => {
        const ok = res.statusCode === 200;
        res.resume();
        resolve(ok);
      }
    ).on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

let selectedPort: number | null = null;
async function availablePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", error => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && preferred !== 0) {
        availablePort(0).then(resolve, reject);
      } else reject(error);
    });
    probe.listen(preferred, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}
const connection = new AppServerConnection({
  endpoint: async () => {
    // Probe again after a crash. Keep using the chosen port while our child starts.
    if (selectedPort && await probeAppServer(selectedPort)) return `ws://127.0.0.1:${selectedPort}/rpc`;
    if (appServerProc && selectedPort) return `ws://127.0.0.1:${selectedPort}/rpc`;
    for (const port of [1422, 1421]) {
      if (await probeAppServer(port)) { selectedPort = port; return `ws://127.0.0.1:${port}/rpc`; }
    }
    if (isQuitting) throw new Error("Application is closing");
    // An unresponsive listener must not block launch or be killed on the user's behalf.
    selectedPort = await availablePort(1422);
    await startAppServer(selectedPort);
    return `ws://127.0.0.1:${selectedPort}/rpc`;
  },
  status: (state, message) => {
    logMain("[connection]", state, message ?? "");
    sendToRenderer("connection-status", state, message);
  },
  notification: message => sendToRenderer("notification", message),
  tool: async (method, params) => {
    if (method !== "item/tool/call") throw new Error(`Unsupported server request: ${method}`);
    const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
    return executeComputerTool(String(record.tool ?? ""), record.arguments);
  },
});

async function startAppServer(port: number) {
  const bin = findCodexBinary();
  if (!bin) {
    throw new Error("Bundled codexstressced backend not found. Reopen the portable executable to extract its resources again.");
  }

  const env = backendEnvironment(bin, process.env);

  const endpoint = `ws://127.0.0.1:${port}`;
  logMain("[main] spawning app-server:", bin, "app-server", "--listen", endpoint);
  const proc = spawn(bin, ["app-server", "--listen", endpoint], {
    stdio: ["ignore", DEBUG_LOGS ? "pipe" : "ignore", "pipe"],
    windowsHide: true,
    env,
    detached: false,
  });

  proc.on("spawn", () => {
    logMain("[main] app-server spawned with PID", proc.pid);
  });

  proc.on("error", (err: Error) => {
    logMain("[main] app-server process error", err);
  });

  if (DEBUG_LOGS) {
    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) logMain("[app-server]", text);
    });

  }
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) logMain("[app-server-err]", text);
  });

  proc.on("exit", (code, signal) => {
    logMain("[main] app-server exited", { code, signal });
    if (appServerProc === proc) appServerProc = null;
  });

  proc.on("error", (err: Error) => {
    logMain("[main] app-server spawn error", err.message);
    if (appServerProc === proc) appServerProc = null;
  });

  appServerProc = proc;
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Codex Stressced",
    show: false,
    backgroundColor: "#1a1a1a",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:5174");
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  win.once("ready-to-show", () => {
    win.show();
  });

  // Allow opening DevTools with Ctrl+Shift+I (useful in production builds)
  win.webContents.on("before-input-event", (event, input) => {
    const key = (input.key || "").toLowerCase();
    if (input.control && input.shift && (key === "i" || key === "j")) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

ipcMain.handle("rpc", async (_event, method: string, params?: Record<string, unknown>) => {
  try {
    return await connection.request(method, params);
  } catch (err) {
    return {
      __rpc_error: true,
      message: String(err instanceof Error ? err.message : err),
    };
  }
});

ipcMain.handle("connection-status", () => connection.status);
ipcMain.handle("connect", () => connection.connect().then(() => connection.status).catch(() => connection.status));

ipcMain.on("renderer-log", (_event, msg: string) => {
  if (DEBUG_LOGS) {
    logToFile("[renderer] " + msg);
  }
});

app.whenReady().then(async () => {
  mainWindow = await createWindow();

  ipcMain.handle("open-image-dialog", async () => {
    console.log("[main] open-image-dialog invoked");
    const window = mainWindow;
    if (!window || window.isDestroyed()) {
      return null;
    }
    const result = await dialog.showOpenDialog(window, {
      properties: ["openFile"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] },
      ],
    });
    console.log("[main] open-image-dialog result", result.filePaths);
    return result.filePaths?.[0] ?? null;
  });

  ipcMain.handle("open-workspace-dialog", async () => {
    const window = mainWindow;
    if (!window || window.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(window, {
      title: "Select workspace folder",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths?.[0] ?? null;
  });

  ipcMain.handle("get-pasted-image", async () => {
    try {
      // 1) Direct image from clipboard
      const image = clipboard.readImage();
      if (image && !image.isEmpty()) {
        const buf = image.toPNG();
        const outDir = app.getPath("temp");
        const file = path.join(outDir, "codex-paste-" + Date.now() + ".png");
        fs.writeFileSync(file, buf);
        console.log("[main] get-pasted-image saved", file);
        return file;
      }

      // 2) Fallback: image file path from clipboard (e.g. from Explorer)
      const text = (clipboard.readText() || "").trim();
      if (text) {
        const exts = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"];
        const candidates = text.split(/\s+/).map((s) => s.trim()).filter(Boolean);
        for (const c of candidates) {
          const low = c.toLowerCase();
          if (exts.some((e) => low.endsWith(e)) && fs.existsSync(c)) {
            console.log("[main] get-pasted-image from clipboard path", c);
            return c;
          }
        }
      }

      return null;
    } catch (e) {
      console.error("[main] get-pasted-image error", e);
      return null;
    }
  });

  ipcMain.handle("read-local-image", async (_event, filePath: string, cwd?: string) => {
    try {
      return localImageToDataUrl(filePath, cwd);
    } catch (e) {
      console.error("[main] read-local-image error", e);
      return null;
    }
  });


function isInternalHistoryMessageContent(content: string): boolean {
  const trimmed = content.trimStart();
  return (
    (trimmed.startsWith("<environment_context>") && trimmed.includes("</environment_context>")) ||
    trimmed.startsWith("# AGENTS.md instructions for")
  );
}

  // New handler: read thread history from JSONL (for when thread/read has no items).
ipcMain.handle("read-thread-history", async (_event, filePath: string) => {
  try {
    const p = String(filePath).trim();
    if (!fs.existsSync(p)) return [];
    const text = fs.readFileSync(p, "utf8");
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const messages: Array<{ id: string; role: "user" | "assistant" | "thinking"; content: string }> = [];
    let idx = 0;
    for (const line of lines) {
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      const type = evt?.type;

      // Format: { type: "response_item", payload: { type: "message", role: "user"|"assistant", content: [...] } }
      if (type === "response_item") {
        const payload = evt?.payload;
        if (payload?.type === "message" && (payload?.role === "user" || payload?.role === "assistant")) {
          const parts = Array.isArray(payload?.content) ? payload.content : [];
          const content = parts
            .filter((c: any) => c?.type === "input_text" || c?.type === "output_text" || c?.type === "text")
            .map((c: any) => c.text ?? "")
            .join(payload.role === "user" ? "\n" : "");
          if (content.trim() && !isInternalHistoryMessageContent(content)) {
            const prefix = payload.role === "user" ? "hist-u-" : "hist-a-";
            messages.push({ id: prefix + idx++, role: payload.role, content: content.trim() });
          }
        }
        if (payload?.type === "reasoning") {
          const parts = Array.isArray(payload?.content) ? payload.content : [];
          const content = parts
            .filter((c: any) => c?.type === "reasoning_text" || c?.type === "text")
            .map((c: any) => c.text ?? "")
            .join("\n\n");
          if (content.trim()) {
            messages.push({ id: "hist-t-" + idx++, role: "thinking", content: content.trim() });
          }
        }
        continue;
      }

      // Legacy format fallback: { type: "userMessage", params: { prompt: [...] } }
      if (type === "userMessage") {
        const prompt = Array.isArray(evt?.params?.prompt) ? evt.params.prompt : [];
        const content = prompt
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text ?? "")
          .join("\n");
        if (content.trim() && !isInternalHistoryMessageContent(content)) {
          messages.push({ id: "hist-u-" + idx++, role: "user", content: content.trim() });
        }
      }
      // Legacy format fallback: { type: "agentMessage", params: { content: [...] } }
      if (type === "agentMessage") {
        const parts = Array.isArray(evt?.params?.content) ? evt.params.content : [];
        const content = parts
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text ?? "")
          .join("");
        if (content.trim() && !isInternalHistoryMessageContent(content)) {
          messages.push({ id: "hist-a-" + idx++, role: "assistant", content: content.trim() });
        }
      }
    }
    console.log("[main] read-thread-history lines", lines.length, "messages", messages.length);
    return messages;
  } catch (err) {
    console.error("[main] read-thread-history error", err);
    return [];
  }
});

  ipcMain.handle("read-file-content", async (_event, filePath: string) => {
    try {
      const p = String(filePath).trim();
      if (!fs.existsSync(p)) return null;
      const stat = fs.statSync(p);
      if (!stat.isFile()) return null;
      const text = fs.readFileSync(p, "utf8");
      return text;
    } catch {
      return null;
    }
  });
  void connection.connect().catch(() => {});

  app.on("before-quit", () => {
    isQuitting = true;
    connection.close();
    if (appServerProc) {
      try { appServerProc.kill("SIGTERM"); } catch { /* ignore */ }
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!mainWindow) {
    createWindow().then((w) => (mainWindow = w));
  }
});
