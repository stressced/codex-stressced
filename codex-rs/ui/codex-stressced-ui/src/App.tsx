// src/App.tsx
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import AssistantMessage, { assistantMessagePreserveWhitespace } from "@assistant-message";
import { useStore } from "./store";
import { ContextStatus } from "./ContextStatus";
import { ToolStatus } from "./ToolStatus";
import { WorkspaceControls } from "./WorkspaceControls";

const WORKSPACE_STORAGE_KEY = "codex-stressced-workspace";
const COMPUTER_USE_STORAGE_KEY = "codex-stressced-computer-use";

function getThreadLabel(t: any): string {
  if (t.preview && t.preview.trim().length > 0) return t.preview.trim();
  return t.name || "Chat";
}

function getLastUserMessageId(messages: Array<{ id: string; role: string }>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].id;
  }
  return null;
}

function isNearScrollBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 48;
}

export default function App() {
  const store = useStore();
  const [input, setInput] = useState("");
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [showThinking, setShowThinking] = useState(false);
  const [workspacePath, setWorkspacePath] = useState(() => localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "");
  const [computerUse, setComputerUse] = useState(() => localStorage.getItem(COMPUTER_USE_STORAGE_KEY) === "true");
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const previousThreadIdRef = useRef<string | null>(null);
  const previousViewRef = useRef(showThinking);
  const previousMainCountRef = useRef(0);
  const previousThinkingCountRef = useRef(0);
  const previousLastUserMessageIdRef = useRef<string | null>(null);
  const mainMessageCount = store.messages.length;
  const thinkingMessageCount = store.thinkingMessages.length;
  const lastMainMessage = store.messages[mainMessageCount - 1];
  const lastThinkingMessage = store.thinkingMessages[thinkingMessageCount - 1];
  const lastUserMessageId = getLastUserMessageId(store.messages);
  const scrollSignal = showThinking
    ? `${thinkingMessageCount}:${lastThinkingMessage?.content.length ?? 0}:${lastThinkingMessage?.done ? 1 : 0}`
    : `${mainMessageCount}:${lastMainMessage?.id ?? ""}:${lastMainMessage?.content.length ?? 0}:${store.isStreaming ? 1 : 0}`;

  const scrollToBottom = () => {
    const scrollElement = chatScrollRef.current;
    if (scrollElement) {
      scrollElement.scrollTop = scrollElement.scrollHeight;
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
  };

  useEffect(() => {
    store.init();
  }, []);

  // Force explicit navigation transitions to start at the bottom.
  useLayoutEffect(() => {
    const threadChanged = previousThreadIdRef.current !== store.currentThreadId;
    const viewChanged = previousViewRef.current !== showThinking;
    const activeMessageCount = showThinking ? thinkingMessageCount : mainMessageCount;
    const previousActiveMessageCount = showThinking
      ? previousThinkingCountRef.current
      : previousMainCountRef.current;
    const loadedHistory =
      !!store.currentThreadId &&
      !store.isStreaming &&
      activeMessageCount > 0 &&
      previousActiveMessageCount === 0;
    const userMessageAdded =
      !showThinking &&
      lastUserMessageId !== null &&
      lastUserMessageId !== previousLastUserMessageIdRef.current;

    if (threadChanged || viewChanged || loadedHistory || userMessageAdded) {
      autoScrollRef.current = true;
      scrollToBottom();
    }

    previousThreadIdRef.current = store.currentThreadId;
    previousViewRef.current = showThinking;
    previousMainCountRef.current = mainMessageCount;
    previousThinkingCountRef.current = thinkingMessageCount;
    previousLastUserMessageIdRef.current = lastUserMessageId;
  }, [
    store.currentThreadId,
    showThinking,
    mainMessageCount,
    thinkingMessageCount,
    lastUserMessageId,
    store.isStreaming,
  ]);

  // Follow streaming output only while the user is already at the bottom.
  useLayoutEffect(() => {
    if (!autoScrollRef.current) return;
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [scrollSignal]);

  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "0px";
    const height = Math.min(240, Math.max(42, composer.scrollHeight));
    composer.style.height = `${height}px`;
    composer.style.overflowY = composer.scrollHeight > 240 ? "auto" : "hidden";
  }, [input]);

  const handleChatScroll = (event: React.UIEvent<HTMLDivElement>) => {
    autoScrollRef.current = isNearScrollBottom(event.currentTarget);
  };

  const chooseWorkspace = async (): Promise<string | null> => {
    const selected = await window.CodexStressCed?.openWorkspaceDialog?.();
    if (!selected) return null;
    localStorage.setItem(WORKSPACE_STORAGE_KEY, selected);
    setWorkspacePath(selected);
    return selected;
  };

  const handleCreateThread = async () => {
    const cwd = workspacePath || await chooseWorkspace();
    if (!cwd) return;
    await store.createThread({ cwd, computerUse });
  };

  const handleToggleComputerUse = () => {
    const enabled = !computerUse;
    localStorage.setItem(COMPUTER_USE_STORAGE_KEY, String(enabled));
    setComputerUse(enabled);
  };

  // Ctrl+V image paste
  useEffect(() => {
    const api = (window as any).CodexStressCed;
    if (!api) return;
    const handler = async (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "v") {
        try {
          const dataUrl: string | null = await api.getPastedImage?.();
          if (dataUrl) setSelectedImage(dataUrl);
        } catch {}
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const before = input;
    const files = e.clipboardData.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const name = file.name || "";
        const lower = name.toLowerCase();
        const isImage = file.type.startsWith("image/") || /\.(png|jpg|jpeg|webp|bmp|gif|svg)$/.test(lower);
        const isTxt = lower.endsWith(".txt");
        if (isImage || isTxt) {
          e.preventDefault();
          if (isImage) {
            try {
              const base64 = await new Promise<string>((resolve, reject) => {
                const r = new FileReader(); r.onload = () => resolve(r.result as string); r.onerror = reject; r.readAsDataURL(file);
              });
              setSelectedImage(base64);
            } catch {}
          }
          if (isTxt) {
            try {
              const text = await new Promise<string>((resolve, reject) => {
                const r = new FileReader(); r.onload = () => resolve(r.result as string); r.onerror = reject; r.readAsText(file);
              });
              const maxLen = 3000;
              const content = text.length > maxLen ? text.substring(0, maxLen) + "\n[...truncated]" : text;
              setInput((before + "\n\n[Attached: " + file.name + "]\n" + content).trimStart());
            } catch {}
          }
          return;
        }
      }
    }
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type?.startsWith("image/")) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (!file) return;
        try {
          const base64 = await new Promise<string>((resolve, reject) => {
            const r = new FileReader(); r.onload = () => resolve(r.result as string); r.onerror = reject; r.readAsDataURL(file);
          });
          setSelectedImage(base64);
        } catch {}
        return;
      }
    }
  };

  const handleSelectImage = async () => {
    try {
      const path = await (window as any).CodexStressCed?.openImageDialog?.();
      if (path) setSelectedImage(path);
    } catch {}
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleSend = async () => {
    if (store.isStreaming || store.compacting || store.loadingHistory) return;
    const text = (input || "").trim();
    let image = selectedImage || null;
    if (!text && !image) return;
    setInput("");
    setSelectedImage(null);

    try { await store.sendMessage(text, image); } catch {}
  };

  const handlePrimaryAction = async () => {
    if (store.isStreaming) {
      try { await store.stopTurn(); } catch {}
      return;
    }
    await handleSend();
  };

  const handleToggleFullAccess = async () => {
    if (!store.currentThreadId) return;
    try {
      if (store.fullAccess) {
        await store.disableFullAccess();
      } else {
        await store.enableFullAccess();
      }
    } catch {
      // store restores the previous state on failure
    }
  };

  const connectionColor = (s: string) => {
    if (s === "connected") return "#22c55e";
    if (s === "connecting" || s === "closed") return "#eab308";
    if (s === "error") return "#ef4444";
    return "#6b7280";
  };

  const statusError = store.connectionError;
  const isNotReady = statusError !== null || store.connectionStatus === "error";

  /* ── Codex-exact palette ── */
  const C = {
    bgDeep:    "#1a1a1a",   // main background — matches Codex exactly
    bgSidebar: "#141414",
    bgSurface: "#252525",
    bgCard:    "#2a2a2a",
    border:    "rgba(255,255,255,0.08)",
    borderMed: "rgba(255,255,255,0.12)",
    text:      "#e4e4e7",
    textSec:   "#a1a1aa",
    textMuted: "#71717a",
    textDim:   "#52525b",
    accent:    "#22c55e",
    accentSoft:"rgba(34,197,94,0.12)",
    thinking:  "#F59E0B",
    danger:    "#ef4444",
    warn:      "#eab308",
  };
  const contentColumnStyle: React.CSSProperties = {
    width: "100%",
    maxWidth: 800,
    boxSizing: "border-box",
  };
  const composerColumnStyle: React.CSSProperties = {
    ...contentColumnStyle,
    transform: "translateX(-8px)",
  };

  return (
    <div style={{
      display: "grid", gridTemplateColumns: "260px minmax(0,1fr)",
      height: "100vh",
      fontFamily: "var(--font-sans)",
      color: C.text, background: C.bgDeep,
    }}>

      {/* ─── Sidebar ─── */}
      <aside style={{
        background: C.bgSidebar, borderRight: `1px solid ${C.border}`,
        padding: "12px 10px", display: "flex", flexDirection: "column", gap: 6, overflowY: "auto",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 2px" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Codex Stressced</span>
          <span style={{ fontSize: 10, display: "inline-flex", alignItems: "center", gap: 4, color: C.textMuted }}>
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: connectionColor(store.connectionStatus),
              boxShadow: `0 0 6px ${connectionColor(store.connectionStatus)}`,
            }} />
            {store.connectionStatus === "connected" ? "Connected" : store.connectionStatus === "connecting" ? "Connecting" : "Offline"}
          </span>
        </div>

        <WorkspaceControls
          workspacePath={workspacePath}
          computerUse={computerUse}
          onChooseWorkspace={() => { void chooseWorkspace(); }}
          onToggleComputerUse={handleToggleComputerUse}
        />

        <button onClick={() => { void handleCreateThread(); }} style={{
          width: "100%", padding: "8px 0", borderRadius: 8,
          border: `1px solid ${C.accent}`, background: C.accentSoft,
          color: C.accent, fontSize: 13, fontWeight: 600,
          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        }}>
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> New Chat
        </button>

        <div style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 4 }}>
          {store.threads.map((t) => {
            const active = t.id === store.currentThreadId;
            return (
              <div key={t.id} onClick={() => store.switchThread(t.id)} style={{
                padding: "7px 10px", borderRadius: 6, fontSize: 12,
                color: active ? C.text : C.textMuted,
                background: active ? C.bgSurface : "transparent",
                cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {getThreadLabel(t)}
              </div>
            );
          })}
        </div>

        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 10, color: C.textDim, padding: "6px 4px", borderTop: `1px solid ${C.border}` }}>
          Local-only · llama.cpp · No cloud
        </div>
      </aside>

      {/* ─── Main ─── */}
      <main style={{
        position: "relative", display: "flex", flexDirection: "column",
        overflow: "hidden", minHeight: 0, background: C.bgDeep,
      }}>
        {store.currentThreadId && <ContextStatus
          usage={store.contextUsage}
          compacting={store.compacting}
          disabled={store.isStreaming || store.loadingHistory || store.connectionStatus !== "connected"}
          onCompact={() => void store.compact()}
        />}
        {store.currentThreadId ? (
          /* ── Chat area ── */
          <div ref={chatScrollRef} className="chat-scroll" onScroll={handleChatScroll} style={{
            flex: "1 1 0%", minHeight: 0, overflowY: "auto",
            display: "flex", flexDirection: "column",
            padding: "20px 24px 12px",
          }}>
            {store.historyCursor && <button className="history-more" disabled={store.loadingHistory || store.isStreaming}
              onClick={async () => {
                const element = chatScrollRef.current;
                const height = element?.scrollHeight ?? 0;
                const top = element?.scrollTop ?? 0;
                await store.loadOlder();
                requestAnimationFrame(() => {
                  if (element) element.scrollTop = top + element.scrollHeight - height;
                });
              }}>Cargar mensajes anteriores</button>}
            {store.loadingHistory && <div role="status" className="history-status">Cargando historial…</div>}
            {showThinking && store.thinkingMessages.map((m) => (
              <div key={m.id} style={{
                ...contentColumnStyle, alignSelf: "center",
                marginBottom: 16,
              }}>
                <div style={{
                  padding: "12px 16px 12px 18px",
                  fontSize: 14, lineHeight: 1.7,
                  color: C.textSec,
                  borderLeft: `2px solid ${C.thinking}`,
                  background: "rgba(255,255,255,0.02)",
                  borderRadius: "0 8px 8px 0",
                  boxSizing: "border-box",
                  whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word",
                }}>
                  {m.content}
                </div>
              </div>
            ))}

            {!showThinking && store.messages.map((m, index) => {
              if (m.kind === "compaction") return <div key={m.id} className="history-status">{m.content}</div>;
              const isUser = m.role === "user";
              const isActiveAssistant =
                !isUser && store.isStreaming && index === store.messages.length - 1;
              return (
                <div key={m.id} style={{
                  ...contentColumnStyle, alignSelf: "center",
                  marginBottom: isUser ? 6 : 16,
                }}>
                  {isUser ? (
                    /* User: right-aligned bubble */
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <div style={{
                        padding: "10px 16px", borderRadius: 12,
                        fontSize: 14, lineHeight: 1.55,
                        background: C.bgCard, border: `1px solid ${C.borderMed}`,
                        color: C.text,
                        whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word",
                        maxWidth: "80%",
                      }}>
                        {m.content}
                        {m.images?.map((image, imageIndex) => <img key={imageIndex} src={image} alt="Imagen adjunta"
                          style={{ display: "block", marginTop: 8, maxWidth: "100%", maxHeight: 200, borderRadius: 8, objectFit: "contain" }} />)}
                        {m.image && (
                          <img src={m.image} alt="Attached" style={{
                            display: "block", marginTop: 8, maxWidth: "100%",
                            maxHeight: 200, borderRadius: 8, objectFit: "contain",
                          }} />
                        )}
                      </div>
                    </div>
                  ) : m.content ? (
                    /* Assistant: left-aligned, full-width within column, subtle left accent */
                    <div style={{
                      padding: "12px 16px 12px 18px",
                      fontSize: 14, lineHeight: 1.7,
                      color: C.text,
                      borderLeft: `2px solid ${isActiveAssistant ? C.thinking : C.accent}`,
                      background: "rgba(255,255,255,0.02)",
                      borderRadius: "0 8px 8px 0",
                      boxSizing: "border-box",
                      whiteSpace: assistantMessagePreserveWhitespace ? "pre-wrap" : undefined,
                      overflowWrap: "anywhere", wordBreak: "break-word",
                    }}>
                      <AssistantMessage content={m.content} streaming={isActiveAssistant} />
                    </div>
                  ) : null}

                  {/* Tool calls */}
                  {m.toolCalls && m.toolCalls.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                      {m.toolCalls.map((tc) => (
                        <div key={tc.id} style={{
                          padding: "8px 12px", borderRadius: 8, fontSize: 12,
                          background: C.bgSurface, border: `1px solid ${C.border}`,
                          display: "flex", flexDirection: "column", gap: 6,
                        }}>
                          <div style={{ color: C.textMuted, fontWeight: 500 }}>⚡ {tc.name}</div>
                          <div style={{
                            color: C.textDim, fontFamily: "var(--font-mono)",
                            fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
                            maxHeight: 160, overflowY: "auto",
                          }}>{typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input, null, 2)}</div>
                          {tc.output && <details><summary>{tc.status === "failed" ? "Error" : "Resultado"}</summary>
                            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 200, overflowY: "auto" }}>{tc.output}</pre>
                          </details>}
                          {tc.status === "pending" && (
                            <div style={{ display: "flex", gap: 6 }}>
                              <button onClick={() => store.approveToolCall(tc.id, tc.approvalId)} style={{
                                padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 500,
                                border: `1px solid ${C.accent}`, background: C.accentSoft, color: C.accent, cursor: "pointer",
                              }}>Allow</button>
                              <button onClick={() => store.rejectToolCall(tc.id, tc.approvalId)} style={{
                                padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 500,
                                border: `1px solid ${C.danger}`, background: "rgba(239,68,68,0.1)", color: C.danger, cursor: "pointer",
                              }}>Deny</button>
                            </div>
                          )}
                          <ToolStatus status={tc.status} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Streaming */}
            {store.isStreaming && (
              <div style={{
                ...contentColumnStyle, alignSelf: "center",
                padding: "6px 18px", fontSize: 12, color: C.textMuted,
                display: "flex", alignItems: "center", gap: 6,
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%", background: C.thinking,
                  boxShadow: `0 0 8px ${C.thinking}`,
                  animation: "pulse 1.2s ease-in-out infinite alternate",
                }} />
                Thinking...
              </div>
            )}

            {isNotReady && (
              <div style={{ ...contentColumnStyle, alignSelf: "center", fontSize: 12, color: C.danger, padding: "8px 4px" }}>
                App-server not reachable.{statusError && <> {statusError}</>}<br />
                Ensure codexstressced and llama.cpp are running.
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        ) : (
          /* ── Empty state with New Chat ── */
          <div style={{
            flex: "1 1 0%", display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", gap: 12,
          }}>
            <div style={{ fontSize: 24, fontWeight: 600, color: C.text }}>Codex Stressced</div>
            <div style={{ fontSize: 13, color: C.textMuted, maxWidth: 400, textAlign: "center", lineHeight: 1.5 }}>
              A local, self-contained Codex-style interface for llama.cpp.
            </div>
            <button onClick={() => { void handleCreateThread(); }} style={{
              marginTop: 8, padding: "10px 28px", borderRadius: 8,
              border: `1px solid ${C.accent}`, background: C.accentSoft,
              color: C.accent, fontSize: 14, fontWeight: 600,
              cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
            }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>+</span> New Chat
            </button>
          </div>
        )}

        {/* Image preview — above prompt, right-aligned */}
        {selectedImage && (
          <div style={{
            position: "absolute", bottom: 120, right: 32,
            maxWidth: 200, borderRadius: 10, border: `1px solid ${C.border}`,
            background: C.bgSurface, padding: 6, boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            display: "flex", flexDirection: "column", gap: 4, zIndex: 10,
          }}>
            <img src={selectedImage} alt="Selected" style={{ width: "100%", maxHeight: 140, objectFit: "contain", borderRadius: 8 }} />
            <div style={{ display: "flex", justifyContent: "flex-end", fontSize: 10 }}>
              <button onClick={() => setSelectedImage(null)} style={{
                padding: "2px 8px", fontSize: 10, borderRadius: 4,
                border: `1px solid ${C.border}`, background: C.bgSurface, color: C.textMuted, cursor: "pointer",
              }}>✕ Remove</button>
            </div>
          </div>
        )}

        {/* ── Input bar with Full Access inline ── */}
        <div style={{
          flexShrink: 0, padding: "12px 24px 16px",
          display: "flex", flexDirection: "column", alignItems: "center",
          background: C.bgDeep,
        }}>
          <div style={{
            ...composerColumnStyle,
            display: "flex", alignItems: "flex-end", gap: 8,
            background: C.bgSurface, border: `1px solid ${C.border}`,
            borderRadius: 14, padding: "8px 8px 8px 14px",
          }}>
            <button onClick={handleSelectImage} title="Attach image" style={{
              width: 32, height: 32, borderRadius: 6, border: "none",
              background: "transparent", color: C.textMuted, fontSize: 20,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", flexShrink: 0, alignSelf: "center",
            }}>+</button>

            <textarea
              ref={composerRef}
              style={{
                flex: 1, resize: "none", border: "none", background: "transparent",
                color: C.text, fontSize: 15, lineHeight: 1.5,
                height: 42, minHeight: 42, maxHeight: 240, overflowY: "hidden",
                outline: "none", padding: "10px 0",
              }}
              placeholder={isNotReady ? "App-server not connected..." : "Message Codex Stressced..."}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
              rows={1}
            />

            <button
              onClick={handlePrimaryAction}
              disabled={store.loadingHistory || (!store.isStreaming && store.compacting)}
              title={store.isStreaming ? "Stop" : "Send"}
              aria-label={store.isStreaming ? "Stop" : "Send"}
              style={{
              width: 36, height: 36, borderRadius: 10, border: "none",
              background: store.isStreaming ? C.text : input.trim() || selectedImage ? C.accent : C.bgCard,
              color: store.isStreaming ? C.bgDeep : input.trim() || selectedImage ? "#000" : C.textDim,
              fontSize: 18, fontWeight: 700,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", flexShrink: 0, transition: "background 0.15s",
            }}>{store.isStreaming ? "■" : "↑"}</button>
          </div>

          {/* Controls below prompt, left-aligned */}
          {store.currentThreadId && (
            <div style={{ ...composerColumnStyle, paddingTop: 6, display: "flex", justifyContent: "flex-start", gap: 8 }}>
              <button onClick={handleToggleFullAccess} style={{
                padding: "4px 10px", borderRadius: 6, whiteSpace: "nowrap",
                border: `1px solid rgba(234,179,8,0.3)`, background: "rgba(234,179,8,0.08)",
                color: C.warn, fontSize: 11, fontWeight: 500,
                display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer",
              }}>
                {store.fullAccess ? "✓ Full Access" : "⚡ Full Access"}
              </button>
              <button onClick={() => setShowThinking((v) => !v)} style={{
                padding: "4px 10px", borderRadius: 6, whiteSpace: "nowrap",
                border: showThinking ? `1px solid rgba(234,179,8,0.3)` : `1px solid ${C.borderMed}`,
                background: showThinking ? "rgba(234,179,8,0.08)" : "rgba(255,255,255,0.04)",
                color: showThinking ? C.warn : C.textMuted,
                fontSize: 11, fontWeight: 500,
                display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer",
              }}>
                Thinking
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
