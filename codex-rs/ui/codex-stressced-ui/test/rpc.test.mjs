import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './bundle.mjs';

test('renderer recovers missed ready events, shares subscription and ignores a stale status snapshot', async () => {
  let statusListener, resolveSnapshot, subscriptions = 0;
  globalThis.window = { CodexStressCed: {
    onConnectionStatus(fn) { subscriptions++; statusListener = fn; return () => {}; },
    getConnectionStatus: () => new Promise(resolve => { resolveSnapshot = resolve; }),
    connect: async () => ({ state: 'connected' }),
    rpc: async () => ({ __rpc_error: true, message: 'failure surfaced' }),
  } };
  const { onConnectionStatus, ensureConnected, getConnectionStatus, rpc } = await loadSource('../src/rpc.ts');
  const states = [];
  const unsubscribe = onConnectionStatus(state => states.push(state));
  onConnectionStatus(() => {});
  statusListener('error', 'lost transport');
  resolveSnapshot({ state: 'connected' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getConnectionStatus(), 'error');
  await ensureConnected();
  assert.equal(getConnectionStatus(), 'connected');
  assert.equal(subscriptions, 1);
  assert.deepEqual(states, ['connecting', 'error', 'connected']);
  await assert.rejects(rpc('thread/list'), /failure surfaced/);
  unsubscribe();
});
