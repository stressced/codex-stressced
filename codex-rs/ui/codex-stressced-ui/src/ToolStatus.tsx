import React from "react";
import type { ToolCall } from "./history";

const labels: Record<ToolCall["status"], string> = {
  pending: "Pendiente de aprobación",
  running: "En curso",
  approved: "Permitido",
  rejected: "Rechazado",
  completed: "Completado",
  failed: "Falló",
};

export function ToolStatus({ status }: { status: ToolCall["status"] }) {
  const failed = status === "failed" || status === "rejected";
  return <span className={`tool-status${failed ? " tool-status-error" : ""}`}>{labels[status]}</span>;
}
