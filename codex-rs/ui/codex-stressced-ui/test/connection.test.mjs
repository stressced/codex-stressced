import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './bundle.mjs';
const { AppServerConnection } = await loadSource('../electron/connection.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const sockets = [], states = [], notifications = [];
  const connection = new AppServerConnection({
    endpoint: async () => 'ws://local/rpc',
    socket: () => {
      const socket = { readyState: 0, sent: [], send(text) { this.sent.push(JSON.parse(text)); },
        close() { this.readyState = 3; this.onclose?.({}); },
        open() { this.readyState = 1; this.onopen(); },
        reply(id, result, error) { this.onmessage({ data: JSON.stringify({ id, result, error }) }); },
      };
      sockets.push(socket); return socket;
    },
    status: (state, message) => states.push({ state, message }),
    notification: message => notifications.push(message),
    tool: async () => ({}),
    retryMs: 5, connectTimeoutMs: 200,
    ...options,
  });
  return { connection, sockets, states, notifications };
}

test('concurrent RPCs wait for a single initialized socket', async t => {
  const { connection, sockets, states } = fixture();
  t.after(() => connection.close());
  const list = connection.request('thread/list');
  const read = connection.request('thread/read');
  await tick();
  assert.equal(sockets.length, 1);
  sockets[0].open();
  assert.deepEqual(sockets[0].sent.map(m => m.method), ['initialize']);
  assert.equal(states.some(s => s.state === 'connected'), false);
  sockets[0].reply(sockets[0].sent[0].id, {});
  await tick();
  assert.deepEqual(sockets[0].sent.map(m => m.method), ['initialize', 'initialized', 'thread/list', 'thread/read']);
  for (const request of sockets[0].sent.slice(2)) sockets[0].reply(request.id, { method: request.method });
  assert.deepEqual(await Promise.all([list, read]), [{ method: 'thread/list' }, { method: 'thread/read' }]);
});

test('failed handshake never publishes connected and retries automatically', async t => {
  const { connection, sockets, states } = fixture();
  t.after(() => connection.close());
  const attempt = connection.connect();
  const rejected = assert.rejects(attempt, /denied/);
  await tick(); sockets[0].open();
  sockets[0].reply(sockets[0].sent[0].id, undefined, { message: 'denied' });
  await rejected;
  assert.equal(states.some(s => s.state === 'connected'), false);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(sockets.length, 2);
  sockets[1].open(); sockets[1].reply(sockets[1].sent[0].id, {});
  await tick();
  assert.equal(connection.status.state, 'connected');
});

test('disconnect rejects pending mutation immediately, reconnects without replay and ignores old socket', async t => {
  const { connection, sockets, notifications } = fixture();
  t.after(() => connection.close());
  const connected = connection.connect();
  await tick(); sockets[0].open(); sockets[0].reply(sockets[0].sent[0].id, {});
  await connected;
  const pending = connection.request('turn/start');
  const rejected = assert.rejects(pending, /disconnected/);
  await tick(); sockets[0].close(); await rejected;
  await new Promise(resolve => setTimeout(resolve, 15));
  sockets[1].open(); sockets[1].reply(sockets[1].sent[0].id, {});
  await tick();
  assert.deepEqual(sockets[1].sent.map(m => m.method), ['initialize', 'initialized']);
  sockets[0].onmessage({ data: JSON.stringify({ method: 'turn/completed' }) });
  assert.deepEqual(notifications, []);
});

test('connect timeout releases the single-flight lock', async t => {
  const { connection, sockets } = fixture({ connectTimeoutMs: 10, retryMs: 1000 });
  t.after(() => connection.close());
  await assert.rejects(connection.connect(), /timed out/);
  const retry = connection.connect();
  await tick();
  assert.equal(sockets.length, 2);
  sockets[1].open(); sockets[1].reply(sockets[1].sent[0].id, {});
  await retry;
});
