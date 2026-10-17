import { afterEach, describe, expect, it, vi } from "vitest";

const pwa = vi.hoisted(() => ({ registerSW: vi.fn() }));
vi.mock("virtual:pwa-register", () => ({ registerSW: pwa.registerSW }));

import { startServiceWorkerUpdates } from "./service-worker";

/** Hands the registration to `onRegisteredSW` the way the plugin does, after registration. */
function register(registration: ServiceWorkerRegistration | undefined) {
  const reloadPage = vi.fn((_reload?: boolean) => Promise.resolve());
  pwa.registerSW.mockImplementation(
    (options: {
      onRegisteredSW?: (url: string, found: ServiceWorkerRegistration | undefined) => void;
    }) => {
      queueMicrotask(() => options.onRegisteredSW?.("/sw.js", registration));
      return reloadPage;
    },
  );
  return reloadPage;
}

function fakeRegistration(waiting: boolean) {
  return {
    update: vi.fn(() => Promise.resolve()),
    installing: null,
    waiting: waiting ? {} : null,
  } as unknown as ServiceWorkerRegistration & { update: ReturnType<typeof vi.fn> };
}

describe("startServiceWorkerUpdates (WEB-UPD-01)", () => {
  afterEach(() => {
    pwa.registerSW.mockReset();
  });

  it("registers the worker at start-up, with the registration callbacks", () => {
    register(undefined);
    startServiceWorkerUpdates();
    expect(pwa.registerSW).toHaveBeenCalledWith(expect.objectContaining({ immediate: true }));
  });

  it("checks for an update once the worker is registered, and reports nothing waiting", async () => {
    const registration = fakeRegistration(false);
    register(registration);
    const updates = startServiceWorkerUpdates();
    await vi.waitFor(() => expect(updates.snapshot.state).toBe("upToDate"));
    expect(registration.update).toHaveBeenCalledTimes(1);
    expect(updates.snapshot.noticeVisible).toBe(false);
  });

  it("shows the notice when a version is waiting after the check", async () => {
    register(fakeRegistration(true));
    const updates = startServiceWorkerUpdates();
    await vi.waitFor(() => expect(updates.snapshot.noticeVisible).toBe(true));
  });

  it("reports an error for a manual check before the worker is registered", async () => {
    register(undefined);
    const updates = startServiceWorkerUpdates();
    await updates.checkNow();
    expect(updates.snapshot.state).toBe("error");
  });

  it("activates the waiting version through the plugin's update function", () => {
    const reloadPage = register(undefined);
    const updates = startServiceWorkerUpdates();
    updates.applyUpdate();
    expect(reloadPage).toHaveBeenCalledWith(true);
  });
});
