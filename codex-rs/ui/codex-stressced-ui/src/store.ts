
let historyRequestVersion = 0;
// src/store.ts
import { create } from "zustand";
import { rpc, onNotification, onConnectionStatus, ConnectionState, getLastError, ensureConnected } from "./rpc";
import { prependTurns, transcriptFromTurns, upsertCompletedMessage, type Message, type Role, type ThinkingMessage, type ToolCall, type ThreadReadResponse, type ThreadTurn, type TurnsPage } from "./history";
import type { ContextUsage } from "./ContextStatus";
import { Followups, emptyRun, type ConversationRun, type Prompt } from "./followups";
import { DeltaBuffer } from "./deltaBuffer";
import { COMPUTER_TOOL_SPEC } from "./computerTool";
export type { Message, Role, ThinkingMessage, ToolCall } from "./history";

const FULL_ACCESS_SANDBOX_POLICY = { type: "dangerFullAccess" };
const FULL_ACCESS_APPROVAL_POLICY = "never";
const LIMITED_SANDBOX_POLICY = {
  type: "workspaceWrite",
  writableRoots: [],
  networkAccess: false,
};
const LIMITED_APPROVAL_POLICY = "on-failure";
const QUOTED_IMAGE_PATH_REGEX = /(["'])([^"'\r\n]+?\.(?:png|jpe?g|webp|bmp|gif))\1/gi;
const ABSOLUTE_IMAGE_PATH_REGEX = /[A-Za-z]:[\\/][^\r\n"'<>|?*]+?\.(?:png|jpe?g|webp|bmp|gif)/gi;
const RELATIVE_IMAGE_PATH_REGEX = /(?:^|[\s(])((?:\.{1,2}[\\/])?(?:[^\\/\r\n"'<>|?*:\s]+[\\/])*[^\\/\r\n"'<>|?*:\s]+\.(?:png|jpe?g|webp|bmp|gif))(?=$|[\s),.;:\]}])/gi;
const TRAILING_PATH_PUNCTUATION_REGEX = /[),.;:\]}]+$/;
const FULL_ACCESS_STORAGE_PREFIX = "codex-stressced-full-access:";
const REPEATED_ENV_ERROR_LIMIT = 3;

export type Thread = {
  id: string;
  name: string;
  model: string | null;
  status: "idle" | "busy" | "error";
  updatedAt: number;
  preview?: string;
  cwd?: string;
};



type AppState = {
  runs: Record<string, ConversationRun>;
  refreshThreads: () => Promise<void>;
  resumeQueue: (thread: string) => Promise<void>;
  editQueued: (thread: string, id: string, text: string) => void;
  removeQueued: (thread: string, id: string) => void;
  threads: Thread[];
  currentThreadId: string | null;
  messages: Message[];
  thinkingMessages: ThinkingMessage[];
  streaming: string | null;
  isStreaming: boolean;
  fullAccess: boolean;
  connectionStatus: ConnectionState;
  connectionError: string | null;
  contextUsage: ContextUsage | null;
  compacting: boolean;
  historyTurns: ThreadTurn[];
  historyCursor: string | null;
  loadingHistory: boolean;
  loadOlder: () => Promise<void>;
  compact: () => Promise<void>;

  init: () => Promise<void>;
  createThread: (options?: CreateThreadOptions) => Promise<void>;
  switchThread: (id: string) => Promise<void>;
  sendMessage: (text: string, image?: string | null, mode?: "queue" | "steer") => Promise<void>;
  stopTurn: () => Promise<void>;
  approveToolCall: (toolCallId: string, approvalId?: string) => Promise<void>;
  rejectToolCall: (toolCallId: string, approvalId?: string) => Promise<void>;
  enableFullAccess: () => Promise<void>;
  disableFullAccess: () => Promise<void>;
  onNotification: (data: Record<string, unknown>) => void;
};

export type CreateThreadOptions = {
  model?: string | null;
  cwd?: string | null;
  computerUse?: boolean;
};

let idCounter = 1;
function nextId() {
  return "id-" + (idCounter++);
}

let chatCounter = 1;
function nextChatName() {
  return "Chat #" + (chatCounter++);
}

function updateToolCallStatus(messages: Message[], toolCallId: string, newStatus: ToolCall["status"]): Message[] {
  return messages.map((m) => {
    if (m.role !== "assistant") return m;
    const tcs = m.toolCalls?.map((tc) =>
      tc.id === toolCallId ? { ...tc, status: newStatus } : tc
    );
    return { ...m, toolCalls: tcs };
  });
}

function extractRpcError(err: unknown): string {
  if (err == null) return "Unknown error";
  const m = String(err instanceof Error ? err.message : err);
  if (m.startsWith("{") && m.length < 1000) {
    try {
      const j = JSON.parse(m);
      if (j?.error?.message) return j.error.message;
      if (j?.message) return j.message;
    } catch {
      // ignore
    }
  }
  return m || "Unknown error";
}

export function extractLocalImagePaths(text: string): string[] {
  const matches: { path: string; start: number; end: number }[] = [];
  const seen = new Set<string>();

  const addMatch = (path: string, start: number, end: number) => {
    const normalizedPath = path.replace(TRAILING_PATH_PUNCTUATION_REGEX, "");
    const normalizedEnd = end - (path.length - normalizedPath.length);
    if (matches.some((entry) => start < entry.end && normalizedEnd > entry.start)) return;
    const key = normalizedPath.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      matches.push({ path: normalizedPath, start, end: normalizedEnd });
    }
  };

  for (const match of text.matchAll(QUOTED_IMAGE_PATH_REGEX)) {
    const path = match[2];
    const start = (match.index ?? 0) + match[0].indexOf(path);
    addMatch(path, start, start + path.length);
  }
  for (const match of text.matchAll(ABSOLUTE_IMAGE_PATH_REGEX)) {
    const start = match.index ?? 0;
    addMatch(match[0], start, start + match[0].length);
  }
  for (const match of text.matchAll(RELATIVE_IMAGE_PATH_REGEX)) {
    const path = match[1];
    const start = (match.index ?? 0) + match[0].indexOf(path);
    addMatch(path, start, start + path.length);
  }

  return matches.sort((a, b) => a.start - b.start).map((entry) => entry.path);
}

async function readLocalImageDataUrl(path: string, cwd?: string): Promise<string | null> {
  try {
    const api = (window as any).CodexStressCed;
    const dataUrl = await api?.readLocalImage?.(path, cwd);
    return typeof dataUrl === "string" && dataUrl.startsWith("data:image/")
      ? dataUrl
      : null;
  } catch {
    return null;
  }
}

function isInternalHistoryMessageContent(content: string): boolean {
  const trimmed = content.trimStart();
  return (
    (trimmed.startsWith("<environment_context>") && trimmed.includes("</environment_context>")) ||
    trimmed.startsWith("# AGENTS.md instructions for")
  );
}

type ToolProgressState = {
  turnId: string | null;
  started: number;
  completed: number;
  visibleAssistant: boolean;
  repeatedErrorKey: string | null;
  repeatedErrorCount: number;
  interruptedErrorKeys: Set<string>;
};

const toolProgress: ToolProgressState = {
  turnId: null,
  started: 0,
  completed: 0,
  visibleAssistant: false,
  repeatedErrorKey: null,
  repeatedErrorCount: 0,
  interruptedErrorKeys: new Set(),
};

function resetToolProgress(turnId: string | null = null) {
  toolProgress.turnId = turnId;
  toolProgress.started = 0;
  toolProgress.completed = 0;
  toolProgress.visibleAssistant = false;
  toolProgress.repeatedErrorKey = null;
  toolProgress.repeatedErrorCount = 0;
  toolProgress.interruptedErrorKeys = new Set();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function itemType(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  return stringValue((item as Record<string, unknown>).type);
}

function itemStatus(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  return stringValue((item as Record<string, unknown>).status).toLowerCase();
}

function itemOutput(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const record = item as Record<string, unknown>;
  return stringValue(record.aggregatedOutput) || stringValue(record.aggregated_output);
}

function turnItemId(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  return stringValue((item as Record<string, unknown>).id);
}

function notificationThreadId(params: Record<string, unknown> | undefined): string {
  return stringValue(params?.threadId) || stringValue(params?.thread_id);
}

function notificationTurnId(params: Record<string, unknown> | undefined): string {
  return stringValue(params?.turnId) || stringValue(params?.turn_id);
}

function responseTurnId(response: Record<string, unknown> | undefined): string {
  if (!response) return "";
  const direct = stringValue(response.turnId) || stringValue(response.turn_id);
  if (direct) return direct;

  const turn = response.turn;
  if (turn && typeof turn === "object") {
    return stringValue((turn as Record<string, unknown>).id);
  }
  return "";
}

function notificationItemId(params: Record<string, unknown> | undefined): string {
  return stringValue(params?.itemId) || stringValue(params?.item_id) || turnItemId(params?.item);
}

function notificationDelta(params: Record<string, unknown> | undefined): string {
  return stringValue(params?.delta);
}

function textFromContentParts(parts: unknown, assistant: boolean): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((c: any) => c?.text ?? "")
    .join(assistant ? "" : "\n");
}

function thinkingTextFromItem(item: any): string {
  const content = Array.isArray(item?.content) ? item.content.join("\n\n") : "";
  const summary = Array.isArray(item?.summary) ? item.summary.join("\n\n") : "";
  return (summary || content).trim();
}

function appendThinkingDelta(messages: ThinkingMessage[], itemId: string, delta: string): ThinkingMessage[] {
  if (!itemId || !delta) return messages;
  const existing = messages.findIndex((m) => m.id === itemId);
  if (existing >= 0) {
    return messages.map((m, i) => (
      i === existing ? { ...m, content: m.content + delta, done: false } : m
    ));
  }
  return [...messages, { id: itemId, content: delta, done: false }];
}

function upsertCompletedThinkingItem(messages: ThinkingMessage[], item: unknown): ThinkingMessage[] {
  const itemId = turnItemId(item);
  const content = thinkingTextFromItem(item);
  if (!itemId || !content) return messages;

  const existing = messages.findIndex((m) => m.id === itemId);
  if (existing >= 0) {
    return messages.map((m, i) => (
      i === existing ? { ...m, content, done: true } : m
    ));
  }
  return [...messages, { id: itemId, content, done: true }];
}

function environmentErrorKey(output: string): string | null {
  const lower = output.toLowerCase();
  if (lower.includes("windows sandbox: spawn setup refresh")) return "windows sandbox: spawn setup refresh";
  if (lower.includes("createprocesswithlogonw failed: 1056")) return "windows sandbox createprocesswithlogonw 1056";
  if (lower.includes("transport closed") && (lower.includes("mcp") || lower.includes("safe_edit"))) return "mcp transport closed";
  if (lower.includes("parsererror:")) return "powershell parser error";
  if (lower.includes("is not recognized as an internal or external command")) return "cmd/powershell mixed pipeline";
  if (lower.includes("tool task failed to receive")) return "tool task join";
  if (lower.includes("failed to initialize nvidia rtc library")) return "hashcat cuda rtc";
  if (lower.includes("cuda sdk toolkit installation not detected")) return "hashcat cuda sdk";
  if (lower.includes("failed to parse tool call arguments as json")) return "tool arguments json";
  if (lower.includes("app-server not reachable")) return "app-server not reachable";
  return null;
}

function fullAccessStorageKey(threadId: string): string {
  return FULL_ACCESS_STORAGE_PREFIX + threadId;
}

function readStoredFullAccess(threadId: string): boolean {
  try {
    return window.localStorage.getItem(fullAccessStorageKey(threadId)) === "1";
  } catch {
    return false;
  }
}

function writeStoredFullAccess(threadId: string, enabled: boolean) {
  try {
    const key = fullAccessStorageKey(threadId);
    if (enabled) {
      window.localStorage.setItem(key, "1");
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Local storage is only a convenience; RPC settings are still authoritative.
  }
}

function accessPolicyParams(fullAccess: boolean) {
  return {
    sandboxPolicy: fullAccess ? FULL_ACCESS_SANDBOX_POLICY : LIMITED_SANDBOX_POLICY,
    approvalPolicy: fullAccess ? FULL_ACCESS_APPROVAL_POLICY : LIMITED_APPROVAL_POLICY,
  };
}

async function applyAccessSettings(threadId: string, fullAccess: boolean) {
  await rpc("thread/settings/update", {
    threadId,
    ...accessPolicyParams(fullAccess),
  });
}

export const useStore = create<AppState>((set, get) => ({
  runs: {},
  resumeQueue: thread => followups.resume(thread),
  editQueued: (thread, id, text) => followups.edit(thread, id, text),
  removeQueued: (thread, id) => followups.remove(thread, id),
  threads: [],
  currentThreadId: null,
  messages: [],
  thinkingMessages: [],
  streaming: null,
  isStreaming: false,
  fullAccess: false,
  connectionStatus: "connecting",
  connectionError: null,
  contextUsage: null,
  compacting: false,
  historyTurns: [],
  historyCursor: null,
  loadingHistory: false,

  init: async () => {
    if (storeInitialized) return;
    storeInitialized = true;
    onNotification(data => {
      const method = String(data.method ?? "");
      if (["item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta"].includes(method)) {
        deltaBuffer.push(method, (data.params ?? {}) as Record<string, unknown>);
      } else {
        deltaBuffer.flush();
        get().onNotification(data);
      }
    });
    onConnectionStatus((status, message) => {
      const previous = get().connectionStatus;
      if (status !== "connected") {
        deltaBuffer.flush();
        for (const thread of Object.keys(get().runs)) followups.disconnected(thread);
      }
      set({ connectionStatus: status, connectionError: status === "error" ? message ?? null : null });
      if (status === "connected" && (previous !== "connected" || !initialListLoaded)) {
        initialListLoaded = true;
        void (async () => {
          await get().refreshThreads();
          const current = get().currentThreadId;
          if (current) await get().switchThread(current);
        })();
      }
    });
    try { await ensureConnected(); } catch { /* transport retries and reports status */ }
  },

  refreshThreads: async () => {
    try {
      console.log("[store] RPC thread/list");
      type ThreadListRaw = { id: string; name?: string | null; preview?: string | null; modelProvider?: string; cwd?: string; status?: { type: string }; updatedAt?: number };
      const res = await rpc<{ data: ThreadListRaw[] }>("thread/list", {
        limit: 50,
        sortDirection: "desc",
      });
      console.log("[store] RPC thread/list response", res);
      const threads: Thread[] = (res.data || []).map((t) => {
        const label = t.name || t.preview || nextChatName();
        return {
          id: t.id,
          name: (label ?? "Chat").toString(),
          preview: t.preview || undefined,
          model: t.modelProvider || null,
          cwd: t.cwd || undefined,
          status: t.status?.type === "active" ? "busy" : t.status?.type === "systemError" ? "error" : "idle",
          updatedAt: t.updatedAt ? t.updatedAt * 1000 : Date.now(),
        };
      });
      set({ threads });
    } catch (err) {
      console.error("[store] thread/list failed:", err);
      set({ connectionError: extractRpcError(err) });
    }
  },

  createThread: async (options = {}) => {
    const status = get().connectionStatus;
    if (status !== "connected") {
      console.warn("[store] createThread: not connected, status:", status);
      set((s) => ({
        connectionError: "Not connected to app-server; cannot create thread."
      }));
      return;
    }

    const version = ++historyRequestVersion;
    set({ loadingHistory: false });
    try {
      const { model, cwd, computerUse = false } = options;
      console.log("[store] RPC thread/start", { model, cwd, computerUse });
      const res = await rpc<{ thread: Thread }>("thread/start", {
        model: model ?? undefined,
        cwd: cwd?.trim() || undefined,
        dynamicTools: computerUse ? [COMPUTER_TOOL_SPEC] : undefined,
      });
      console.log("[store] RPC thread/start response", res);
      const thread = {
        ...res.thread,
        cwd: res.thread.cwd || cwd?.trim() || undefined,
      };
      if (version !== historyRequestVersion) return;
      resetToolProgress();
      console.log("[store] createThread: setting threadId:", thread.id);
      writeStoredFullAccess(thread.id, false);
      set((s) => ({
        threads: [thread, ...s.threads],
        currentThreadId: thread.id,
        messages: [],
        thinkingMessages: [],
        fullAccess: false,
        streaming: null, isStreaming: false, compacting: false, contextUsage: null,
        historyTurns: [], historyCursor: null, loadingHistory: false,
      }));
      console.log("[store] createThread: done, currentThreadId set to", thread.id);
      return;
    } catch (err) {
      if (version === historyRequestVersion) set({ connectionError: extractRpcError(err) });
    }
  },

  switchThread: async (id) => {
    if (get().currentThreadId === id && get().loadingHistory) return;
    deltaBuffer.flush();
    const version = ++historyRequestVersion;
    const storedFullAccess = readStoredFullAccess(id);
    resetToolProgress(get().runs[id]?.turnId ?? null);
    set({ currentThreadId: id, messages: [], thinkingMessages: [], streaming: null,
      isStreaming: get().runs[id]?.busy ?? false, compacting: get().runs[id]?.compacting ?? false, contextUsage: null,
      historyTurns: [], historyCursor: null, loadingHistory: true,
      fullAccess: storedFullAccess, connectionError: null });
    try {
      const runBeforeResume = get().runs[id];
      const resumed = await rpc<{ thread: { status?: { type?: string }; cwd?: string } }>("thread/resume", { threadId: id, excludeTurns: true });
      if (version !== historyRequestVersion) return;
      if (resumed.thread.cwd) {
        set((state) => ({
          threads: state.threads.map((thread) => thread.id === id ? { ...thread, cwd: resumed.thread.cwd } : thread),
        }));
      }
      const busy = resumed.thread.status?.type === "active";
      if (get().runs[id] === runBeforeResume) followups.reconcile(id, busy, busy ? get().runs[id]?.turnId ?? null : null);
      if (storedFullAccess) await applyAccessSettings(id, true);
      const runBeforeHistory = get().runs[id];
      let turns: ThreadTurn[];
      let cursor: string | null = null;
      try {
        const page = await rpc<TurnsPage>("thread/turns/list", {
          threadId: id, limit: 30, sortDirection: "desc", itemsView: "full",
        });
        turns = [...page.data].reverse();
        cursor = page.nextCursor;
      } catch (error) {
        // Older backends may lack pagination; retain the public protocol as the source of truth.
        const message = extractRpcError(error);
        if (!/unsupported|not supported|not found|unknown method|-32601|experimental/i.test(message)) throw error;
        const response = await rpc<ThreadReadResponse>("thread/read", { threadId: id, includeTurns: true });
        turns = response.thread.turns ?? [];
      }
      if (version !== historyRequestVersion || get().currentThreadId !== id) return;
      const activeTurn = turns.find(turn => (turn as ThreadTurn & { status?: string }).status === "inProgress");
      if (activeTurn && get().runs[id] === runBeforeHistory) followups.reconcile(id, true, activeTurn.id);
      resetToolProgress(get().runs[id]?.turnId ?? null);
      const transcript = transcriptFromTurns(turns);
      set(state => ({
        messages: [...transcript.messages.filter(m => !state.messages.some(x => x.id === m.id)), ...state.messages],
        thinkingMessages: [...transcript.thinkingMessages.filter(m => !state.thinkingMessages.some(x => x.id === m.id)), ...state.thinkingMessages],
        historyTurns: turns, historyCursor: cursor,
      }));
    } catch (error) {
      if (version === historyRequestVersion) set({ connectionError: extractRpcError(error) });
    } finally {
      if (version === historyRequestVersion) set({ loadingHistory: false });
    }
  },

  loadOlder: async () => {
    const { currentThreadId: id, historyCursor: cursor, loadingHistory, isStreaming } = get();
    if (!id || !cursor || loadingHistory || isStreaming) return;
    const version = historyRequestVersion;
    set({ loadingHistory: true });
    try {
      const page = await rpc<TurnsPage>("thread/turns/list", {
        threadId: id, cursor, limit: 30, sortDirection: "desc", itemsView: "full",
      });
      if (version !== historyRequestVersion || get().currentThreadId !== id) return;
      const older = [...page.data].reverse();
      const historyTurns = prependTurns(older, get().historyTurns);
      const transcript = transcriptFromTurns(older);
      // Preserve newer live messages that are not part of the loaded history pages.
      set((state) => ({
        messages: [...transcript.messages.filter(m => !state.messages.some(x => x.id === m.id)), ...state.messages],
        thinkingMessages: [...transcript.thinkingMessages.filter(m => !state.thinkingMessages.some(x => x.id === m.id)), ...state.thinkingMessages],
        historyTurns, historyCursor: page.nextCursor,
      }));
    } catch (error) {
      if (version === historyRequestVersion) set({ connectionError: extractRpcError(error) });
    } finally {
      if (version === historyRequestVersion) set({ loadingHistory: false });
    }
  },

  compact: async () => {
    const { currentThreadId: id, compacting, isStreaming, loadingHistory } = get();
    if (!id || compacting || isStreaming || loadingHistory) return;
    followups.compacting(id, true);
    set({ compacting: true, connectionError: null });
    try {
      await rpc("thread/compact/start", { threadId: id });
    } catch (error) {
      followups.compacting(id, false);
      if (get().currentThreadId === id) set({ compacting: false, connectionError: extractRpcError(error) });
    }
  },

  sendMessage: async (text, image, mode = "queue") => {
    const { currentThreadId, loadingHistory } = get();
    if (!currentThreadId || loadingHistory) throw new Error("Select a conversation and wait for its history to load.");
    if (!text.trim() && !image) return;
    await followups.submit(currentThreadId, { id: nextId(), text: text.trim(), image }, mode);
  },

  stopTurn: async () => {
    const thread = get().currentThreadId;
    if (!thread) return;
    try { await followups.stop(thread); }
    catch (error) { set({ connectionError: extractRpcError(error) }); }
  },

  approveToolCall: async (toolCallId: string, approvalId?: string) => {
    const { currentThreadId } = get();
    set({
      messages: updateToolCallStatus(get().messages, toolCallId, "approved"),
    });
    try {
      console.log("[store] RPC item/commandExecution/requestApproval approve", { threadId: currentThreadId, itemId: toolCallId, approvalId });
      await rpc<Record<string, unknown>>("item/commandExecution/requestApproval", {
        threadId: currentThreadId,
        itemId: toolCallId,
        approvalId: approvalId || undefined,
        decision: "Approved",
      });
    } catch (err) {
      console.error("[store] approveToolCall failed:", err);
    }
  },

  rejectToolCall: async (toolCallId: string, approvalId?: string) => {
    const { currentThreadId } = get();
    set({
      messages: updateToolCallStatus(get().messages, toolCallId, "rejected"),
    });
    try {
      console.log("[store] RPC item/commandExecution/requestApproval reject", { threadId: currentThreadId, itemId: toolCallId, approvalId });
      await rpc<Record<string, unknown>>("item/commandExecution/requestApproval", {
        threadId: currentThreadId,
        itemId: toolCallId,
        approvalId: approvalId || undefined,
        decision: "Rejected",
      });
    } catch (err) {
      console.error("[store] rejectToolCall failed:", err);
    }
  },


  enableFullAccess: async () => {
    const { currentThreadId } = get();
    if (!currentThreadId) return;
    const previousFullAccess = get().fullAccess;
    set({ fullAccess: true });
    try {
      await applyAccessSettings(currentThreadId, true);
      writeStoredFullAccess(currentThreadId, true);
    } catch (err) {
      set({ fullAccess: previousFullAccess });
      console.error("[store] enableFullAccess failed:", err);
      throw err;
    }
  },

  disableFullAccess: async () => {
    const { currentThreadId } = get();
    if (!currentThreadId) return;
    const previousFullAccess = get().fullAccess;
    set({ fullAccess: false });
    try {
      await applyAccessSettings(currentThreadId, false);
      writeStoredFullAccess(currentThreadId, false);
    } catch (err) {
      set({ fullAccess: previousFullAccess });
      console.error("[store] disableFullAccess failed:", err);
      throw err;
    }
  },

  onNotification: (data: Record<string, unknown>) => {
    const method = (data.method ?? data.m ?? "") as string;
    const params = data.params as Record<string, unknown> | undefined;

    // Update thread metadata (e.g., preview) from notifications
    if (method === "thread/started" || method === "thread/status/changed") {
      const p = params as { thread?: { id?: string; preview?: string | null } } | undefined;
      if (!p || !p.thread?.id) return;
      const thread = p.thread;

      set((s) => {
        const next = s.threads.map((t) => {
          if (t.id !== thread.id) return t;
          return { ...t, preview: thread.preview || t.preview };
        });
        return { threads: next };
      });
      return;
    }

    // Every live turn event belongs to a thread, including child-agent output.
    const eventThreadId = notificationThreadId(params);
    const completionId = (params?.turn as { id?: string } | undefined)?.id;
    if (method === "turn/completed" && eventThreadId && completionId === get().runs[eventThreadId]?.lastCompletedTurnId) return;
    if (method === "turn/completed" && eventThreadId && completionId && get().runs[eventThreadId]?.turnId &&
        completionId !== get().runs[eventThreadId].turnId) return;
    const knownThread = eventThreadId && (eventThreadId === get().currentThreadId || eventThreadId in get().runs);
    if (knownThread) {
      const turn = params?.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
      if (method === "turn/started" && turn?.id) followups.started(eventThreadId, turn.id);
      if (method === "turn/completed") followups.completed(eventThreadId, turn?.id, turn?.status ?? "completed", turn?.error?.message);
      if (method === "item/started" && itemType(params?.item) === "contextCompaction") followups.compacting(eventThreadId, true);
      if (method === "item/completed" && itemType(params?.item) === "contextCompaction") followups.compacting(eventThreadId, false);
      if (method === "error" && params?.willRetry !== true) followups.disconnected(eventThreadId);
    }
    if (eventThreadId && eventThreadId !== get().currentThreadId) return;
    if (method === "thread/tokenUsage/updated") {
      const usage = params?.tokenUsage as { last?: { totalTokens?: number }; modelContextWindow?: number | null } | undefined;
      const used = usage?.last?.totalTokens;
      if (typeof used === "number") set({ contextUsage: { used, window: usage?.modelContextWindow ?? null } });
      return;
    }
    if (method === "turn/started") {
      const turn = params?.turn as { id?: string } | undefined;
      if (turn?.id) resetToolProgress(turn.id);
      set({ isStreaming: true });
      return;
    }
    if (method === "error") {
      const error = params?.error as { message?: string } | undefined;
      if (params?.willRetry !== true) set({ compacting: false, isStreaming: false, connectionError: error?.message ?? "Error del servidor" });
      return;
    }

    // Streaming text deltas: item/agentMessage/delta
    // AgentMessageDeltaNotification: { thread_id, turn_id, item_id, delta }
    if (method === "item/agentMessage/delta") {
      const p = params as { delta: string } | undefined;
      const text = p?.delta ?? "";
      if (!text) return;

      toolProgress.visibleAssistant = true;
      const id = notificationItemId(params) || "stream-assistant";
      set((s) => {
        const existing = s.messages.find(m => m.id === id);
        const content = (existing?.content ?? "") + text;
        const message: Message = { id, role: "assistant", content };
        const messages = existing ? s.messages.map(m => m.id === id ? message : m) : [...s.messages, message];
        return { streaming: content, messages };
      });
      return;
    }

    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      const threadId = notificationThreadId(params);
      if (threadId && threadId !== get().currentThreadId) return;
      const itemId = notificationItemId(params);
      const delta = notificationDelta(params);
      set((s) => ({
        thinkingMessages: appendThinkingDelta(s.thinkingMessages, itemId, delta),
      }));
      return;
    }

    if (method === "item/started") {
      const threadId = notificationThreadId(params);
      if (threadId && threadId !== get().currentThreadId) return;

      const turnId = notificationTurnId(params);
      if (turnId && toolProgress.turnId !== turnId) {
        resetToolProgress(turnId);
      }

      const item = params?.item;
      const type = itemType(item);
      if (type === "contextCompaction") { set({ compacting: true }); return; }
      if (type === "userMessage") {
        const canonical = transcriptFromTurns([{ id: turnId, items: [item as Record<string, unknown>] }]).messages[0];
        if (canonical) set(state => {
          const optimistic = state.messages.findIndex(message => message.role === "user" && message.id.startsWith("id-") && message.content === canonical.content);
          if (optimistic < 0) return { messages: upsertCompletedMessage(state.messages, canonical) };
          return { messages: state.messages.map((message, index) => index === optimistic ? { ...message, id: canonical.id } : message) };
        });
        return;
      }
      if (!type || type === "reasoning" || type === "agentMessage" || type === "userMessage") return;

      toolProgress.started += 1;
      return;
    }

    if (method === "item/completed") {
      const threadId = notificationThreadId(params);
      if (threadId && threadId !== get().currentThreadId) return;

      const turnId = notificationTurnId(params);
      const item = params?.item;
      const type = itemType(item);
      if (type === "contextCompaction") {
        const id = notificationItemId(params) || `compact-${turnId}`;
        set((s) => ({ compacting: false, messages: s.messages.some(m => m.id === id) ? s.messages : [...s.messages, { id, role: "system", kind: "compaction", content: "Contexto compactado" }] }));
        return;
      }
      if (type === "reasoning") {
        set((s) => ({
          thinkingMessages: upsertCompletedThinkingItem(s.thinkingMessages, item),
        }));
        return;
      }
      if (type === "agentMessage") {
        const completed = transcriptFromTurns([{ id: turnId, items: [item as Record<string, unknown>] }]).messages[0];
        if (completed) set(s => ({ streaming: null, messages: upsertCompletedMessage(s.messages, completed) }));
        return;
      }
      if (!type || type === "userMessage") return;

      const completed = transcriptFromTurns([{ id: turnId, items: [item as Record<string, unknown>] }]).messages[0];
      if (completed) set(s => ({ messages: upsertCompletedMessage(s.messages, completed) }));

      toolProgress.completed += 1;
      const status = itemStatus(item);
      const output = itemOutput(item);
      const errorKey = status === "failed" ? environmentErrorKey(output) : null;

      if (errorKey) {
        if (toolProgress.repeatedErrorKey === errorKey) {
          toolProgress.repeatedErrorCount += 1;
        } else {
          toolProgress.repeatedErrorKey = errorKey;
          toolProgress.repeatedErrorCount = 1;
        }

        if (
          turnId &&
          toolProgress.repeatedErrorCount >= REPEATED_ENV_ERROR_LIMIT &&
          !toolProgress.interruptedErrorKeys.has(errorKey)
        ) {
          toolProgress.interruptedErrorKeys.add(errorKey);
          rpc("turn/interrupt", { threadId, turnId }).catch((err) => {
            console.error("[store] turn/interrupt after repeated environment error failed:", err);
          });
        }
        return;
      }

      toolProgress.repeatedErrorKey = null;
      toolProgress.repeatedErrorCount = 0;
      return;
    }

    // Turn completed: turn/completed
    // TurnCompletedNotification: { thread_id, turn: Turn }
    if (method === "turn/completed") {
      const turn = params?.turn as { status?: string; error?: { message?: string } } | undefined;
      const errorMessage = turn?.status === "failed" ? turn.error?.message : undefined;
      set((s) => {
        if (!s.isStreaming && s.streaming == null && !s.compacting && !errorMessage) return s;
        const assistantId = "id-" + Date.now();
        let msgs = s.messages.map((m) => {
          if (m.id === "stream-assistant" && m.role === "assistant") {
            return { ...m, id: assistantId };
          }
          return m;
        });
        resetToolProgress();
        return {
          isStreaming: false,
          streaming: null,
          messages: msgs,
          connectionError: errorMessage ?? s.connectionError,
          compacting: false,
        };
      });
      return;
    }

    // Command execution approval request
    // "item/commandExecution/requestApproval":
    // CommandExecutionRequestApprovalParams:
    // { thread_id, turn_id, item_id, started_at_ms, approvalId?, reason?, command?, cwd?, ... }
    if (method === "item/commandExecution/requestApproval") {
      const p = params as {
        itemId?: string;
        approvalId?: string;
        command?: string;
      } | undefined;

      const itemId = (p?.itemId ?? "").toString();
      if (!itemId) return;

      set((s) => {
        const tc: ToolCall = {
          id: itemId,
          name: "shell",
          input: p?.command ?? "<command not available>",
          status: "pending",
          approvalId: p?.approvalId ?? undefined,
        };
        const msgs = s.messages.map((m, i) => {
          if (i !== s.messages.length - 1 || m.role !== "assistant") return m;
          const toolCalls = (m.toolCalls ?? []).concat(tc);
          return { ...m, toolCalls };
        });
        return { messages: msgs };
      });
      return;
    }
  },
}));

let storeInitialized = false;
let initialListLoaded = false;
const deltaBuffer = new DeltaBuffer(events => {
  for (const event of events) useStore.getState().onNotification(event);
});

const followups: Followups = new Followups({
  get: thread => useStore.getState().runs[thread] ?? emptyRun,
  set: (thread, run) => useStore.setState(state => ({
    runs: { ...state.runs, [thread]: run },
    ...(state.currentThreadId === thread ? {
      isStreaming: run.busy, compacting: run.compacting,
      ...(run.error || state.connectionError === state.runs[thread]?.error ? { connectionError: run.error } : {}),
    } : {}),
  })),
  connected: () => useStore.getState().connectionStatus === "connected",
  interrupt: async (threadId, turnId) => { await rpc("turn/interrupt", { threadId, turnId }); },
  send: async (currentThreadId: string, prompt: Prompt, expectedTurnId?: string) => {
    const { text, image } = prompt;
    const state = useStore.getState();
    const fullAccess = state.currentThreadId === currentThreadId ? state.fullAccess : readStoredFullAccess(currentThreadId);
    const activeCwd = state.threads.find(thread => thread.id === currentThreadId)?.cwd;
    const textImagePaths = extractLocalImagePaths(text);
    const inputParts: Record<string, unknown>[] = [{ type: "text", text: text.trim() }];
    const includedLocalImages = new Set<string>();

    for (const path of textImagePaths) {
      includedLocalImages.add(path.toLowerCase());
      const dataUrl = await readLocalImageDataUrl(path, activeCwd);
      if (dataUrl) {
        inputParts.push({ type: "image", url: dataUrl, detail: "high" });
      } else {
        inputParts.push({ type: "localImage", path, detail: "high" });
      }
    }

    if (image) {
      if (image.startsWith("data:")) {
        // Data URL -> use "image" type with field "url" (v2 protocol).
        inputParts.push({ type: "image", url: image, detail: "high" });
      } else {
        const imageKey = image.toLowerCase();
        if (!includedLocalImages.has(imageKey)) {
          const dataUrl = await readLocalImageDataUrl(image, activeCwd);
          if (dataUrl) {
            inputParts.push({ type: "image", url: dataUrl, detail: "high" });
          } else {
            inputParts.push({ type: "localImage", path: image, detail: "high" });
          }
        }
      }
    }

    if (!expectedTurnId && fullAccess) await applyAccessSettings(currentThreadId, true);
    const run = useStore.getState().runs[currentThreadId];
    if (expectedTurnId && (!run?.busy || run.turnId !== expectedTurnId || run.compacting)) {
      throw new Error("The active turn changed. Your message is still in the composer; send it as Queue.");
    }
    const visible = () => useStore.getState().currentThreadId === currentThreadId;
    if (visible()) {
      deltaBuffer.flush();
      useStore.setState(state => ({ messages: [...state.messages, {
        id: prompt.id, role: "user", content: text, image: image || undefined,
      }], connectionError: null }));
    }
    try {
      const result = await rpc<Record<string, unknown>>(expectedTurnId ? "turn/steer" : "turn/start", {
        threadId: currentThreadId,
        ...(expectedTurnId ? { expectedTurnId } : accessPolicyParams(fullAccess)),
        input: inputParts,
      });
      return responseTurnId(result);
    } catch (error) {
      if (visible()) useStore.setState(state => ({
        messages: state.messages.filter(message => message.id !== prompt.id),
        connectionError: extractRpcError(error),
      }));
      throw error;
    }
  },
});
