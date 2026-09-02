// Isolated, local fixture: no app-server or model requests are made.
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App.tsx";
import { useStore } from "../src/store.ts";
import "../src/styles.css";

const notify = (method, params) => useStore.getState().onNotification({ method, params });
window.CodexStressCed = {
  onNotification: () => () => {},
  onConnectionStatus: fn => { queueMicrotask(() => fn("connected")); return () => {}; },
  openImageDialog: async () => null,
  getPastedImage: async () => null,
  rpc: async method => {
    if (method === "thread/list") return { data: [{ id: "preview", name: "Prueba local de historial" }] };
    if (method === "thread/turns/list") return { data: [{ id: "old", items: [{ id: "old-user", type: "userMessage", content: [{ type: "text", text: "Mensaje anterior recuperado." }] }] }], nextCursor: null };
    if (method === "thread/compact/start") {
      setTimeout(() => {
        notify("item/completed", { threadId: "preview", turnId: "compact", item: { id: "compact-new", type: "contextCompaction" } });
        notify("thread/tokenUsage/updated", { threadId: "preview", tokenUsage: { last: { totalTokens: 16000 }, modelContextWindow: 131000 } });
        notify("turn/completed", { threadId: "preview", turn: { status: "completed" } });
      }, 1500);
    }
    return {};
  },
};
useStore.setState({ currentThreadId: "preview", contextUsage: { used: 80000, window: 131000 }, historyCursor: "older", messages: [
  { id: "u", role: "user", content: "Conserva mis restricciones al compactar y responde en español." },
  { id: "c", role: "system", content: "Contexto compactado", kind: "compaction" },
  { id: "a", role: "assistant", content: "El historial sigue disponible. El contexto activo contiene el resumen y las instrucciones vigentes." },
  { id: "s", role: "assistant", content: "", toolCalls: [{ id: "s", name: "Subagente: spawnAgent", status: "completed", input: "Revisar la implementación local", output: '{"threads":["child-1"],"model":"local-qwen"}' }] },
] });
createRoot(document.getElementById("root")).render(React.createElement(App));
