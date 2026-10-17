import { afterEach, describe, expect, it } from "vitest";
import { createRpcClient, type RpcEndpoint, serveRpc, transfer } from "./rpc";

type TestProtocol = {
  requests: {
    add: { params: { a: number; b: number }; result: number };
    invert: { params: { pixels: ArrayBuffer }; result: { pixels: ArrayBuffer } };
    fail: { params: string; result: never };
  };
  events: { progress: number };
};

describe("typed RPC", () => {
  const channels: MessageChannel[] = [];

  function connect() {
    const channel = new MessageChannel();
    channels.push(channel);
    const server = serveRpc<TestProtocol>(channel.port2 as unknown as RpcEndpoint, {
      add: ({ a, b }) => a + b,
      async invert({ pixels }) {
        const bytes = new Uint8Array(pixels);
        for (let i = 0; i < bytes.length; i++) bytes[i] = 255 - (bytes[i] as number);
        return transfer({ pixels }, [pixels]);
      },
      fail(message) {
        throw new RangeError(message);
      },
    });
    const client = createRpcClient<TestProtocol>(channel.port1 as unknown as RpcEndpoint);
    return { client, server };
  }

  afterEach(() => {
    for (const { port1, port2 } of channels.splice(0)) {
      port1.close();
      port2.close();
    }
  });

  it("correlates concurrent requests with their responses", async () => {
    const { client } = connect();
    await expect(
      Promise.all([client.call("add", { a: 1, b: 2 }), client.call("add", { a: 10, b: 20 })]),
    ).resolves.toEqual([3, 30]);
  });

  it("transfers marked buffers in both directions instead of copying", async () => {
    const { client } = connect();
    const pixels = new Uint8Array([0, 100, 255]).buffer;
    const result = await client.call("invert", transfer({ pixels }, [pixels]));
    expect(pixels.byteLength).toBe(0);
    expect([...new Uint8Array(result.pixels)]).toEqual([255, 155, 0]);
  });

  it("rejects with the handler's error name and message", async () => {
    const { client } = connect();
    await expect(client.call("fail", "out of range")).rejects.toMatchObject({
      name: "RangeError",
      message: "out of range",
    });
    await expect(client.call("missing" as "add", { a: 0, b: 0 })).rejects.toThrow(
      'Unknown RPC method "missing"',
    );
  });

  it("delivers events to subscribed listeners until they unsubscribe", async () => {
    const { client, server } = connect();
    const seen: number[] = [];
    const off = client.on("progress", (p) => seen.push(p));
    server.emit("progress", 25);
    server.emit("progress", 50);
    await client.call("add", { a: 0, b: 0 });
    off();
    server.emit("progress", 75);
    await client.call("add", { a: 0, b: 0 });
    expect(seen).toEqual([25, 50]);
  });

  it("rejects pending calls when the client closes", async () => {
    const { client, server } = connect();
    server.close();
    const pending = client.call("add", { a: 1, b: 1 });
    client.close();
    await expect(pending).rejects.toThrow("RPC connection closed.");
  });
});
