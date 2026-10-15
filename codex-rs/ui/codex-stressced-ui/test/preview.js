// Isolated interactive fixture: no requests to a real app-server or model.
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App.tsx';
import { useStore } from '../src/store.ts';
import '../src/styles.css';
let listener = () => {};
let turn = 0;
let active = null;
let timer;
const calls = [];
const notify = (method, params) => listener({ method, params });
const finish = status => {
  if (!active) return;
  clearInterval(timer);
  const old = active; active = null;
  notify('item/completed', { threadId: 'preview', turnId: old.id, item: { type: 'agentMessage', id: old.item, text: old.text } });
  notify('turn/completed', { threadId: 'preview', turn: { id: old.id, status } });
};
const sample = ('### Prueba de streaming\n\nTexto continuo con **Markdown**, enlaces y acentos: información, visión.\n\n```ts\nconst saludo = "Hola mundo";\nconsole.log(saludo);\n```\n\n| Caso | Estado |\n| --- | --- |\n| Queue | Correcto |\n| Steer | Correcto |\n\n').repeat(30);
const stats = document.createElement('output');
stats.id = 'replay-stats'; stats.style = 'position:fixed;top:0;right:0;font-size:10px;color:#aaa;z-index:100;background:#111';
document.body.append(stats);
let commits = 0, totalMs = 0, maxMs = 0;
function start() {
  const id = `turn-${++turn}`;
  active = { id, item: `assistant-${turn}`, text: '' };
  commits = 0; totalMs = 0; maxMs = 0;
  notify('turn/started', { threadId: 'preview', turn: { id } });
  const started = performance.now();
  timer = setInterval(() => {
    if (!active) return;
    const delta = sample.slice(active.text.length, active.text.length + 12);
    if (!delta) { finish('completed'); return; }
    active.text += delta;
    notify('item/agentMessage/delta', { threadId: 'preview', turnId: id, itemId: active.item, delta });
    stats.textContent = `renders ${commits} · mean ${(totalMs / Math.max(commits, 1)).toFixed(1)}ms · max ${maxMs.toFixed(1)}ms · ${((performance.now() - started) / 1000).toFixed(1)}s · requests ${calls.length}`;
  }, 10);
  return { turn: { id } };
}
window.CodexStressCed = {
  getConnectionStatus: async () => ({ state: 'connected' }),
  connect: async () => ({ state: 'connected' }),
  onNotification: fn => { listener = fn; return () => {}; },
  onConnectionStatus: () => () => {},
  openImageDialog: async () => null,
  getPastedImage: async () => null,
  rpc: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/list') return { data: [{ id: 'preview', name: 'Queue / Steer / Streaming', status: { type: active ? 'active' : 'idle' }, cwd: 'D:\\fixture' }] };
    if (method === 'thread/resume') return { thread: { id: 'preview', status: { type: active ? 'active' : 'idle' } } };
    if (method === 'thread/turns/list') return { data: [], nextCursor: null };
    if (method === 'turn/start') return start();
    if (method === 'turn/steer') {
      if (!active || active.id !== params.expectedTurnId) throw new Error('Turn changed');
      return { turnId: active.id };
    }
    if (method === 'turn/interrupt') { finish('interrupted'); return {}; }
    return {};
  },
};
useStore.setState({ currentThreadId: 'preview' });
createRoot(document.getElementById('root')).render(React.createElement(React.Profiler, {
  id: 'app', onRender: (_id, _phase, duration) => { commits++; totalMs += duration; maxMs = Math.max(maxMs, duration); },
}, React.createElement(App)));
