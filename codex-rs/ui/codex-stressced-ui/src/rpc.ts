// src/rpc.ts
// RPC client that uses the Codex Stressced Electron preload API instead of direct WebSocket.

export type ConnectionState = "connecting" | "connected" | "error" | "closed";

type NotifyListener = (data: Record<string, unknown>) => void;
type ConnectionStatusListener = (status: ConnectionState, message?: string) => void;

declare global {
  interface Window {
    CodexStressCed: {
      rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
      openImageDialog: () => Promise<string | null>;
      getPastedImage: () => Promise<string | null>;
      readLocalImage?: (filePath: string) => Promise<string | null>;
      readThreadHistory?: (filePath: string) => Promise<Array<Record<string, unknown>>>;
      onNotification: (fn: NotifyListener) => () => void;
      onConnectionStatus: (fn: ConnectionStatusListener) => () => void;
    };
  }
}

class RpcClient {
  private _connectionStatus: ConnectionState = "connecting";
  private _error: string | null = null;
  private statusListeners = new Set<ConnectionStatusListener>();
  private notifyListeners = new Set<NotifyListener>();

  get connectionStatus(): ConnectionState {
    return this._connectionStatus;
  }

  get lastError(): string | null {
    return this._error;
  }

  init() {
    if (!window.CodexStressCed) {
      this.setStatus("error", "Codex Stressced API not available (not running in Electron)");
      return;
    }

    window.CodexStressCed.onConnectionStatus((status: ConnectionState, message?: string) => {
      this.setStatus(status, message);
    });
  }

  private setStatus(status: ConnectionState, message?: string) {
    this._connectionStatus = status;
    if (status === "error") {
      this._error = message ?? "Unknown error";
    } else if (status === "connected") {
      this._error = null;
    }
    for (const fn of this.statusListeners) {
      try { fn(status, message); } catch { /* ignore */ }
    }
  }

  rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!window.CodexStressCed) {
      return Promise.reject(new Error("Codex Stressced API not available"));
    }
    return window.CodexStressCed.rpc(method, params).then((v) => {
      // If main process wrapped an error, throw it so store.ts can catch it.
      if (
        typeof v === "object" &&
        v !== null &&
        "__rpc_error" in v &&
        v.__rpc_error === true
      ) {
        const msg = "message" in v && typeof v.message === "string" ? v.message : "RPC error";
        throw new Error(msg);
      }
      return v as T;
    });
  }

  onNotification(fn: NotifyListener): () => void {
    if (!window.CodexStressCed) return () => {};
    return window.CodexStressCed.onNotification(fn);
  }

  onConnectionStatus(fn: ConnectionStatusListener): () => void {
    if (!window.CodexStressCed) return () => {};
    return window.CodexStressCed.onConnectionStatus(fn);
  }
}

const client = new RpcClient();

export async function ensureConnected(): Promise<void> {
  // Connection is managed by main process; ensureConnected is a no-op but we expose status.
}

export function rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  return client.rpc<T>(method, params);
}

export function onNotification(fn: NotifyListener): () => void {
  return client.onNotification(fn);
}

export function onConnectionStatus(fn: ConnectionStatusListener): () => void {
  return client.onConnectionStatus(fn);
}

export function getConnectionStatus(): ConnectionState {
  return client.connectionStatus;
}

export function getLastError(): string | null {
  return client.lastError;
}
