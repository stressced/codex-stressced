import { contextBridge, ipcRenderer } from "electron";

const originalLog = console.log;
const DEBUG_LOGS = process.env.CODEX_STRESSCED_DEBUG_LOGS === "1";

// Forward main process logs into renderer console.
if (DEBUG_LOGS) {
  ipcRenderer.on("main-log", (_: any, ...args: unknown[]) => {
    originalLog.apply(console, args);
  });
}

// Small helper that sends logs to main so it can write to file.
function logToFile(...args: unknown[]) {
  try {
    ipcRenderer.send(
      "renderer-log",
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a ?? ""))).join(" ")
    );
  } catch {
    // ignore
  }
}

if (DEBUG_LOGS) {
  console.log = (...args: unknown[]) => {
    originalLog.apply(console, args);
    logToFile(...args);
  };
}

contextBridge.exposeInMainWorld("CodexStressCed", {
  rpc: async (method: string, params?: Record<string, unknown>) => {
    return ipcRenderer.invoke("rpc", method, params);
  },

  openImageDialog: async () => {
    return ipcRenderer.invoke("open-image-dialog");
  },

  getPastedImage: async () => {
    return ipcRenderer.invoke("get-pasted-image");
  },

  readLocalImage: async (filePath: string) => {
    return ipcRenderer.invoke("read-local-image", filePath);
  },

  onNotification: (cb: (data: Record<string, unknown>) => void) => {
    const listener = (_: any, data: Record<string, unknown>) => cb(data);
    ipcRenderer.on("notification", listener);
    return () => {
      ipcRenderer.removeListener("notification", listener);
    };
  },

  onConnectionStatus: (
    cb: (status: string, message?: string) => void
  ) => {
    const listener = (_: any, status: string, message?: string) => cb(status, message);
    ipcRenderer.on("connection-status", listener);
    return () => {
      ipcRenderer.removeListener("connection-status", listener);
    };
  },

  readThreadHistory: async (filePath: string) => {
    return ipcRenderer.invoke("read-thread-history", filePath);
  },});
