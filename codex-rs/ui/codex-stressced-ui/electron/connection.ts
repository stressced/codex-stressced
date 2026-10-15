export type ConnectionState = "connecting" | "connected" | "error" | "closed";

/** Owns one initialized transport. Requests are never replayed after a disconnect. */
export class AppServerConnection {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private ready = false;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 500;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  status: { state: ConnectionState; message?: string } = { state: "connecting" };

  constructor(private options: {
    endpoint: () => Promise<string>;
    status: (state: ConnectionState, message?: string) => void;
    notification: (message: Record<string, unknown>) => void;
    tool: (method: string, params: unknown) => Promise<unknown>;
    socket?: (url: string) => WebSocket;
    connectTimeoutMs?: number;
    retryMs?: number;
  }) {}

  private publish(state: ConnectionState, message?: string) {
    this.status = { state, message };
    this.options.status(state, message);
  }

  connect(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Connection closed"));
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.publish("connecting", "Connecting to app-server…");
    this.connecting = this.open().catch(error => {
      this.publish("error", String(error.message ?? error));
      this.scheduleReconnect();
      throw error;
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private scheduleReconnect() {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect().catch(() => {});
    }, this.options.retryMs ?? this.retryDelay);
    this.retryDelay = Math.min(5000, this.retryDelay * 2);
  }

  private async open() {
    const url = await this.options.endpoint();
    if (this.stopped) throw new Error("Connection closed");
    await new Promise<void>((resolve, reject) => {
      const socket = (this.options.socket ?? (url => new WebSocket(url)))(url);
      this.socket = socket;
      const timer = setTimeout(() => fail(new Error("App-server connection/initialization timed out")), this.options.connectTimeoutMs ?? 30_000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        if (this.socket !== socket) return;
        this.socket = null;
        this.ready = false;
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        reject(error);
        try { socket.close(); } catch { /* already closed */ }
        if (!this.stopped) {
          this.publish("error", error.message);
          this.scheduleReconnect();
        }
      };
      socket.onerror = () => fail(new Error(`Cannot connect to app-server (${url})`));
      socket.onclose = () => fail(new Error("App-server disconnected; reconnecting…"));
      socket.onopen = async () => {
        try {
          await this.requestOnSocket("initialize", {
            clientInfo: { name: "codex-stressced-ui", version: "0.1.0" },
            capabilities: { experimentalApi: true, requestAttestation: false },
          });
          if (this.socket !== socket) return;
          socket.send(JSON.stringify({ method: "initialized" }));
          clearTimeout(timer);
          this.ready = true;
          this.retryDelay = 500;
          this.publish("connected");
          resolve();
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      };
      socket.onmessage = event => {
        if (this.socket !== socket || typeof event.data !== "string") return;
        let message: Record<string, any>;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.id != null && message.method) {
          void this.options.tool(message.method, message.params).then(
            result => { if (this.socket === socket) socket.send(JSON.stringify({ id: message.id, result })); },
            error => { if (this.socket === socket) socket.send(JSON.stringify({ id: message.id, error: { code: -32603, message: String(error.message ?? error) } })); },
          ).catch(() => {});
        } else if (message.id != null) {
          const pending = this.pending.get(Number(message.id));
          this.pending.delete(Number(message.id));
          if (message.error) pending?.reject(new Error(JSON.stringify(message.error)));
          else pending?.resolve(message.result);
        } else if (message.method) {
          this.options.notification(message);
        }
      };
    });
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    return this.requestOnSocket(method, params);
  }

  private requestOnSocket(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return Promise.reject(new Error("App-server disconnected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}. Delivery is unknown; check the conversation before retrying.`));
      }, ["turn/start", "thread/read", "thread/resume"].includes(method) ? 300_000 : 30_000);
      this.pending.set(id, {
        resolve: result => { clearTimeout(timeout); resolve(result); },
        reject: error => { clearTimeout(timeout); reject(error); },
      });
      try { socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch (error) {
        this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
        this.pending.delete(id);
      }
    });
  }

  close() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.ready = false;
    this.socket?.close();
    for (const request of this.pending.values()) request.reject(new Error("Connection closed"));
    this.pending.clear();
    this.publish("closed");
  }
}
