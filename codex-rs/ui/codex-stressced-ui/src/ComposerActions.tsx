import React from "react";
import "./queue.css";

export function ComposerActions({ busy, compacting, sending, hasInput, ready, canSteer, canSend, onSend, onSteer, onStop }: {
  busy: boolean; compacting: boolean; sending: boolean; hasInput: boolean;
  ready: boolean; canSteer: boolean; canSend: boolean;
  onSend: () => void; onSteer: () => void; onStop: () => void;
}) {
  return <>
    {busy && <>
      <button onClick={onSteer} disabled={sending || !hasInput || !canSteer || compacting || !ready}
        title="Guide the active turn at its next model request" className="followup-button">Steer</button>
      <button onClick={onStop} disabled={!ready} title="Stop and pause queue" aria-label="Stop" className="followup-button">■</button>
    </>}
    <button onClick={onSend} className="followup-button send-button" disabled={sending || !canSend || !hasInput}
      title={busy || compacting ? "Queue" : "Send"} aria-label={busy || compacting ? "Queue" : "Send"}>
      {busy || compacting ? "Queue" : "↑"}
    </button>
  </>;
}
