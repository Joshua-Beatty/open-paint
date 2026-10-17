import { describe, expect, it, vi } from "vitest";
import { type BeforeInstallPromptEvent, InstallHint } from "./install-prompt";

function fakePrompt(outcome: "accepted" | "dismissed" = "accepted") {
  const event = new Event("beforeinstallprompt", { cancelable: true }) as BeforeInstallPromptEvent;
  Object.assign(event, {
    prompt: vi.fn(() => Promise.resolve()),
    userChoice: Promise.resolve({ outcome }),
  });
  return event;
}

describe("InstallHint (08 SET-LIFE-01, WEB-ENV-03)", () => {
  it("is hidden until a first run where the browser can install the app", () => {
    const hint = new InstallHint({ installed: false });
    hint.offer(fakePrompt());
    expect(hint.snapshot.visible).toBe(false);
    hint.beginFirstRun();
    expect(hint.snapshot.visible).toBe(true);
  });

  it("is hidden when the browser offers no install prompt", () => {
    const hint = new InstallHint({ installed: false });
    hint.beginFirstRun();
    expect(hint.snapshot.visible).toBe(false);
  });

  it("never shows in an app that is already installed", () => {
    const hint = new InstallHint({ installed: true });
    hint.beginFirstRun();
    hint.offer(fakePrompt());
    expect(hint.snapshot.visible).toBe(false);
  });

  it("hides once the app is installed", () => {
    const hint = new InstallHint({ installed: false });
    hint.beginFirstRun();
    hint.offer(fakePrompt());
    hint.markInstalled();
    expect(hint.snapshot.visible).toBe(false);
  });

  it("hides on Not now, for this launch", () => {
    const hint = new InstallHint({ installed: false });
    hint.beginFirstRun();
    hint.offer(fakePrompt());
    hint.dismiss();
    expect(hint.snapshot.visible).toBe(false);
  });

  it("keeps the browser's event and runs its prompt only when the user asks", async () => {
    const hint = new InstallHint({ installed: false });
    const event = fakePrompt();
    hint.beginFirstRun();
    hint.offer(event);
    expect(event.defaultPrevented).toBe(true);
    expect(event.prompt).not.toHaveBeenCalled();
    await hint.install();
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(hint.snapshot.visible).toBe(false);
  });

  it("does nothing when installing without a stored prompt", async () => {
    const hint = new InstallHint({ installed: false });
    await expect(hint.install()).resolves.toBeUndefined();
  });

  it("listens for the browser's install events on the attached target", () => {
    const target = new EventTarget();
    const hint = new InstallHint({ installed: false });
    const detach = hint.attach(target);
    hint.beginFirstRun();
    const event = fakePrompt();
    target.dispatchEvent(event);
    expect(hint.snapshot.visible).toBe(true);
    target.dispatchEvent(new Event("appinstalled"));
    expect(hint.snapshot.visible).toBe(false);
    detach();
  });

  it("stops listening after the detach", () => {
    const target = new EventTarget();
    const hint = new InstallHint({ installed: false });
    hint.beginFirstRun();
    const detach = hint.attach(target);
    detach();
    target.dispatchEvent(fakePrompt());
    expect(hint.snapshot.visible).toBe(false);
  });

  it("notifies subscribers when the snapshot changes", () => {
    const hint = new InstallHint({ installed: false });
    const listener = vi.fn();
    const unsubscribe = hint.subscribe(listener);
    hint.beginFirstRun();
    expect(listener).toHaveBeenCalledTimes(0);
    hint.offer(fakePrompt());
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    hint.dismiss();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
