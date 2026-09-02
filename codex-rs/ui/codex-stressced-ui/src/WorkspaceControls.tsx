import React from "react";

type WorkspaceControlsProps = {
  workspacePath: string;
  computerUse: boolean;
  disabled?: boolean;
  onChooseWorkspace: () => void;
  onToggleComputerUse: () => void;
};

export function WorkspaceControls({
  workspacePath,
  computerUse,
  disabled = false,
  onChooseWorkspace,
  onToggleComputerUse,
}: WorkspaceControlsProps) {
  const border = "rgba(255,255,255,0.10)";
  const muted = "#71717a";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button
        type="button"
        disabled={disabled}
        onClick={onChooseWorkspace}
        title={workspacePath || "Select the folder used as cwd for new chats"}
        style={{
          width: "100%", padding: "7px 9px", borderRadius: 7, border: `1px solid ${border}`,
          background: "rgba(255,255,255,0.035)", color: workspacePath ? "#a1a1aa" : muted,
          cursor: disabled ? "default" : "pointer", textAlign: "left", overflow: "hidden",
        }}
      >
        <span style={{ display: "block", fontSize: 10, color: muted, marginBottom: 2 }}>Workspace for new chats</span>
        <span style={{ display: "block", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {workspacePath || "Choose folder…"}
        </span>
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onToggleComputerUse}
        aria-pressed={computerUse}
        style={{
          width: "100%", padding: "6px 9px", borderRadius: 7,
          border: `1px solid ${computerUse ? "rgba(34,197,94,0.35)" : border}`,
          background: computerUse ? "rgba(34,197,94,0.10)" : "rgba(255,255,255,0.025)",
          color: computerUse ? "#22c55e" : muted, cursor: disabled ? "default" : "pointer",
          display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11,
        }}
      >
        <span>Computer use</span>
        <span>{computerUse ? "Enabled" : "Off"}</span>
      </button>
    </div>
  );
}
