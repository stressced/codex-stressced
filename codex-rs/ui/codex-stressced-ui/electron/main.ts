// electron/main.ts
import { app, BrowserWindow, clipboard, ipcMain, shell, dialog, nativeImage } from "electron";
import path from "path";
import { spawn } from "child_process";
import fs from "fs";

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

let ws: WebSocket | null = null;
let wsId = 1;
let wsPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
let wsConnecting = false;

// Active port where WebSocket is connected; used by RPC to avoid forcing a specific port.
let activeWsPort: number | null = null;

const LLAMA_CPP_URL = "http://127.0.0.1:8080/v1";
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const LONG_RPC_TIMEOUT_MS = 5 * 60_000;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]);
const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1200;
const IMAGE_JPEG_QUALITY = 80;

function rpcTimeoutMs(method: string): number {
  if (method === "turn/start" || method === "thread/read" || method === "thread/resume") {
    return LONG_RPC_TIMEOUT_MS;
  }
  return DEFAULT_RPC_TIMEOUT_MS;
}

function sendToRenderer(channel: string, ...args: unknown[]) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel, ...args);
  } catch {
    // ignore when shutting down
  }
}

function localImageToDataUrl(filePath: string): string | null {
  const p = String(filePath || "").trim().replace(/^["']|["']$/g, "");
  const ext = path.extname(p).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  if (!fs.existsSync(p)) return null;

  const stat = fs.statSync(p);
  if (!stat.isFile() || stat.size > MAX_IMAGE_FILE_BYTES) return null;

  const image = nativeImage.createFromPath(p);
  if (!image.isEmpty()) {
    const size = image.getSize();
    const maxSide = Math.max(size.width, size.height);
    const resized = maxSide > MAX_IMAGE_DIMENSION
      ? image.resize({
          width: Math.round(size.width * (MAX_IMAGE_DIMENSION / maxSide)),
          height: Math.round(size.height * (MAX_IMAGE_DIMENSION / maxSide)),
          quality: "best",
        })
      : image;
    return "data:image/jpeg;base64," + resized.toJPEG(IMAGE_JPEG_QUALITY).toString("base64");
  }

  const mime = ext === ".jpg" || ext === ".jpeg"
    ? "image/jpeg"
    : ext === ".webp"
      ? "image/webp"
      : ext === ".bmp"
        ? "image/bmp"
        : ext === ".gif"
          ? "image/gif"
          : "image/png";
  return `data:${mime};base64,${fs.readFileSync(p).toString("base64")}`;
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

function logDebug(...args: unknown[]) {
  if (DEBUG_LOGS) {
    logMain(...args);
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
    http.get(
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
  });
}

async function ensureWs(port: number) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    activeWsPort = port;
    return;
  }
  if (wsConnecting) return;
  wsConnecting = true;

  const url = "ws://127.0.0.1:" + port + "/rpc";

  try {
    ws = new WebSocket(url);
  } catch (err) {
    wsConnecting = false;
    sendToRenderer("connection-status", "error", "WS connect error: " + err);
    return;
  }

  ws.onopen = () => {
    wsConnecting = false;
    activeWsPort = port;
    sendToRenderer("connection-status", "connected", "Connected to app-server on " + port);
    (async () => {
      try {
        await rpcRequest("initialize", {
          clientInfo: { name: "codex-stressced-ui", version: "0.1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        });
        rpcNotify("initialized");
      } catch {
        // non-critical
      }
    })();
  };

  ws.onmessage = (event: any) => {
    if (typeof event.data !== "string") return;
    const raw = String(event.data);
    if (DEBUG_LOGS) {
      console.log("[WS] raw", raw.substring(0, 500));
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const id = msg.id;
    const hasResult = msg.result !== undefined;
    const hasError = msg.error !== undefined;
    const type = String(msg.type ?? "");

    // JSON-RPC 2.0 style: {id, result} or {id, error}
    if (id != null && (hasResult || hasError)) {
      const rid = Number(id);
      const p = wsPending.get(rid);
      if (p) {
        wsPending.delete(rid);
        if (hasError) {
          p.reject(new Error(JSON.stringify(msg.error)));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }

    // Legacy rpc_response envelope (if present)
    if (type === "rpc_response") {
      const rid = Number(msg.id);
      const p = wsPending.get(rid);
      if (!p) return;
      wsPending.delete(rid);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }

    // Notifications: either type === "notification" or has method and no id
    if (type === "notification" || (msg.method && id == null)) {
      logDebug("[WS] notification", String(msg.method ?? type));
      sendToRenderer("notification", msg);
      return;
    }
  };

  ws.onerror = (err: any) => {
    logMain("[WS] error", err?.message ?? "ws-error");
  };

  ws.onclose = (event: CloseEvent) => {
    logMain("[WS] closed", {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });
    ws = null;
    activeWsPort = null;
    if (!isQuitting) {
      sendToRenderer("connection-status", "error", "WebSocket closed unexpectedly");
    }
  };
}

async function rpcRequest<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("not connected");
  }
  const id = wsId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  logDebug("[WS] request", msg);
  ws.send(JSON.stringify(msg));
  return new Promise((resolve, reject) => {
    const timeoutMs = rpcTimeoutMs(method);
    const timer = setTimeout(() => {
      wsPending.delete(id);
      logMain("[WS] rpc timeout", { id, method, timeoutMs });
      reject(new Error("RPC timeout"));
    }, timeoutMs);
    wsPending.set(id, {
      resolve: (v: unknown) => {
        clearTimeout(timer);
        resolve(v as T);
      },
      reject: (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    });
  });
}

function rpcNotify(method: string, params?: Record<string, unknown>) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const msg = { method, params };
  logDebug("[WS] notify", msg);
  ws.send(JSON.stringify(msg));
}

async function startAppServer() {
  const bin = findCodexBinary();
  if (!bin) {
    console.warn("[main] codex binary not found; UI will try existing app-server");
    return;
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RUST_BACKTRACE: process.env.RUST_BACKTRACE ?? "1",
    RUST_LOG:
      process.env.RUST_LOG ??
      "warn",
  };

  if (!env.CODEX_HOME) {
    const home = env.USERPROFILE || process.env.HOME || "";
    env.CODEX_HOME = path.join(home, ".llmlocal");
  }

  logMain("[main] spawning app-server:", bin, "app-server", "--listen", "ws://127.0.0.1:1422");
  const proc = spawn(bin, ["app-server", "--listen", "ws://127.0.0.1:1422"], {
    stdio: ["ignore", DEBUG_LOGS ? "pipe" : "ignore", DEBUG_LOGS ? "pipe" : "ignore"],
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

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) logMain("[app-server-err]", text);
    });
  }

  proc.on("exit", (code, signal) => {
    logMain("[main] app-server exited", { code, signal });
  });

  proc.on("error", (err: Error) => {
    logMain("[main] app-server spawn error", err);
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
    // Prefer the already-connected port so we don't force 1422 and break if server is on 1421.
    const port = activeWsPort ?? 1422;
    await ensureWs(port);
    return await rpcRequest(method, params);
  } catch (err) {
    return {
      __rpc_error: true,
      message: String(err instanceof Error ? err.message : err),
    };
  }
});

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

  ipcMain.handle("read-local-image", async (_event, filePath: string) => {
    try {
      return localImageToDataUrl(filePath);
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
  const use1421 = await probeAppServer(1421);
  const use1422 = await probeAppServer(1422);

  if (use1421) {
    console.log("[main] using existing app-server on 1421");
  } else if (use1422) {
    console.log("[main] using existing app-server on 1422");
  } else {
    try {
      await startAppServer();
    } catch (err) {
      logMain("[main] app-server start failed", err);
    }
  }

  // Wait a bit for app-server, then connect.
  sendToRenderer("connection-status", "connecting", "Connecting to app-server...");
  setTimeout(async () => {
    const target = use1421 ? 1421 : use1422 ? 1422 : 1422;
    try {
      await ensureWs(target);
    } catch {
      // renderer will see connection-status
    }
  }, 2500);

  app.on("before-quit", () => {
    isQuitting = true;
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    } catch { /* ignore */ }
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
