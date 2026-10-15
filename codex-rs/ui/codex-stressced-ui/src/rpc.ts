// src/rpc.ts
// RPC client that uses the Codex Stressced Electron preload API instead of direct WebSocket.

export type ConnectionState = "connecting" | "connected" | "error" | "closed";

type NotifyListener = (data: Record<string, unknown>) => void;
type ConnectionStatusListener = (status: ConnectionState, message?: string) => void;

declare global {
  interface Window {
    CodexStressCed: {
      connect?: () => Promise<{ state: ConnectionState; message?: string }>;
      getConnectionStatus?: () => Promise<{ state: ConnectionState; message?: string }>;
      rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
      openImageDialog: () => Promise<string | null>;
      openWorkspaceDialog: () => Promise<string | null>;
      getPastedImage: () => Promise<string | null>;
      readLocalImage?: (filePath: string, cwd?: string) => Promise<string | null>;
      readThreadHistory?: (filePath: string) => Promise<Array<Record<string, unknown>>>;
      onNotification: (fn: NotifyListener) => () => void;
      onConnectionStatus: (fn: ConnectionStatusListener) => () => void;
    };
  }
}

let status: ConnectionState = "connecting";
let error: string | null = null;
let initialized = false;
const listeners = new Set<ConnectionStatusListener>();
let revision = 0;

function setStatus(next: ConnectionState, message?: string) {
  revision++;
  status = next;
  error = next === "error" ? message ?? "Connection error" : null;
  for (const listener of listeners) listener(next, message);
}

function init() {
  if (initialized) return;
  const api = window.CodexStressCed;
  if (!api) { setStatus("error", "Codex Stressced API unavailable"); return; }
  initialized = true;
  api.onConnectionStatus?.(setStatus);
  const version = revision;
  void api.getConnectionStatus?.().then(snapshot => {
    if (revision === version) setStatus(snapshot.state, snapshot.message);
  });
}

export async function ensureConnected(): Promise<void> {
  init();
  const snapshot = await window.CodexStressCed?.connect?.();
  if (snapshot) {
    setStatus(snapshot.state, snapshot.message);
    if (snapshot.state !== "connected") throw new Error(snapshot.message ?? "Connection unavailable");
  }
}

export async function rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  const api = window.CodexStressCed;
  if (!api) throw new Error("Codex Stressced API unavailable");
  const result = await api.rpc(method, params);
  if (result && typeof result === "object" && "__rpc_error" in result) {
    throw new Error("message" in result ? String(result.message) : "RPC error");
  }
  return result as T;
}

export function onNotification(fn: NotifyListener): () => void {
  return window.CodexStressCed?.onNotification?.(fn) ?? (() => {});
}

export function onConnectionStatus(fn: ConnectionStatusListener): () => void {
  listeners.add(fn);
  init();
  fn(status, error ?? undefined);
  return () => { listeners.delete(fn); };
}

export function getConnectionStatus(): ConnectionState { return status; }
export function getLastError(): string | null { return error; }
