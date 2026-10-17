/**
 * Typed RPC over `postMessage`: correlated request/response pairs plus one-way events. Values
 * marked with `transfer()` move their transferables (pixel buffers, canvases) instead of copying.
 */

/** A protocol names its requests (params and result) and its server-to-client events. */
export type RpcProtocol = {
  requests: Record<string, { params: unknown; result: unknown }>;
  events: Record<string, unknown>;
};

type Requests<P extends RpcProtocol> = P["requests"];
type Params<P extends RpcProtocol, M extends keyof Requests<P>> = Requests<P>[M]["params"];
type Result<P extends RpcProtocol, M extends keyof Requests<P>> = Requests<P>[M]["result"];

/** The subset of `Worker`, `MessagePort` and a worker's global scope that RPC needs. */
export interface RpcEndpoint {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  start?(): void;
}

type RpcMessage =
  | { type: "request"; id: number; method: string; params: unknown }
  | { type: "response"; id: number; result: unknown }
  | { type: "error"; id: number; name: string; message: string }
  | { type: "event"; name: string; payload: unknown };

const transfers = new WeakMap<object, Transferable[]>();

/** Marks `value` so that sending it transfers `list` instead of copying. Returns `value`. */
export function transfer<T extends object>(value: T, list: Transferable[]): T {
  transfers.set(value, list);
  return value;
}

function transferListOf(value: unknown): Transferable[] {
  return (typeof value === "object" && value !== null && transfers.get(value)) || [];
}

function send(endpoint: RpcEndpoint, message: RpcMessage, value: unknown): void {
  endpoint.postMessage(message, transferListOf(value));
}

export interface RpcClient<P extends RpcProtocol> {
  call<M extends keyof Requests<P> & string>(
    method: M,
    params: Params<P, M>,
  ): Promise<Result<P, M>>;
  on<E extends keyof P["events"] & string>(
    name: E,
    listener: (payload: P["events"][E]) => void,
  ): () => void;
  /** Stops listening and rejects every pending call. */
  close(): void;
}

export function createRpcClient<P extends RpcProtocol>(endpoint: RpcEndpoint): RpcClient<P> {
  let nextId = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  const onMessage = (event: MessageEvent) => {
    const msg = event.data as RpcMessage;
    if (msg.type === "event") {
      for (const listener of listeners.get(msg.name) ?? []) listener(msg.payload);
      return;
    }
    if (msg.type === "request") return;
    const call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    if (msg.type === "response") {
      call.resolve(msg.result);
    } else {
      const error = new Error(msg.message);
      error.name = msg.name;
      call.reject(error);
    }
  };
  endpoint.addEventListener("message", onMessage);
  endpoint.start?.();

  return {
    call(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        try {
          send(endpoint, { type: "request", id, method, params }, params);
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    on(name, listener) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      const l = listener as (payload: unknown) => void;
      set.add(l);
      return () => set.delete(l);
    },
    close() {
      endpoint.removeEventListener("message", onMessage);
      listeners.clear();
      for (const call of pending.values()) call.reject(new Error("RPC connection closed."));
      pending.clear();
    },
  };
}

type MessageListener = (event: MessageEvent) => void;

/**
 * Two connected endpoints in one thread, for when no worker can take the canvas (WebKit without
 * OffscreenCanvas). A message is delivered as a task, so both sides see the order a worker gives.
 * Values are passed by reference, not copied.
 */
export function createLocalChannel(): [RpcEndpoint, RpcEndpoint] {
  const listeners = [new Set<MessageListener>(), new Set<MessageListener>()] as const;
  const side = (own: 0 | 1): RpcEndpoint => {
    const peer = own === 0 ? listeners[1] : listeners[0];
    return {
      postMessage(message) {
        setTimeout(() => {
          for (const listener of [...peer]) listener({ data: message } as MessageEvent);
        }, 0);
      },
      addEventListener(_type, listener) {
        listeners[own].add(listener);
      },
      removeEventListener(_type, listener) {
        listeners[own].delete(listener);
      },
    };
  };
  return [side(0), side(1)];
}

export type RpcHandlers<P extends RpcProtocol> = {
  [M in keyof Requests<P>]: (params: Params<P, M>) => Result<P, M> | Promise<Result<P, M>>;
};

export interface RpcServer<P extends RpcProtocol> {
  emit<E extends keyof P["events"] & string>(name: E, payload: P["events"][E]): void;
  close(): void;
}

export function serveRpc<P extends RpcProtocol>(
  endpoint: RpcEndpoint,
  handlers: RpcHandlers<P>,
): RpcServer<P> {
  const onMessage = async (event: MessageEvent) => {
    const msg = event.data as RpcMessage;
    if (msg.type !== "request") return;
    try {
      const handler = (handlers as Record<string, ((params: unknown) => unknown) | undefined>)[
        msg.method
      ];
      if (!handler) throw new Error(`Unknown RPC method "${msg.method}".`);
      const result = await handler(msg.params);
      send(endpoint, { type: "response", id: msg.id, result }, result);
    } catch (error) {
      const { name, message } = error instanceof Error ? error : new Error(String(error));
      endpoint.postMessage({ type: "error", id: msg.id, name, message } satisfies RpcMessage, []);
    }
  };
  endpoint.addEventListener("message", onMessage);
  endpoint.start?.();

  return {
    emit(name, payload) {
      send(endpoint, { type: "event", name, payload }, payload);
    },
    close() {
      endpoint.removeEventListener("message", onMessage);
    },
  };
}
