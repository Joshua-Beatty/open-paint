import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateCheck, UpdateNotice } from "./UpdateViews";
import { UpdateController, type UpdateHost } from "./updates";

function controllerWith(overrides: Partial<UpdateHost> = {}, online = true) {
  const host: UpdateHost = {
    check: vi.fn(() => Promise.resolve(false)),
    activate: vi.fn(),
    ...overrides,
  };
  return { host, updates: new UpdateController(host, { isOnline: () => online }) };
}

describe("UpdateNotice (WEB-UPD-01, SET-UPD-04)", () => {
  afterEach(() => {
    cleanup();
  });

  it("is hidden until a waiting version is found", () => {
    const { updates } = controllerWith();
    render(<UpdateNotice updates={updates} onReload={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "Update available." })).toBeNull();
    act(() => updates.markWaiting());
    expect(screen.getByRole("region", { name: "Update available." })).toBeDefined();
  });

  it("offers Reload now and Later, and no What's New link", () => {
    const { updates } = controllerWith();
    const onReload = vi.fn();
    render(<UpdateNotice updates={updates} onReload={onReload} />);
    act(() => updates.markWaiting());
    fireEvent.click(screen.getByRole("button", { name: "Reload now" }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "What's New" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("region", { name: "Update available." })).toBeNull();
  });

  it("never reloads by itself: the notice only calls its handler", () => {
    const { host, updates } = controllerWith();
    render(<UpdateNotice updates={updates} onReload={vi.fn()} />);
    act(() => updates.markWaiting());
    expect(host.activate).not.toHaveBeenCalled();
  });
});

describe("UpdateCheck (SET-DLG-09, SET-UPD-04)", () => {
  afterEach(() => {
    cleanup();
  });

  it("reports the result of a manual check inline", async () => {
    const { updates } = controllerWith();
    render(<UpdateCheck updates={updates} />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("OpenPaint is up to date.")).toBeDefined();
  });

  it("reports an error when the check fails", async () => {
    const { updates } = controllerWith({ check: () => Promise.reject(new Error("offline")) });
    render(<UpdateCheck updates={updates} />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("There was an error while checking for updates.")).toBeDefined();
  });

  it("says that checks need a connection when offline", async () => {
    const { updates } = controllerWith({}, false);
    render(<UpdateCheck updates={updates} />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Can't check for updates while offline.")).toBeDefined();
  });

  it("shows the result and a Reload button when a new version is waiting", async () => {
    const { updates } = controllerWith({ check: () => Promise.resolve(true) });
    const onReload = vi.fn();
    render(<UpdateCheck updates={updates} onReload={onReload} />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("A new version is available.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("has no Reload button where reloading is not offered", async () => {
    const { updates } = controllerWith({ check: () => Promise.resolve(true) });
    render(<UpdateCheck updates={updates} />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getByText("A new version is available.")).toBeDefined());
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("disables the button while a check runs", () => {
    const { updates } = controllerWith({ check: () => new Promise<boolean>(() => {}) });
    render(<UpdateCheck updates={updates} />);
    const button = screen.getByRole("button", { name: "Check for updates" });
    fireEvent.click(button);
    expect(screen.getByText("Checking for updates...")).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
