import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./bundle.mjs";

const { transcriptFromTurns, prependTurns } = await loadSource("../src/history.ts");

test("history retains compaction, image-only input, tool errors, and real child IDs", () => {
  const transcript = transcriptFromTurns([{ id: "t", items: [
    { id: "u", type: "userMessage", content: [{ type: "image", url: "data:image/png;base64,AA" }] },
    { id: "m", type: "mcpToolCall", server: "safe_edit", tool: "read_file", status: "failed", error: { message: "not found" } },
    { id: "c", type: "contextCompaction" },
    { id: "s", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child-1"], agentsStates: { "child-1": { status: "running" } }, model: "local-qwen" },
    { id: "r", type: "reasoning", summary: ["next action"], content: [] },
    { id: "a", type: "agentMessage", text: "Listo" },
  ] }]);
  assert.deepEqual(transcript.messages.map(m => m.id), ["u", "m", "c", "s", "a"]);
  assert.deepEqual(transcript.messages[0].images, ["data:image/png;base64,AA"]);
  assert.equal(transcript.messages[1].toolCalls[0].status, "failed");
  assert.equal(transcript.messages[2].kind, "compaction");
  assert.match(transcript.messages[3].toolCalls[0].output, /child-1/);
  assert.deepEqual(transcript.thinkingMessages, [{ id: "r", content: "next action", done: true }]);
});

test("overlapping history pages preserve order and newer turn contents", () => {
  const old = [{ id: "t1", items: [] }, { id: "t2", items: [] }];
  const current = [{ id: "t2", items: [{ id: "a", type: "agentMessage", text: "complete" }] }, { id: "t3", items: [] }];
  assert.deepEqual(prependTurns(old, current), [old[0], ...current]);
  assert.deepEqual(transcriptFromTurns([...current, ...current]).messages, [{ id: "a", role: "assistant", content: "complete" }]);
});
