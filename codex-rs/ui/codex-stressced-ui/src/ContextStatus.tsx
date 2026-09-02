import React from "react";

export type ContextUsage = { used: number; window: number | null };

export function ContextStatus({ usage, compacting, disabled, onCompact }: {
  usage: ContextUsage | null;
  compacting: boolean;
  disabled: boolean;
  onCompact: () => void;
}) {
  const percent = usage?.window ? Math.min(100, Math.round(usage.used / usage.window * 100)) : null;
  const label = compacting ? "Compactando contexto…" : usage
    ? `Contexto: ${usage.used.toLocaleString("es-MX")}${usage.window ? ` / ${usage.window.toLocaleString("es-MX")}` : ""} tokens${percent === null ? "" : ` (${percent}%)`}`
    : "Contexto: pendiente de uso";
  return <div className="context-status">
    <span role="status" aria-live="polite">{label}</span>
    <button type="button" disabled={disabled || compacting} onClick={onCompact}>Compactar</button>
  </div>;
}
