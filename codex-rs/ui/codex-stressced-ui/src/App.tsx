// src/App.tsx
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChatTranscript } from "./ChatTranscript";
import { C, composerColumnStyle } from "./theme";
import { ComposerActions } from "./ComposerActions";
import { QueuePanel } from "./QueuePanel";
import { useStore } from "./store";
import { ContextStatus } from "./ContextStatus";
import { WorkspaceControls } from "./WorkspaceControls";

const WORKSPACE_STORAGE_KEY = "codex-stressced-workspace";
const COMPUTER_USE_STORAGE_KEY = "codex-stressced-computer-use";

function getThreadLabel(t: any): string {
  if (t.preview && t.preview.trim().length > 0) return t.preview.trim();
  return t.name || "Chat";
}

export default function App() {
  const store = useStore(useShallow(({ messages, thinkingMessages, streaming, historyTurns, ...state }) => state));
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [showThinking, setShowThinking] = useState(false);
  const [workspacePath, setWorkspacePath] = useState(() => localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "");
  const [computerUse, setComputerUse] = useState(() => localStorage.getItem(COMPUTER_USE_STORAGE_KEY) === "true");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    store.init();
  }, []);

  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    const resize = () => {
      composer.style.height = "0px";
      const height = Math.min(240, Math.max(42, composer.scrollHeight));
      composer.style.height = `${height}px`;
      composer.style.overflowY = composer.scrollHeight > 240 ? "auto" : "hidden";
    };
    resize();
    let width = composer.clientWidth;
    const observer = new ResizeObserver(() => {
      if (composer.clientWidth !== width) { width = composer.clientWidth; resize(); }
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, [input]);

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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void handleSend(); }
  };

  const handleSend = async (mode: "queue" | "steer" = "queue") => {
    if (sendingRef.current || store.loadingHistory || !store.currentThreadId) return;
    const text = input.trim();
    const image = selectedImage;
    if (!text && !image) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      await store.sendMessage(text, image, mode);
      setInput(current => current.trim() === text ? "" : current);
      setSelectedImage(current => current === image ? null : current);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
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
  const isNotReady = store.connectionStatus !== "connected";
  const run = store.currentThreadId ? store.runs[store.currentThreadId] : undefined;

  /* ── Codex-exact palette ── */

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
          <ChatTranscript showThinking={showThinking} />
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

        {(statusError || sendError || isNotReady) && <div role="status" style={{ padding: "8px 24px", color: C.warn, fontSize: 12 }}>
          {sendError || statusError || "Connecting to app-server…"}
        </div>}
        {store.currentThreadId && <QueuePanel threadId={store.currentThreadId} />}

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

            <ComposerActions busy={store.isStreaming} compacting={store.compacting} sending={sending}
              hasInput={!!input.trim() || !!selectedImage} ready={!isNotReady} canSteer={!!run?.turnId}
              canSend={!store.loadingHistory && !!store.currentThreadId}
              onSend={() => void handleSend()} onSteer={() => void handleSend("steer")}
              onStop={() => void store.stopTurn()} />
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
