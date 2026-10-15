/** Combine adjacent deltas, committing at most once per animation frame. */
export class DeltaBuffer {
  private pending = new Map<string, { method: string; params: Record<string, unknown> }>();
  private cancel: (() => void) | null = null;
  constructor(private commit: (events: Array<{ method: string; params: Record<string, unknown> }>) => void,
    private schedule = (flush: () => void) => {
      // The timer also flushes minimized windows where rAF is suspended.
      const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(flush) : null;
      const timer = setTimeout(flush, 50);
      return () => { if (frame !== null) cancelAnimationFrame(frame); clearTimeout(timer); };
    }) {}

  push(method: string, params: Record<string, unknown>) {
    const key = JSON.stringify([method, params.threadId ?? params.thread_id, params.turnId ?? params.turn_id, params.itemId ?? params.item_id]);
    const previous = this.pending.get(key);
    this.pending.set(key, { method, params: { ...params, delta: String(previous?.params.delta ?? "") + String(params.delta ?? "") } });
    if (!this.cancel) this.cancel = this.schedule(() => this.flush());
  }

  flush() {
    this.cancel?.();
    this.cancel = null;
    const events = [...this.pending.values()];
    this.pending.clear();
    if (events.length) this.commit(events);
  }
}
