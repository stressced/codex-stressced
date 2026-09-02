import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadSource } from "./bundle.mjs";

const { ContextStatus } = await loadSource("../src/ContextStatus.tsx");
const { ToolStatus } = await loadSource("../src/ToolStatus.tsx");
const { WorkspaceControls } = await loadSource("../src/WorkspaceControls.tsx");
for (const [name, props] of Object.entries({
  pending: { usage: null, compacting: false, disabled: false },
  local: { usage: { used: 80000, window: 131000 }, compacting: false, disabled: false },
  compacting: { usage: { used: 80000, window: 131000 }, compacting: true, disabled: false },
  running: { usage: { used: 16000, window: null }, compacting: false, disabled: true },
})) {
  console.log(`${name}: ${renderToStaticMarkup(React.createElement(ContextStatus, { ...props, onCompact() {} }))}`);
}
for (const status of ["pending", "running", "approved", "rejected", "completed", "failed"]) {
  console.log(`${status}: ${renderToStaticMarkup(React.createElement(ToolStatus, { status }))}`);
}
console.log(`workspace-empty: ${renderToStaticMarkup(React.createElement(WorkspaceControls, {
  workspacePath: "", computerUse: false, onChooseWorkspace() {}, onToggleComputerUse() {},
}))}`);
console.log(`workspace-enabled: ${renderToStaticMarkup(React.createElement(WorkspaceControls, {
  workspacePath: "D:\\\\qwenst1", computerUse: true, onChooseWorkspace() {}, onToggleComputerUse() {},
}))}`);
