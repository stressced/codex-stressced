import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./bundle.mjs";

let handler;
let imageHandler;
globalThis.window = {
  CodexStressCed: {
    rpc: (...args) => handler(...args),
    readLocalImage: (...args) => imageHandler?.(...args),
  },
  localStorage: { getItem: () => null, setItem() {} },
};
const { extractLocalImagePaths, useStore: store } = await loadSource("../src/store.ts");
const initial = store.getState();
const reset = () => {
  imageHandler = undefined;
  store.setState({ ...initial, connectionStatus: "connected", currentThreadId: "parent" });
};
const notify = (method, params) => store.getState().onNotification({ method, params });

test("child output and completion cannot overwrite or stop the parent", () => {
  reset();
  store.setState({ messages: [{ id: "previous", role: "assistant", content: "saved" }], isStreaming: true });
  notify("item/agentMessage/delta", { threadId: "child", itemId: "x", delta: "foreign" });
  notify("turn/completed", { threadId: "child", turn: { status: "completed" } });
  assert.equal(store.getState().isStreaming, true);
  notify("item/agentMessage/delta", { threadId: "parent", itemId: "new", delta: "hello" });
  notify("item/completed", { threadId: "parent", turnId: "t", item: { id: "new", type: "agentMessage", text: "hello!" } });
  assert.deepEqual(store.getState().messages, [{ id: "previous", role: "assistant", content: "saved" }, { id: "new", role: "assistant", content: "hello!" }]);
});

test("rapid session switching ignores a late history response", async () => {
  reset();
  let resolveOld;
  handler = async (method, params) => {
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (params.threadId === "old") return new Promise(resolve => { resolveOld = resolve; });
    return { data: [{ id: "t", items: [{ id: "a", type: "agentMessage", text: "new session" }] }], nextCursor: null };
  };
  const old = store.getState().switchThread("old");
  await new Promise(resolve => setImmediate(resolve));
  await store.getState().switchThread("new");
  resolveOld({ data: [{ id: "old", items: [{ id: "old-a", type: "agentMessage", text: "stale" }] }], nextCursor: null });
  await old;
  assert.equal(store.getState().currentThreadId, "new");
  assert.deepEqual(store.getState().messages.map(m => m.content), ["new session"]);
});

test("manual compaction waits for lifecycle completion and prevents duplicate requests", async () => {
  reset();
  const calls = [];
  handler = async (...args) => { calls.push(args); return {}; };
  await store.getState().compact();
  await store.getState().compact();
  await store.getState().sendMessage("wait");
  assert.deepEqual(calls, [["thread/compact/start", { threadId: "parent" }]]);
  assert.equal(store.getState().compacting, true);
  notify("thread/tokenUsage/updated", { threadId: "parent", tokenUsage: { last: { totalTokens: 81000 }, modelContextWindow: 131000 } });
  assert.deepEqual(store.getState().contextUsage, { used: 81000, window: 131000 });
  notify("turn/completed", { threadId: "parent", turn: { status: "completed" } });
  assert.equal(store.getState().compacting, false);
});

test("stop interrupts the active turn and waits for completion", async () => {
  reset();
  const calls = [];
  handler = async (...args) => { calls.push(args); return {}; };
  notify("turn/started", { threadId: "parent", turn: { id: "turn-active" } });

  await store.getState().stopTurn();

  assert.deepEqual(calls, [["turn/interrupt", { threadId: "parent", turnId: "turn-active" }]]);
  assert.equal(store.getState().isStreaming, true);
  notify("turn/completed", { threadId: "parent", turn: { status: "interrupted" } });
  assert.equal(store.getState().isStreaming, false);
});

test("failed thread creation does not invent a usable local session", async () => {
  reset();
  handler = async () => { throw new Error("offline"); };
  await store.getState().createThread();
  assert.equal(store.getState().currentThreadId, "parent");
  assert.equal(store.getState().connectionError, "offline");
});

test("thread creation sends cwd and only exposes computer use when enabled", async () => {
  reset();
  const calls = [];
  handler = async (...args) => {
    calls.push(args);
    return { thread: { id: "created", name: "Created", model: null, status: "idle", updatedAt: 1 } };
  };
  await store.getState().createThread({ cwd: "D:\\qwenst1", computerUse: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "thread/start");
  assert.equal(calls[0][1].cwd, "D:\\qwenst1");
  assert.equal(calls[0][1].dynamicTools.length, 1);
  assert.equal(calls[0][1].dynamicTools[0].name, "computer");
  assert.match(calls[0][1].dynamicTools[0].description, /explicitly asks/);
  assert.equal(store.getState().threads[0].cwd, "D:\\qwenst1");
});

test("image references accept absolute, relative, and quoted paths without duplicates", () => {
  assert.deepEqual(
    extractLocalImagePaths('compara D:\\captura.png con .\\shots\\otra.webp y "capturas\\con espacio.jpg"; usa captura.png'),
    ["D:\\captura.png", ".\\shots\\otra.webp", "capturas\\con espacio.jpg", "captura.png"],
  );
});

test("relative image paths use the thread cwd and preserve the returned data URL", async () => {
  reset();
  const calls = [];
  const imageCalls = [];
  const original = "data:image/png;base64,ORIGINAL_FULL_RESOLUTION_BYTES";
  store.setState({ threads: [{ id: "parent", name: "Parent", model: null, status: "idle", updatedAt: 1, cwd: "D:\\workspace" }] });
  imageHandler = async (...args) => {
    imageCalls.push(args);
    return original;
  };
  handler = async (...args) => {
    calls.push(args);
    return { turn: { id: "turn-image" } };
  };

  await store.getState().sendMessage("revisa captura.png");

  assert.deepEqual(imageCalls, [["captura.png", "D:\\workspace"]]);
  assert.equal(calls[0][0], "turn/start");
  assert.deepEqual(calls[0][1].input[1], { type: "image", url: original, detail: "high" });
});

test("pasted image data URLs reach turn/start byte-for-byte", async () => {
  reset();
  const calls = [];
  const original = "data:image/png;base64,PASTED_ORIGINAL_BYTES";
  handler = async (...args) => {
    calls.push(args);
    return { turn: { id: "turn-paste" } };
  };

  await store.getState().sendMessage("captura pegada", original);

  assert.deepEqual(calls[0][1].input[1], { type: "image", url: original, detail: "high" });
});

test("tool completion replaces an approval card without duplicating it", () => {
  reset();
  store.setState({ messages: [{ id: "a", role: "assistant", content: "running", toolCalls: [{ id: "command", name: "shell", input: "echo ready", status: "pending" }] }] });
  notify("item/completed", { threadId: "parent", turnId: "t", item: { id: "command", type: "commandExecution", command: "echo ready", status: "completed", aggregatedOutput: "ready" } });
  assert.equal(store.getState().messages.length, 1);
  assert.equal(store.getState().messages[0].toolCalls[0].status, "completed");
  assert.equal(store.getState().messages[0].toolCalls[0].output, "ready");
});

test('queued messages continue on the correct thread after selecting another chat', async () => {
  reset();
  const calls = [];
  handler = async (method, params) => {
    calls.push([method, params]);
    return { turn: { id: 'next-turn' } };
  };
  notify('turn/started', { threadId: 'parent', turn: { id: 'first' } });
  await store.getState().sendMessage('next', 'data:image/png;base64,FULL');
  assert.equal(calls.length, 0);
  store.setState({ currentThreadId: 'other', messages: [], isStreaming: false });
  notify('turn/completed', { threadId: 'parent', turn: { id: 'first', status: 'completed' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0][0], 'turn/start');
  assert.equal(calls[0][1].threadId, 'parent');
  assert.equal(calls[0][1].input[1].url, 'data:image/png;base64,FULL');
  assert.deepEqual(store.getState().messages, []);
  assert.equal(store.getState().isStreaming, false);
});

test('steer uses expectedTurnId and preserves the draft on rejection', async () => {
  reset();
  const calls = [];
  handler = async (method, params) => { calls.push([method, params]); return { turnId: 'active' }; };
  notify('turn/started', { threadId: 'parent', turn: { id: 'active' } });
  await store.getState().sendMessage('guide', null, 'steer');
  assert.equal(calls[0][0], 'turn/steer');
  assert.equal(calls[0][1].expectedTurnId, 'active');
  assert.equal(store.getState().isStreaming, true);
  handler = async () => { throw new Error('turn changed'); };
  await assert.rejects(store.getState().sendMessage('rejected guide', null, 'steer'), /turn changed/);
  assert.equal(store.getState().messages.some(m => m.content === 'rejected guide'), false);
});

test('late history cannot resurrect a completed active turn', async () => {
  reset();
  let history;
  handler = async method => {
    if (method === 'thread/resume') return { thread: { status: { type: 'active' } } };
    return new Promise(resolve => { history = resolve; });
  };
  const switching = store.getState().switchThread('parent');
  await new Promise(resolve => setImmediate(resolve));
  notify('turn/started', { threadId: 'parent', turn: { id: 'finished' } });
  notify('turn/completed', { threadId: 'parent', turn: { id: 'finished', status: 'completed' } });
  history({ data: [{ id: 'finished', status: 'inProgress', items: [] }], nextCursor: null });
  await switching;
  assert.equal(store.getState().isStreaming, false);
  assert.equal(store.getState().runs.parent.turnId, null);
});
