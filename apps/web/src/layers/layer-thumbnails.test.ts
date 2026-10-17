import type { Document, Layer } from "@openpaint/document";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LayerThumbnails } from "./layer-thumbnails";

/** A document stand-in with the parts the thumbnails read: its layers. */
function fakeDocument(ids: number[]): { doc: Document; layers: Layer[] } {
  const layers = ids.map((id) => ({ id }) as Layer);
  return { doc: { layers } as unknown as Document, layers };
}

describe("LayerThumbnails", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws every layer once the interval passes", async () => {
    const render = vi.fn((layer: Layer) => `data:${layer.id}`);
    const onChange = vi.fn();
    const thumbnails = new LayerThumbnails({ render, onChange, intervalMs: 250 });
    const { doc } = fakeDocument([1, 2]);
    thumbnails.show(doc);
    expect(thumbnails.url(1)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);
    expect(thumbnails.url(1)).toBe("data:1");
    expect(thumbnails.url(2)).toBe("data:2");
    expect(render).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    thumbnails.dispose();
  });

  it("draws a newly shown document at once, and its changes after the interval (L4)", async () => {
    const render = vi.fn((layer: Layer) => `data:${layer.id}`);
    const thumbnails = new LayerThumbnails({ render, onChange: () => {}, intervalMs: 250 });
    const { doc } = fakeDocument([1]);
    thumbnails.show(doc);
    await vi.advanceTimersByTimeAsync(0);
    expect(thumbnails.url(1)).toBe("data:1");
    thumbnails.show(doc);
    await vi.advanceTimersByTimeAsync(100);
    expect(render).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(render).toHaveBeenCalledTimes(2);
    thumbnails.dispose();
  });

  it("waits while busy, then draws once (L8)", async () => {
    const render = vi.fn((layer: Layer) => `data:${layer.id}`);
    let busy = true;
    const thumbnails = new LayerThumbnails({
      render,
      onChange: () => {},
      intervalMs: 250,
      busy: () => busy,
    });
    thumbnails.show(fakeDocument([1]).doc);
    await vi.advanceTimersByTimeAsync(1000);
    expect(render).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(render).toHaveBeenCalledTimes(1);
    thumbnails.dispose();
  });

  it("waits for each asynchronous layer before it shows the thumbnails", async () => {
    const onChange = vi.fn();
    const thumbnails = new LayerThumbnails({
      render: async (layer: Layer) => `slow:${layer.id}`,
      onChange,
      intervalMs: 250,
    });
    thumbnails.show(fakeDocument([1, 2]).doc);
    await vi.advanceTimersByTimeAsync(250);
    expect(thumbnails.url(2)).toBe("slow:2");
    expect(onChange).toHaveBeenCalledTimes(1);
    thumbnails.dispose();
  });

  it("shares one render between changes within the interval", async () => {
    const render = vi.fn(() => "data:x");
    const thumbnails = new LayerThumbnails({ render, onChange: () => {}, intervalMs: 250 });
    const { doc } = fakeDocument([1]);
    thumbnails.show(doc);
    thumbnails.show(doc);
    await vi.advanceTimersByTimeAsync(100);
    thumbnails.show(doc);
    await vi.advanceTimersByTimeAsync(150);
    expect(render).toHaveBeenCalledTimes(1);
    thumbnails.dispose();
  });

  it("drops the thumbnails of layers that are gone", async () => {
    const render = (layer: Layer) => `data:${layer.id}`;
    const thumbnails = new LayerThumbnails({ render, onChange: () => {}, intervalMs: 10 });
    const first = fakeDocument([1, 2]);
    thumbnails.show(first.doc);
    await vi.advanceTimersByTimeAsync(10);
    const second = fakeDocument([2]);
    thumbnails.show(second.doc);
    expect(thumbnails.url(1)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);
    expect(thumbnails.url(1)).toBeUndefined();
    expect(thumbnails.url(2)).toBe("data:2");
    thumbnails.dispose();
  });

  it("drops a render whose document was replaced while it was drawing", async () => {
    const onChange = vi.fn();
    const thumbnails = new LayerThumbnails({
      render: async (layer: Layer) => `slow:${layer.id}`,
      onChange,
      intervalMs: 10,
    });
    thumbnails.show(fakeDocument([1, 2]).doc);
    await vi.advanceTimersByTimeAsync(10);
    thumbnails.show(fakeDocument([3]).doc);
    await vi.advanceTimersByTimeAsync(100);
    expect(thumbnails.url(1)).toBeUndefined();
    expect(thumbnails.url(3)).toBe("slow:3");
    thumbnails.dispose();
  });

  it("cancels a pending render when the document is cleared", async () => {
    const render = vi.fn(() => "data:x");
    const thumbnails = new LayerThumbnails({ render, onChange: () => {}, intervalMs: 10 });
    thumbnails.show(fakeDocument([1]).doc);
    thumbnails.show(undefined);
    await vi.advanceTimersByTimeAsync(50);
    expect(render).not.toHaveBeenCalled();
    thumbnails.dispose();
  });
});
