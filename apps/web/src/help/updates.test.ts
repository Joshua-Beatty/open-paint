import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateController, type UpdateHost } from "./updates";

function fakeHost(options: { check?: () => Promise<boolean> } = {}) {
  return {
    check: vi.fn(options.check ?? (() => Promise.resolve(false))),
    activate: vi.fn<() => void>(),
  };
}

function controllerWith(host: UpdateHost, online = true) {
  return new UpdateController(host, { isOnline: () => online, intervalMs: 1000 });
}

describe("UpdateController (SET-UPD-01, SET-UPD-02, SET-UPD-04)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports up to date after a check that finds nothing waiting", async () => {
    const controller = controllerWith(fakeHost());
    await controller.checkNow();
    expect(controller.snapshot).toEqual({ state: "upToDate", noticeVisible: false });
  });

  it("shows checking while the check runs", async () => {
    let finish: (waiting: boolean) => void = () => {};
    const host = fakeHost({
      check: () => new Promise<boolean>((resolve) => (finish = resolve)),
    });
    const controller = controllerWith(host);
    const done = controller.checkNow();
    expect(controller.snapshot.state).toBe("checking");
    finish(false);
    await done;
    expect(controller.snapshot.state).toBe("upToDate");
  });

  it("reports an update when a check finds a waiting version, and shows the notice", async () => {
    const controller = controllerWith(fakeHost({ check: () => Promise.resolve(true) }));
    await controller.checkNow();
    expect(controller.snapshot).toEqual({ state: "updateAvailable", noticeVisible: true });
  });

  it("reports an error when the check fails", async () => {
    const controller = controllerWith(fakeHost({ check: () => Promise.reject(new Error("no")) }));
    await controller.checkNow();
    expect(controller.snapshot.state).toBe("error");
  });

  it("reports offline without asking the browser", async () => {
    const host = fakeHost();
    const controller = controllerWith(host, false);
    await controller.checkNow();
    expect(controller.snapshot.state).toBe("offline");
    expect(host.check).not.toHaveBeenCalled();
  });

  it("shows the notice when a waiting version is reported, and hides it on Later", () => {
    const controller = controllerWith(fakeHost());
    controller.markWaiting();
    expect(controller.snapshot).toEqual({ state: "updateAvailable", noticeVisible: true });
    controller.dismissNotice();
    expect(controller.snapshot).toEqual({ state: "updateAvailable", noticeVisible: false });
  });

  it("stays hidden after Later when the same waiting version is reported again", () => {
    const controller = controllerWith(fakeHost());
    controller.markWaiting();
    controller.dismissNotice();
    controller.markWaiting();
    expect(controller.snapshot.noticeVisible).toBe(false);
  });

  it("keeps the waiting version when a later check reports none", async () => {
    const controller = controllerWith(fakeHost());
    controller.markWaiting();
    await controller.checkNow();
    expect(controller.snapshot).toEqual({ state: "updateAvailable", noticeVisible: true });
  });

  it("notifies subscribers only when the snapshot changes", () => {
    const controller = controllerWith(fakeHost());
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.markWaiting();
    controller.markWaiting();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops listening when unsubscribed", () => {
    const controller = controllerWith(fakeHost());
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    unsubscribe();
    controller.markWaiting();
    expect(listener).not.toHaveBeenCalled();
  });

  it("only activates the waiting version when asked, never on its own", async () => {
    const host = fakeHost({ check: () => Promise.resolve(true) });
    const controller = controllerWith(host);
    await controller.checkNow();
    expect(host.activate).not.toHaveBeenCalled();
    controller.applyUpdate();
    expect(host.activate).toHaveBeenCalledTimes(1);
  });

  it("checks on each interval while started, and stops when told", async () => {
    const host = fakeHost();
    const controller = controllerWith(host);
    const stop = controller.start();
    expect(host.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2500);
    expect(host.check).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.check).toHaveBeenCalledTimes(2);
  });

  it("uses the 24-hour interval by default", async () => {
    const host = fakeHost();
    const controller = new UpdateController(host, { isOnline: () => true });
    const stop = controller.start();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 - 1);
    expect(host.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(host.check).toHaveBeenCalledTimes(1);
    stop();
  });
});
