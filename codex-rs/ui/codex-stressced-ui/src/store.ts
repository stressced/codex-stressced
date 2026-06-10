
const loadingThreads = new Set<string>();
// src/store.ts
import { create } from "zustand";
import { rpc, onNotification, onConnectionStatus, ConnectionState, getLastError } from "./rpc";

const FULL_ACCESS_SANDBOX_POLICY = { type: "dangerFullAccess" };
const FULL_ACCESS_APPROVAL_POLICY = "never";
const LIMITED_SANDBOX_POLICY = {
  type: "workspaceWrite",
  writableRoots: [],
  networkAccess: false,
};
const LIMITED_APPROVAL_POLICY = "on-failure";
const LOCAL_IMAGE_PATH_REGEX = /[A-Za-z]:\\[^\r\n"'<>|?*]+?\.(?:png|jpe?g|webp|bmp|gif)/gi;
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
};

export type Role = "user" | "assistant" | "system";

export type Message = {
  id: string;
  role: Role;
  content: string;
  image?: string;
  toolCalls?: ToolCall[];
};

export type ThinkingMessage = {
  id: string;
  content: string;
  done?: boolean;
};

export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
  status: "pending" | "approved" | "rejected";
  approvalId?: string;
  output?: string;
};

type ThreadReadItem = {
  id?: string;
  role?: string;
  type?: string;
  text?: unknown;
  content?: unknown;
};

type ThreadReadResponse = {
  thread?: {
    path?: string | null;
  };
  items?: ThreadReadItem[];
};

type HistoryItem = {
  id?: string;
  role?: Role | "thinking";
  content?: string;
};

type AppState = {
  threads: Thread[];
  currentThreadId: string | null;
  messages: Message[];
  thinkingMessages: ThinkingMessage[];
  streaming: string | null;
  isStreaming: boolean;
  fullAccess: boolean;
  connectionStatus: ConnectionState;
  connectionError: string | null;

  init: () => Promise<void>;
  createThread: (model?: string | null) => Promise<void>;
  switchThread: (id: string) => Promise<void>;
  sendMessage: (text: string, image?: string | null) => Promise<void>;
  approveToolCall: (toolCallId: string, approvalId?: string) => Promise<void>;
  rejectToolCall: (toolCallId: string, approvalId?: string) => Promise<void>;
  enableFullAccess: () => Promise<void>;
  disableFullAccess: () => Promise<void>;
  onNotification: (data: Record<string, unknown>) => void;
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

function extractLocalImagePaths(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(LOCAL_IMAGE_PATH_REGEX)) {
    const path = match[0].replace(TRAILING_PATH_PUNCTUATION_REGEX, "");
    const key = path.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      paths.push(path);
    }
  }

  return paths;
}

async function readLocalImageDataUrl(path: string): Promise<string | null> {
  try {
    const api = (window as any).CodexStressCed;
    const dataUrl = await api?.readLocalImage?.(path);
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

function notificationItemId(params: Record<string, unknown> | undefined): string {
  return stringValue(params?.itemId) || stringValue(params?.item_id);
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
  threads: [],
  currentThreadId: null,
  messages: [],
  thinkingMessages: [],
  streaming: null,
  isStreaming: false,
  fullAccess: false,
  connectionStatus: "connecting",
  connectionError: null,

  init: async () => {
    onConnectionStatus((status, message) => {
      set({
        connectionStatus: status,
        connectionError: status === "error" ? (message ?? null) : null,
        ...(status === "error" ? { isStreaming: false, streaming: null } : {}),
      });
    });

    onNotification((data) => {
      get().onNotification(data);
    });

    // Wait until app-server is actually connected before doing RPC.
    await new Promise<void>((resolve) => {
      let ok = false;
      const unsub = onConnectionStatus((s) => {
        if (s === "connected" && !ok) {
          ok = true;
          unsub();
          resolve();
        }
      });
      // Fallback: if we never see "connected", don't hang forever.
      setTimeout(() => { if (!ok) { unsub(); resolve(); } }, 12000);
    });

    try {
      console.log("[store] RPC thread/list");
      type ThreadListRaw = { id: string; name?: string | null; preview?: string | null; model_provider?: string; status?: { type: string } | string; updated_at?: number };
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
          model: t.model_provider || null,
          status: "idle",
          updatedAt: t.updated_at || Date.now(),
        };
      });
      set({ threads });
    } catch (err) {
      console.error("[store] thread/list failed:", err);
      set({ threads: [] });
    }
  },

  createThread: async (model) => {
    const status = get().connectionStatus;
    if (status !== "connected") {
      console.warn("[store] createThread: not connected, status:", status);
      set((s) => ({
        connectionError: "Not connected to app-server; cannot create thread."
      }));
      return;
    }

    // Try app-server first; on failure, create a local thread.
    try {
      console.log("[store] RPC thread/start", { model });
      const res = await rpc<{ thread: Thread }>("thread/start", {
        model: model ?? undefined,
      });
      console.log("[store] RPC thread/start response", res);
      const thread = res.thread;
      console.log("[store] createThread: setting threadId:", thread.id);
      writeStoredFullAccess(thread.id, false);
      set((s) => ({
        threads: [thread, ...s.threads],
        currentThreadId: thread.id,
        messages: [],
        thinkingMessages: [],
        fullAccess: false,
      }));
      console.log("[store] createThread: done, currentThreadId set to", thread.id);
      return;
    } catch (err) {
      console.error("[store] thread/start failed; creating local thread", err);
    }

    const thread: Thread = {
      id: nextId(),
      name: nextChatName(),
      model: model ?? null,
      status: "idle",
      updatedAt: Date.now(),
    };
    writeStoredFullAccess(thread.id, false);
    set((s) => ({
      threads: [thread, ...s.threads],
      currentThreadId: thread.id,
      messages: [],
      thinkingMessages: [],
      fullAccess: false,
    }));
  },

  switchThread: async (id) => {
    console.log("[store] switchThread START", id);
    const { threads, currentThreadId } = get();

    // If thread not in list, just select it with empty messages.
    const exists = threads.some((t) => t.id === id);
    const storedFullAccess = readStoredFullAccess(id);
    if (!exists) {
      console.log("[store] switchThread: thread not in list, selecting empty", id);
      set({ currentThreadId: id, messages: [], thinkingMessages: [], fullAccess: storedFullAccess });
      if (storedFullAccess) {
        applyAccessSettings(id, true).catch((err) => {
          console.error("[store] switchThread apply full access failed:", err);
        });
      }
      return;
    }

    // If already on this thread and streaming, do not reload.
    if (currentThreadId === id && get().isStreaming) {
      console.log("[store] switchThread: same thread + streaming, skip");
      return;
    }

    // Select the thread and clear messages.
    resetToolProgress();
    set({
      currentThreadId: id,
      messages: [],
      thinkingMessages: [],
      isStreaming: false,
      streaming: null,
      fullAccess: storedFullAccess,
    });

    let messages: Message[] = [];
    let thinkingMessages: ThinkingMessage[] = [];
    let threadInfo: { path?: string } | null = null;

    // First attempt: thread/resume + thread/read via RPC.
    try {
      console.log("[store] RPC thread/resume", id);
      await rpc("thread/resume", { threadId: id });
      console.log("[store] RPC thread/resume OK");

      if (storedFullAccess) {
        console.log("[store] RPC thread/settings/update full access after resume", id);
        await applyAccessSettings(id, true);
        console.log("[store] RPC thread/settings/update full access OK");
      }

      console.log("[store] RPC thread/read", id);
      const res = await rpc<ThreadReadResponse>("thread/read", { threadId: id });
      console.log("[store] RPC thread/read OK keys", Object.keys(res ?? {}));

      // Capture thread path for fallback.
      if (res && res.thread && res.thread.path) {
        threadInfo = { path: res.thread.path };
      }

      const items = Array.isArray(res?.items) ? res.items : [];
      console.log("[store] switchThread: items count", items.length);

      if (items.length > 0) {
        // Use RPC items.
        for (const it of items) {
          const role = it.role;
          const type = it.type;
          if (type === "userMessage" || role === "user") {
            const content = textFromContentParts(it.content ?? [], false);
            if (content.trim() && !isInternalHistoryMessageContent(content)) {
              messages.push({ id: it.id || "msg-" + messages.length, role: "user", content });
            }
          } else if (type === "agentMessage" || role === "assistant") {
            const content = stringValue(it.text) || textFromContentParts(it.content ?? [], true);
            if (content.trim() && !isInternalHistoryMessageContent(content)) {
              messages.push({ id: it.id || "msg-" + messages.length, role: "assistant", content });
            }
          } else if (type === "reasoning") {
            const content = thinkingTextFromItem(it);
            if (content) {
              thinkingMessages.push({ id: it.id || "thinking-" + thinkingMessages.length, content, done: true });
            }
          }
        }
      }
    } catch (rpcErr) {
      console.error("[store] RPC thread/load FAILED for", id, rpcErr);
    }

    // Fallback: if no messages from RPC, try reading the JSONL history file.
    if (threadInfo?.path) {
      try {
        console.log("[store] switchThread: using JSONL fallback", threadInfo.path);
        const api = (window as any).CodexStressCed;
        const history = await api?.readThreadHistory?.(threadInfo.path) as HistoryItem[] | undefined;
        if (Array.isArray(history) && history.length > 0) {
          console.log("[store] switchThread: JSONL history messages count", history.length);
          const historyMessages: Message[] = [];
          const historyThinkingMessages: ThinkingMessage[] = [];
          for (const h of history) {
            const content = stringValue(h.content);
            if (
              (h.role === "user" || h.role === "assistant") &&
              content &&
              !isInternalHistoryMessageContent(content)
            ) {
              historyMessages.push({
                id: h.id || "hist-msg-" + historyMessages.length,
                role: h.role,
                content,
              });
            } else if (h.role === "thinking" && content && !isInternalHistoryMessageContent(content)) {
              historyThinkingMessages.push({
                id: h.id || "hist-thinking-" + historyThinkingMessages.length,
                content,
                done: true,
              });
            }
          }
          if (historyMessages.length > messages.length) {
            messages = historyMessages;
          }
          if (historyThinkingMessages.length > thinkingMessages.length) {
            thinkingMessages = historyThinkingMessages;
          }
        }
      } catch (histErr) {
        console.error("[store] JSONL read failed", histErr);
      }
    }

    console.log("[store] switchThread: setting messages count", messages.length, "thinking count", thinkingMessages.length);
    set({ messages, thinkingMessages });
  },

  sendMessage: async (text, image) => {
    console.log("[store] sendMessage called with text:", text);
    const { currentThreadId, messages, connectionStatus, fullAccess } = get();
    console.log("[store] sendMessage state:", { currentThreadId, connectionStatus });
    if (!currentThreadId) {
      console.log("[store] sendMessage: no currentThreadId, returning");
      return;
    }
    if (connectionStatus !== "connected") {
      console.warn("[store] sendMessage: not connected, status:", connectionStatus);
      set((s) => ({
        isStreaming: false,
        streaming: null,
        connectionError: "Not connected to app-server; cannot send message."
      }));
      return;
    }

    const textImagePaths = extractLocalImagePaths(text);
    if (textImagePaths.length > 0) {
      console.log("[store] sendMessage detected local image paths:", textImagePaths);
    }

    const userMsg: Message = {
      id: nextId(),
      role: "user",
      content: text.trim(),
      image: image || undefined,
      toolCalls: [],
    };
    resetToolProgress();
    set({
      messages: [...messages, userMsg],
      streaming: "",
      isStreaming: true,
      connectionError: null,
    });

    try {
      if (fullAccess) {
        console.log("[store] RPC thread/settings/update full access before turn/start", currentThreadId);
        await applyAccessSettings(currentThreadId, true);
        console.log("[store] RPC thread/settings/update full access before turn/start OK");
      }

      const inputParts: Record<string, unknown>[] = [{ type: "text", text: text.trim() }];
      const includedLocalImages = new Set<string>();
      let embeddedLocalImageCount = 0;

      for (const path of textImagePaths) {
        includedLocalImages.add(path.toLowerCase());
        const dataUrl = await readLocalImageDataUrl(path);
        if (dataUrl) {
          inputParts.push({ type: "image", url: dataUrl, detail: "high" });
          embeddedLocalImageCount += 1;
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
            const dataUrl = await readLocalImageDataUrl(image);
            if (dataUrl) {
              inputParts.push({ type: "image", url: dataUrl, detail: "high" });
              embeddedLocalImageCount += 1;
            } else {
              inputParts.push({ type: "localImage", path: image, detail: "high" });
            }
          }
        }
      }

      console.log("[store] RPC turn/start", {
        threadId: currentThreadId,
        input: [{ type: "Text", text: text.trim() }],
        localImagePaths: textImagePaths,
        embeddedLocalImageCount,
      });
      const turnRes = await rpc<Record<string, unknown>>("turn/start", {
        threadId: currentThreadId,
        ...accessPolicyParams(fullAccess),
        input: inputParts,
      });
      console.log("[store] RPC turn/start response", turnRes);
    } catch (err) {
      console.error("[store] turn/start failed:", err);
      const msg = extractRpcError(err);
      console.log("[store] turn/start error message:", msg);
      set({
        isStreaming: false,
        streaming: null,
        connectionError: msg || "Error sending message",
      });
    }
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

    // Streaming text deltas: item/agentMessage/delta
    // AgentMessageDeltaNotification: { thread_id, turn_id, item_id, delta }
    if (method === "item/agentMessage/delta") {
      const p = params as { delta: string } | undefined;
      const text = p?.delta ?? "";
      if (!text) return;

      toolProgress.visibleAssistant = true;
      set((s) => {
        const next = (s.streaming ?? "") + text;
        const msgs = s.messages.map((m) => m);

        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant" && s.isStreaming) {
          // Update last assistant message immutably
          msgs[msgs.length - 1] = { ...last, content: next };
        } else {
          msgs.push({
            id: "stream-assistant",
            role: "assistant",
            content: next,
          });
        }

        return { streaming: next, messages: msgs };
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
      if (type === "reasoning") {
        set((s) => ({
          thinkingMessages: upsertCompletedThinkingItem(s.thinkingMessages, item),
        }));
        return;
      }
      if (!type || type === "agentMessage" || type === "userMessage") return;

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
      return;
    }

    // Turn completed: turn/completed
    // TurnCompletedNotification: { thread_id, turn: Turn }
    if (method === "turn/completed") {
      const turn = params?.turn as { status?: string; error?: { message?: string } } | undefined;
      const errorMessage = turn?.status === "failed" ? turn.error?.message : undefined;
      set((s) => {
        if (!s.isStreaming && s.streaming == null && !errorMessage) return s;
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
