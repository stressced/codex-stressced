import type React from "react";
export const C = {
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
export const contentColumnStyle: React.CSSProperties = {
    width: "100%",
    maxWidth: 800,
    boxSizing: "border-box",
  };
export const composerColumnStyle: React.CSSProperties = {
    ...contentColumnStyle,
    transform: "translateX(-8px)",
  };
