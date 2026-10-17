import { describe, expect, it, vi } from "vitest";
import { consumeLaunchQueue } from "./launch-queue";

describe("consumeLaunchQueue (WEB-FILE-05)", () => {
  it("hands each launch's file handles to the consumer, in order", () => {
    const setConsumer = vi.fn();
    const open = vi.fn();
    consumeLaunchQueue({ launchQueue: { setConsumer } }, open);

    const consumer = setConsumer.mock.calls[0]?.[0] as (params: unknown) => void;
    const first = { name: "one.png" } as FileSystemFileHandle;
    const second = { name: "two.png" } as FileSystemFileHandle;
    consumer({ files: [first, second] });

    expect(open).toHaveBeenCalledWith([first, second]);
  });

  it("ignores a launch with no files", () => {
    const setConsumer = vi.fn();
    const open = vi.fn();
    consumeLaunchQueue({ launchQueue: { setConsumer } }, open);

    const consumer = setConsumer.mock.calls[0]?.[0] as (params: unknown) => void;
    consumer({ files: [] });

    expect(open).not.toHaveBeenCalled();
  });

  it("does nothing where the File Handling API is missing", () => {
    const open = vi.fn();

    expect(() => consumeLaunchQueue({}, open)).not.toThrow();
    expect(open).not.toHaveBeenCalled();
  });
});
