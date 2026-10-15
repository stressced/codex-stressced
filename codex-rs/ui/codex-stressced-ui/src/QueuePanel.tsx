import React, { useState } from "react";
import { useStore } from "./store";
import { emptyRun, type ConversationRun, type Prompt } from "./followups";
import "./queue.css";

function QueuedPrompt({ prompt, threadId, locked }: { prompt: Prompt; threadId: string; locked: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(prompt.text);
  return <li>
    {editing ? <textarea aria-label="Edit queued message" value={text} onChange={event => setText(event.target.value)} />
      : <span className="queued-text">{prompt.text || "Image"}{prompt.image && " · 📎"}</span>}
    {editing ? <button className="followup-button" disabled={locked || !text.trim() && !prompt.image}
      onClick={() => { useStore.getState().editQueued(threadId, prompt.id, text); setEditing(false); }}>Save</button>
      : <button className="followup-button" disabled={locked} onClick={() => { setText(prompt.text); setEditing(true); }}>Edit</button>}
    <button className="followup-button" disabled={locked} aria-label="Remove queued message"
      onClick={() => useStore.getState().removeQueued(threadId, prompt.id)}>×</button>
  </li>;
}

export const QueuePanel = React.memo(function QueuePanel({ threadId }: { threadId: string }) {
  const run = useStore(state => state.runs[threadId] ?? emptyRun);
  const connected = useStore(state => state.connectionStatus === "connected");
  return <QueuePanelView threadId={threadId} run={run} connected={connected} />;
});

export function QueuePanelView({ threadId, run, connected }: { threadId: string; run: ConversationRun; connected: boolean }) {
  if (!run.queue.length) return null;
  return <section className="queue-panel" aria-label="Queued messages">
    <div className="queue-heading"><span>Queue · {run.queue.length}{run.paused ? " · Paused" : ""}</span>
      {run.paused && <button className="followup-button" disabled={!connected || run.sending || run.compacting}
        onClick={() => void useStore.getState().resumeQueue(threadId)}>Resume queue</button>}
    </div>
    {run.error && <p role="alert">{run.error} Check the conversation before retrying.</p>}
    <ol>{run.queue.map((prompt, index) => <QueuedPrompt key={prompt.id} prompt={prompt} threadId={threadId}
      locked={run.sending && index === 0} />)}</ol>
  </section>;
}
