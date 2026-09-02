export type Role = "user" | "assistant" | "system";

export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
  status: "pending" | "running" | "approved" | "rejected" | "completed" | "failed";
  approvalId?: string;
  output?: string;
};

export type Message = {
  id: string;
  role: Role;
  content: string;
  image?: string;
  images?: string[];
  kind?: "compaction";
  toolCalls?: ToolCall[];
};

export type ThinkingMessage = { id: string; content: string; done?: boolean };
export type ThreadItem = Record<string, unknown> & { id?: string; type?: string };
export type ThreadTurn = { id: string; items?: ThreadItem[] };
export type ThreadReadResponse = {
  thread: { id: string; path?: string | null; turns?: ThreadTurn[] };
};
export type TurnsPage = { data: ThreadTurn[]; nextCursor: string | null };
export type Transcript = { messages: Message[]; thinkingMessages: ThinkingMessage[] };

function textParts(parts: unknown): string {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n");
}

/** Decode the public app-server transcript, including image-only input and tool results. */
export function transcriptFromTurns(turns: ThreadTurn[]): Transcript {
  const messages: Message[] = [];
  const thinkingMessages: ThinkingMessage[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    for (const [index, item] of (turn.items ?? []).entries()) {
      const id = item.id ?? `${turn.id}-${index}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (item.type === "userMessage") {
        const parts = Array.isArray(item.content) ? item.content : [];
        const images = parts.flatMap((part) => part?.type === "image" && typeof part.url === "string" ? [part.url] : []);
        const localImages = parts.filter((part) => part?.type === "localImage" && typeof part.path === "string").map((part) => part.path);
        messages.push({ id, role: "user", content: [textParts(parts), ...localImages].filter(Boolean).join("\n"), images });
      } else if (item.type === "agentMessage") {
        messages.push({ id, role: "assistant", content: textParts(item.text ?? item.content) });
      } else if (item.type === "plan") {
        messages.push({ id, role: "assistant", content: textParts(item.text) });
      } else if (item.type === "reasoning") {
        const content = textParts(item.content) || textParts(item.summary);
        if (content) thinkingMessages.push({ id, content, done: true });
      } else if (item.type === "contextCompaction") {
        messages.push({ id, role: "system", content: "Contexto compactado", kind: "compaction" });
      } else if (item.type === "collabAgentToolCall") {
        messages.push({ id, role: "assistant", content: "", toolCalls: [{
          id, name: `Subagente: ${item.tool}`, input: item.prompt ?? "",
          status: item.status === "failed" ? "failed" : item.status === "inProgress" ? "running" : "completed",
          output: JSON.stringify({ threads: item.receiverThreadIds, states: item.agentsStates, model: item.model }, null, 2),
        }] });
      } else if (item.type === "commandExecution" || item.type === "mcpToolCall" || item.type === "fileChange") {
        const output = item.aggregatedOutput ?? item.result ?? item.error ?? item.changes;
        messages.push({ id, role: "assistant", content: "", toolCalls: [{
          id,
          name: item.type === "mcpToolCall" ? `${item.server}/${item.tool}` : item.type,
          input: item.command ?? item.arguments ?? item.changes ?? "",
          status: item.status === "failed" || item.status === "declined" ? "failed" : item.status === "inProgress" ? "running" : "completed",
          output: typeof output === "string" ? output : output == null ? undefined : JSON.stringify(output, null, 2),
        }] });
      }
    }
  }
  return { messages, thinkingMessages };
}

/** Pages arrive newest first; preserve chronological order and deduplicate boundary turns. */
export function prependTurns(older: ThreadTurn[], current: ThreadTurn[]): ThreadTurn[] {
  const merged = new Map<string, ThreadTurn>();
  for (const turn of [...older, ...current]) merged.set(turn.id, turn);
  return [...merged.values()];
}

/** Final tool events also replace approval cards already attached to a message. */
export function upsertCompletedMessage(messages: Message[], completed: Message): Message[] {
  const tool = completed.toolCalls?.[0];
  if (tool && messages.some(message => message.toolCalls?.some(call => call.id === tool.id))) {
    return messages.map(message => ({ ...message,
      toolCalls: message.toolCalls?.map(call => call.id === tool.id ? tool : call),
    }));
  }
  return messages.some(message => message.id === completed.id)
    ? messages.map(message => message.id === completed.id ? completed : message)
    : [...messages, completed];
}
