import { describe, expect, it } from "vitest";
import { createLocalChannel, createRpcClient, serveRpc } from "./rpc";

type Protocol = {
  requests: {
    add: { params: { a: number; b: number }; result: number };
    fail: { params: undefined; result: never };
  };
  events: { tick: number };
};

describe("createLocalChannel", () => {
  it("carries requests, responses, errors and events between the two sides", async () => {
    const [clientEnd, serverEnd] = createLocalChannel();
    const server = serveRpc<Protocol>(serverEnd, {
      add: ({ a, b }) => a + b,
      fail: () => {
        throw new Error("nope");
      },
    });
    const client = createRpcClient<Protocol>(clientEnd);
    const ticks: number[] = [];
    client.on("tick", (value) => ticks.push(value));

    await expect(client.call("add", { a: 2, b: 3 })).resolves.toBe(5);
    await expect(client.call("fail", undefined)).rejects.toThrow("nope");
    server.emit("tick", 7);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticks).toEqual([7]);

    client.close();
    server.close();
  });

  it("delivers a message as a task, not synchronously", async () => {
    const [sender, receiver] = createLocalChannel();
    const received: unknown[] = [];
    receiver.addEventListener("message", (event) => received.push(event.data));
    sender.postMessage("hello", []);
    expect(received).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual(["hello"]);
  });

  it("stops delivering to a removed listener", async () => {
    const [sender, receiver] = createLocalChannel();
    const received: unknown[] = [];
    const listener = (event: MessageEvent) => received.push(event.data);
    receiver.addEventListener("message", listener);
    receiver.removeEventListener("message", listener);
    sender.postMessage("gone", []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([]);
  });
});
