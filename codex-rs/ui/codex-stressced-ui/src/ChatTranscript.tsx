import React, { useLayoutEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import AssistantMessage, { assistantMessagePreserveWhitespace } from "@assistant-message";
import { useStore, type Message } from "./store";
import { ToolStatus } from "./ToolStatus";
import { C, contentColumnStyle } from "./theme";

function getLastUserMessageId(messages: Array<{ id: string; role: string }>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].id;
  }
  return null;
}

function isNearScrollBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 48;
}

const MessageRow = React.memo(function MessageRow({ m, streaming }: { m: Message; streaming: boolean }) {
  if (m.kind === "compaction") return <div key={m.id} className="history-status">{m.content}</div>;
  const isUser = m.role === "user";
  const isActiveAssistant =
    !isUser && streaming;
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
                  <button onClick={() => useStore.getState().approveToolCall(tc.id, tc.approvalId)} style={{
                    padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 500,
                    border: `1px solid ${C.accent}`, background: C.accentSoft, color: C.accent, cursor: "pointer",
                  }}>Allow</button>
                  <button onClick={() => useStore.getState().rejectToolCall(tc.id, tc.approvalId)} style={{
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

});

export const ChatTranscript = React.memo(function ChatTranscript({ showThinking }: { showThinking: boolean }) {
  const store = useStore(useShallow(s => ({
    messages: s.messages, thinkingMessages: s.thinkingMessages, currentThreadId: s.currentThreadId,
    isStreaming: s.isStreaming, historyCursor: s.historyCursor, loadingHistory: s.loadingHistory,
    loadOlder: s.loadOlder,
  })));
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const previousThreadIdRef = useRef<string | null>(null);
  const previousViewRef = useRef(showThinking);
  const previousMainCountRef = useRef(0);
  const previousThinkingCountRef = useRef(0);
  const previousLastUserMessageIdRef = useRef<string | null>(null);
  const mainMessageCount = store.messages.length;
  const thinkingMessageCount = store.thinkingMessages.length;
  const lastMainMessage = store.messages.findLast(message => message.role === "assistant") ?? store.messages[mainMessageCount - 1];
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
    // Deltas already commit on an animation frame. Scroll after that DOM commit,
    // before paint, rather than lagging one more frame behind the text.
    scrollToBottom();
  }, [scrollSignal]);

  const handleChatScroll = (event: React.UIEvent<HTMLDivElement>) => {
    autoScrollRef.current = isNearScrollBottom(event.currentTarget);
  };


  return (
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

            {!showThinking && store.messages.map(m => (
              <MessageRow key={m.id} m={m} streaming={store.isStreaming && m.id === lastMainMessage?.id} />
            ))}

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

            <div ref={messagesEndRef} />
          </div>
  );
});
