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

const { ComposerActions } = await loadSource("../src/ComposerActions.tsx");
for (const [name, props] of Object.entries({
  idle: { busy: false, compacting: false, canSteer: false },
  active: { busy: true, compacting: false, canSteer: true },
  starting: { busy: true, compacting: false, canSteer: false },
  compacting: { busy: true, compacting: true, canSteer: true },
  disconnected: { busy: true, ready: false, canSteer: true },
})) {
  console.log(`composer-${name}: ${renderToStaticMarkup(React.createElement(ComposerActions, {
    sending: false, hasInput: true, ready: true, canSend: true,
    onSend() {}, onSteer() {}, onStop() {}, ...props,
  }))}`);
}
const { QueuePanelView } = await loadSource('../src/QueuePanel.tsx');
const { emptyRun } = await loadSource('../src/followups.ts');
for (const paused of [false, true]) {
  console.log(`queue-${paused ? 'paused' : 'waiting'}: ${renderToStaticMarkup(React.createElement(QueuePanelView, {
    threadId: 'preview', connected: true,
    run: { ...emptyRun, paused, queue: [{ id: 'one', text: 'Revisa los tests' }, { id: 'two', text: 'Compara la captura', image: 'data:image/png;base64,test' }] },
  }))}`);
}
