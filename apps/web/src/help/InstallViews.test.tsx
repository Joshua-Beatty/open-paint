import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallNotice } from "./InstallViews";
import { type BeforeInstallPromptEvent, InstallHint } from "./install-prompt";

function promptEvent() {
  const event = new Event("beforeinstallprompt") as BeforeInstallPromptEvent;
  Object.assign(event, {
    prompt: vi.fn(() => Promise.resolve()),
    userChoice: Promise.resolve({ outcome: "accepted" as const }),
  });
  return event;
}

describe("InstallNotice (08 SET-LIFE-01)", () => {
  afterEach(() => {
    cleanup();
  });

  it("is hidden until the first-run hint is due", () => {
    const hint = new InstallHint({ installed: false });
    render(<InstallNotice install={hint} />);
    expect(screen.queryByRole("region", { name: /Install OpenPaint/ })).toBeNull();
    act(() => {
      hint.beginFirstRun();
      hint.offer(promptEvent());
    });
    expect(screen.getByRole("region", { name: /Install OpenPaint/ })).toBeDefined();
  });

  it("runs the browser's install prompt on Install", () => {
    const hint = new InstallHint({ installed: false });
    render(<InstallNotice install={hint} />);
    const event = promptEvent();
    act(() => {
      hint.beginFirstRun();
      hint.offer(event);
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(event.prompt).toHaveBeenCalledTimes(1);
  });

  it("hides on Not now", () => {
    const hint = new InstallHint({ installed: false });
    render(<InstallNotice install={hint} />);
    act(() => {
      hint.beginFirstRun();
      hint.offer(promptEvent());
    });
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", { name: /Install OpenPaint/ })).toBeNull();
  });
});
