import { registerSW } from "virtual:pwa-register";
import { UpdateController, type UpdateHost } from "./updates";

/** Waits for an installing worker to finish, then reports whether a new version is waiting. */
async function settle(registration: ServiceWorkerRegistration): Promise<boolean> {
  const installing = registration.installing;
  if (installing?.state === "installing") {
    await new Promise<void>((done) => {
      installing.addEventListener("statechange", () => {
        if (installing.state !== "installing") done();
      });
    });
  }
  return registration.waiting !== null;
}

/**
 * The app's update controller, wired to the service worker that `vite-plugin-pwa` registers in
 * prompt mode (WEB-UPD-01). Call once at start-up. The worker never activates on its own, so an
 * update waits until `applyUpdate` runs after the unsaved-work check.
 */
export function startServiceWorkerUpdates(): UpdateController {
  let registration: ServiceWorkerRegistration | undefined;
  let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | undefined;
  const host: UpdateHost = {
    async check() {
      if (registration === undefined) throw new Error("The service worker is not registered.");
      await registration.update();
      return settle(registration);
    },
    activate: () => {
      void updateServiceWorker?.(true);
    },
  };
  const updates = new UpdateController(host, { isOnline: () => navigator.onLine });
  updateServiceWorker = registerSW({
    immediate: true,
    onRegisteredSW: (_url, found) => {
      registration = found;
      if (found !== undefined) void updates.checkNow();
    },
    onNeedRefresh: () => updates.markWaiting(),
  });
  return updates;
}
