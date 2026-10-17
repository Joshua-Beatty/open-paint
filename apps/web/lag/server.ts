/// <reference types="node" />
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

export const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WASM = fileURLToPath(
  new URL("../../../crates/opaint-cpu/pkg/opaint_cpu_bg.wasm", import.meta.url),
);

export interface AppServer {
  readonly url: string;
  stop(): void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("No port.")),
      );
    });
  });
}

function run(command: string, cwd: string): void {
  console.log(`> ${command}`);
  const result = spawnSync(command, { cwd, stdio: "inherit", shell: true });
  if (result.status !== 0) throw new Error(`"${command}" failed with exit code ${result.status}.`);
}

/** Ends a server and its children. On Windows the shell's children outlive it otherwise. */
function kill(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

async function waitForUrl(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The server exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} did not respond within ${timeoutMs / 1000} s.`);
}

/**
 * Serves apps/web: a production build with source maps plus `vite preview`, or the Vite dev
 * server. Both send the COOP/COEP headers from vite.config.ts. The server runs in its own process
 * group, so Ctrl+C in the terminal ends the session without killing it before the source maps
 * are read.
 */
export async function startServer(dev: boolean): Promise<AppServer> {
  if (!existsSync(WASM)) run("pnpm build:wasm", REPO_ROOT);
  if (!dev) run("pnpm exec vite build --sourcemap --logLevel warn", WEB_DIR);
  const port = await freePort();
  const command = dev
    ? `pnpm exec vite --port ${port} --strictPort --host 127.0.0.1`
    : `pnpm exec vite preview --port ${port} --strictPort --host 127.0.0.1`;
  console.log(`> ${command}`);
  const child = spawn(command, {
    cwd: WEB_DIR,
    shell: true,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const url = `http://127.0.0.1:${port}/`;
  try {
    await waitForUrl(url, child, 120_000);
  } catch (error) {
    kill(child);
    throw new Error(`${(error as Error).message}\n${output}`);
  }
  const stop = () => kill(child);
  process.once("exit", stop);
  return { url, stop };
}
