import { serveEngine } from "./engine-host";
import type { RpcEndpoint } from "./rpc";

// The package compiles against the DOM lib, so the dedicated worker scope is typed structurally.
serveEngine(globalThis as unknown as RpcEndpoint, globalThis as unknown as EventTarget);
