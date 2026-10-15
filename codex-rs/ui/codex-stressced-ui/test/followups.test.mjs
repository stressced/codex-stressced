import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './bundle.mjs';
const { Followups, emptyRun } = await loadSource('../src/followups.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(send) {
  const runs = {};
  const calls = [];
  let connected = true;
  const queue = new Followups({
    get: id => runs[id] ?? emptyRun,
    set: (id, state) => { runs[id] = state; },
    connected: () => connected,
    send: async (...args) => { calls.push(args); return send ? send(...args) : `turn-${calls.length}`; },
    interrupt: async (...args) => { calls.push(['interrupt', ...args]); },
  });
  return { queue, calls, runs, offline: () => { connected = false; } };
}
const prompt = (id, image) => ({ id, text: id, image });

test('FIFO queue preserves images, edits and thread isolation', async () => {
  const { queue, calls, runs } = fixture();
  queue.started('a', 'active');
  await queue.submit('a', prompt('one', 'data:image/png;base64,FULL'), 'queue');
  await queue.submit('a', prompt('two'), 'queue');
  await queue.submit('a', prompt('remove'), 'queue');
  queue.edit('a', 'two', 'edited');
  queue.remove('a', 'remove');
  assert.equal(calls.length, 0);
  await queue.submit('b', prompt('other'), 'queue');
  queue.completed('a', 'active', 'completed');
  await tick();
  assert.deepEqual(calls.map(c => [c[0], c[1].text]), [['b', 'other'], ['a', 'one']]);
  assert.equal(calls[1][1].image, 'data:image/png;base64,FULL');
  queue.completed('a', 'turn-2', 'completed');
  await tick();
  assert.equal(calls[2][1].text, 'edited');
  assert.deepEqual(runs.a.queue, []);
});

test('steer targets the same turn without starting or interrupting it', async () => {
  const { queue, calls, runs } = fixture();
  queue.started('a', 'active');
  await queue.submit('a', prompt('guide'), 'steer');
  assert.deepEqual(calls, [['a', prompt('guide'), 'active']]);
  assert.equal(runs.a.turnId, 'active');
});

test('stop pauses queued work even if completion races the interrupt', async () => {
  const { queue, calls, runs } = fixture();
  queue.started('a', 'active');
  await queue.submit('a', prompt('later'), 'queue');
  await queue.stop('a');
  queue.completed('a', 'active', 'completed');
  await tick();
  assert.deepEqual(calls, [['interrupt', 'a', 'active']]);
  assert.equal(runs.a.queue.length, 1);
  await queue.resume('a');
  assert.equal(calls[1][1].text, 'later');
});

test('completion before start response and duplicate completion do not start concurrent turns', async () => {
  let accept;
  const { queue, calls, runs } = fixture(() => new Promise(resolve => { accept = resolve; }));
  const sending = queue.submit('a', prompt('one'), 'queue');
  await queue.submit('a', prompt('two'), 'queue');
  queue.started('a', 'first');
  queue.completed('a', 'first', 'completed');
  accept('first');
  await sending;
  await tick();
  assert.equal(calls.length, 2);
  queue.completed('a', 'first', 'completed');
  await queue.submit('a', prompt('three'), 'queue');
  await tick();
  assert.equal(calls.length, 2);
  accept('second');
  await tick();
  assert.equal(runs.a.turnId, 'second');
});

test('uncertain delivery and disconnect retain prompts without automatic replay', async () => {
  const { queue, runs, calls } = fixture(() => { throw new Error('transport lost'); });
  await queue.submit('a', prompt('once'), 'queue');
  assert.equal(runs.a.paused, true);
  assert.equal(runs.a.queue.length, 1);
  queue.reconcile('a', false, null);
  await queue.drain('a');
  assert.equal(calls.length, 1);
});

test('manual compaction defers queue and rejects steer without consuming the prompt', async () => {
  const { queue, runs, calls } = fixture();
  queue.compacting('a', true);
  await queue.submit('a', prompt('after'), 'queue');
  queue.started('a', 'compact');
  await assert.rejects(queue.submit('a', prompt('steer'), 'steer'), /unavailable/);
  assert.equal(calls.length, 0);
  queue.completed('a', 'compact', 'completed');
  await tick();
  assert.equal(calls[0][1].text, 'after');
  assert.equal(runs.a.queue.length, 0);
});

test('stopping during start waits for the id and interrupts without sending the queue', async () => {
  let accept;
  const { queue, calls, runs } = fixture(() => new Promise(resolve => { accept = resolve; }));
  const first = queue.submit('a', prompt('one'), 'queue');
  await queue.stop('a');
  await queue.submit('a', prompt('two'), 'queue');
  accept('turn-new');
  await first;
  assert.deepEqual(calls[1], ['interrupt', 'a', 'turn-new']);
  assert.equal(runs.a.queue[0].text, 'two');
});

test('messages composed offline expose a paused queue instead of silently stalling', async () => {
  const { queue, runs, calls, offline } = fixture();
  offline();
  await queue.submit('a', prompt('offline draft'), 'queue');
  assert.equal(runs.a.paused, true);
  assert.equal(runs.a.queue[0].text, 'offline draft');
  assert.equal(calls.length, 0);
});

test('a disconnected queue is paused without interrupting an accepted active turn', async () => {
  let accept;
  const { queue, calls, runs } = fixture(() => new Promise(resolve => { accept = resolve; }));
  const first = queue.submit('a', prompt('one'), 'queue');
  queue.started('a', 'active');
  queue.disconnected('a');
  accept('active');
  await first;
  assert.equal(calls.length, 1);
  assert.equal(runs.a.busy, true);
  assert.equal(runs.a.paused, true);
});
