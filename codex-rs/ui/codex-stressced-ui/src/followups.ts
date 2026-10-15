export type Prompt = { id: string; text: string; image?: string | null };
export type ConversationRun = {
  queue: Prompt[];
  busy: boolean;
  sending: boolean;
  turnId: string | null;
  paused: boolean;
  compacting: boolean;
  error: string | null;
  lastCompletedTurnId: string | null;
  stopRequested: boolean;
};
export const emptyRun: ConversationRun = {
  queue: [], busy: false, sending: false, turnId: null, paused: false, compacting: false,
  error: null, lastCompletedTurnId: null, stopRequested: false,
};

/** Per-conversation scheduling, independent of which conversation is displayed. */
export class Followups {
  constructor(private io: {
    get: (thread: string) => ConversationRun;
    set: (thread: string, state: ConversationRun) => void;
    connected: () => boolean;
    send: (thread: string, prompt: Prompt, turnId?: string) => Promise<string>;
    interrupt: (thread: string, turnId: string) => Promise<void>;
  }) {}

  private update(thread: string, change: Partial<ConversationRun>) {
    this.io.set(thread, { ...this.io.get(thread), ...change });
  }

  async submit(thread: string, prompt: Prompt, mode: "queue" | "steer") {
    const run = this.io.get(thread);
    if (mode === "steer" && run.busy) {
      if (!run.turnId || run.sending || run.compacting || !this.io.connected()) {
        throw new Error("Steer is unavailable while starting, reconnecting or compacting. You can queue this message.");
      }
      // A failed steer stays in the composer. Never replay an ambiguous delivery automatically.
      await this.io.send(thread, prompt, run.turnId);
      return;
    }
    this.update(thread, { queue: [...run.queue, prompt], paused: run.paused || !this.io.connected() });
    await this.drain(thread);
  }

  async drain(thread: string) {
    const run = this.io.get(thread);
    if (!this.io.connected() || run.busy || run.sending || run.paused || run.compacting || !run.queue.length) return;
    const prompt = run.queue[0];
    this.update(thread, { busy: true, sending: true, error: null, stopRequested: false });
    try {
      const turnId = await this.io.send(thread, prompt);
      const current = this.io.get(thread);
      this.update(thread, {
        queue: current.queue.filter(item => item.id !== prompt.id),
        // Completion can arrive before the RPC response. Do not resurrect that turn.
        turnId: current.busy ? current.turnId ?? turnId : null,
      });
      if (this.io.get(thread).stopRequested && this.io.get(thread).busy && turnId) {
        await this.io.interrupt(thread, turnId);
      }
    } catch (error) {
      this.update(thread, { paused: true, busy: !!this.io.get(thread).turnId, error: String(error instanceof Error ? error.message : error) });
    } finally {
      this.update(thread, { sending: false });
    }
    if (!this.io.get(thread).busy) void this.drain(thread);
  }

  started(thread: string, turnId: string) {
    this.update(thread, { busy: true, turnId });
  }

  completed(thread: string, turnId: string | undefined, status: string, error?: string) {
    const run = this.io.get(thread);
    if (turnId && turnId === run.lastCompletedTurnId) return;
    if (turnId && run.turnId && turnId !== run.turnId) return;
    this.update(thread, { busy: false, turnId: null, compacting: false, stopRequested: false,
      lastCompletedTurnId: turnId ?? run.lastCompletedTurnId,
      paused: run.paused || status !== "completed", error: error ?? run.error });
    // Let the transcript consume completion before dispatching the next prompt.
    queueMicrotask(() => { void this.drain(thread); });
  }

  compacting(thread: string, compacting: boolean) { this.update(thread, { compacting }); }

  async stop(thread: string) {
    const run = this.io.get(thread);
    this.update(thread, { paused: true, stopRequested: true });
    if (run.busy && run.turnId) await this.io.interrupt(thread, run.turnId);
  }

  resume(thread: string) {
    this.update(thread, { paused: false, error: null });
    return this.drain(thread);
  }

  edit(thread: string, id: string, text: string) {
    const run = this.io.get(thread);
    if (run.sending && run.queue[0]?.id === id) return;
    this.update(thread, { queue: run.queue.map(prompt => prompt.id === id ? { ...prompt, text } : prompt) });
  }

  remove(thread: string, id: string) {
    const run = this.io.get(thread);
    if (run.sending && run.queue[0]?.id === id) return;
    this.update(thread, { queue: run.queue.filter(prompt => prompt.id !== id) });
  }

  disconnected(thread: string) {
    // Delivery and turn state are unknown until history has been reconciled.
    this.update(thread, { paused: true });
  }

  reconcile(thread: string, busy: boolean, turnId: string | null) {
    this.update(thread, { busy, turnId });
  }
}
