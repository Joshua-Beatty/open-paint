import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThumbnailCache, type ThumbnailSource } from "./thumbnail-cache";

class FakeSource implements ThumbnailSource {
  readonly listeners = new Set<(change?: "state" | "preview") => void>();
  change(kind: "state" | "preview" = "state"): void {
    for (const listener of this.listeners) listener(kind);
  }
  subscribe(listener: (change?: "state" | "preview") => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

describe("ThumbnailCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const render = vi.fn((source: FakeSource) => `url-${source.listeners.size}`);
    const onChange = vi.fn();
    const cache = new ThumbnailCache<FakeSource>({ render, onChange, intervalMs: 250 });
    return { cache, render, onChange };
  }

  it("renders a thumbnail for each tracked source after the interval", async () => {
    const { cache, render } = setup();
    const source = new FakeSource();
    cache.sync(new Map([["tab-1", source]]));
    expect(cache.url("tab-1")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);
    expect(render).toHaveBeenCalledTimes(1);
    expect(cache.url("tab-1")).toBe("url-1");
  });

  it("waits while busy, then renders once (L8)", async () => {
    const render = vi.fn(() => "url");
    let busy = true;
    const cache = new ThumbnailCache<FakeSource>({
      render,
      onChange: () => {},
      intervalMs: 250,
      busy: () => busy,
    });
    const source = new FakeSource();
    cache.sync(new Map([["tab-1", source]]));
    source.change("preview");
    await vi.advanceTimersByTimeAsync(1000);
    expect(render).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(render).toHaveBeenCalledTimes(1);
    expect(cache.url("tab-1")).toBe("url");
    cache.dispose();
  });

  it("renews the thumbnail for live previews without reporting them as tab changes", async () => {
    const { cache, render, onChange } = setup();
    const source = new FakeSource();
    cache.sync(new Map([["tab-1", source]]));
    await vi.advanceTimersByTimeAsync(250);
    onChange.mockClear();
    for (let i = 0; i < 10; i++) source.change("preview");
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(render).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    source.change("state");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("waits for an asynchronous render before it shows the thumbnail", async () => {
    const onChange = vi.fn();
    const cache = new ThumbnailCache<FakeSource>({
      render: async () => "slow-url",
      onChange,
      intervalMs: 250,
    });
    cache.sync(new Map([["tab-1", new FakeSource()]]));
    await vi.advanceTimersByTimeAsync(250);
    expect(cache.url("tab-1")).toBe("slow-url");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("renders one thumbnail at a time, and once more after changes during it", async () => {
    const resolvers: ((url: string) => void)[] = [];
    const cache = new ThumbnailCache<FakeSource>({
      render: () => new Promise<string>((resolve) => resolvers.push(resolve)),
      onChange: () => {},
      intervalMs: 250,
    });
    const source = new FakeSource();
    cache.sync(new Map([["tab-1", source]]));
    await vi.advanceTimersByTimeAsync(250);
    source.change();
    source.change();
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolvers).toHaveLength(1);
    resolvers[0]?.("older");
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.url("tab-1")).toBe("older");
    await vi.advanceTimersByTimeAsync(250);
    expect(resolvers).toHaveLength(2);
    resolvers[1]?.("newer");
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.url("tab-1")).toBe("newer");
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolvers).toHaveLength(2);
  });

  it("notifies on every change but renders at most once per interval", async () => {
    const { cache, render, onChange } = setup();
    const source = new FakeSource();
    cache.sync(new Map([["tab-1", source]]));
    await vi.advanceTimersByTimeAsync(250);
    onChange.mockClear();
    source.change();
    source.change();
    source.change();
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(render).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("stops watching a source that is no longer in the session", async () => {
    const { cache, render, onChange } = setup();
    const source = new FakeSource();
    cache.sync(new Map([["tab-1", source]]));
    cache.sync(new Map());
    expect(source.listeners.size).toBe(0);
    source.change();
    await vi.advanceTimersByTimeAsync(1000);
    expect(render).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(cache.url("tab-1")).toBeUndefined();
  });

  it("replaces the tracking when an id gets a different source", () => {
    const { cache } = setup();
    const first = new FakeSource();
    const second = new FakeSource();
    cache.sync(new Map([["tab-1", first]]));
    cache.sync(new Map([["tab-1", second]]));
    expect(first.listeners.size).toBe(0);
    expect(second.listeners.size).toBe(1);
  });

  it("does not render a source that closed before its timer ran", async () => {
    const { cache, render } = setup();
    const source = new FakeSource();
    cache.sync(new Map([["tab-1", source]]));
    cache.untrack("tab-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(render).not.toHaveBeenCalled();
  });

  it("stops everything on dispose", () => {
    const { cache } = setup();
    const a = new FakeSource();
    const b = new FakeSource();
    cache.sync(
      new Map([
        ["tab-1", a],
        ["tab-2", b],
      ]),
    );
    cache.dispose();
    expect(a.listeners.size).toBe(0);
    expect(b.listeners.size).toBe(0);
  });
});
