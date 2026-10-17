// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EffectErrorDialog, RenderProgressDialog } from "./RenderDialogs";

afterEach(() => cleanup());

function header(): string | null | undefined {
  return document.querySelector('[role="status"]')?.textContent;
}

function cancelButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((button) => button.textContent === "Cancel");
}

describe("RenderProgressDialog", () => {
  it("shows Initializing until the first percent, then the percent written", () => {
    const { rerender } = render(
      <RenderProgressDialog
        isOpen
        title="Gaussian Blur"
        percent={undefined}
        canceling={false}
        onCancel={() => undefined}
      />,
    );
    expect(header()).toBe("Initializing...");
    rerender(
      <RenderProgressDialog
        isOpen
        title="Gaussian Blur"
        percent={42}
        canceling={false}
        onCancel={() => undefined}
      />,
    );
    expect(header()).toBe("Rendering... 42%");
    expect(document.querySelector(".modal-title")?.textContent).toBe("Gaussian Blur");
  });

  it("shows Canceling and Finishing, with no Cancel button, while the render stops", () => {
    render(
      <RenderProgressDialog
        isOpen
        title="Gaussian Blur"
        percent={60}
        canceling
        onCancel={() => undefined}
      />,
    );
    expect(header()).toBe("Canceling...");
    expect(document.body.textContent).toContain("Finishing...");
    expect(cancelButton()).toBeUndefined();
    expect(document.querySelector('button[aria-label="Close"]')).toBeNull();
  });

  it("cancels from the close button in the title bar", () => {
    const onCancel = vi.fn();
    render(
      <RenderProgressDialog
        isOpen
        title="Gaussian Blur"
        percent={10}
        canceling={false}
        onCancel={onCancel}
      />,
    );
    const close = document.querySelector<HTMLButtonElement>(
      '.modal-header button[aria-label="Close"]',
    );
    if (close === null) throw new Error("No close button.");
    fireEvent.click(close);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("calls onCancel from the Cancel button", () => {
    const onCancel = vi.fn();
    render(
      <RenderProgressDialog
        isOpen
        title="Gaussian Blur"
        percent={10}
        canceling={false}
        onCancel={onCancel}
      />,
    );
    const button = cancelButton();
    if (button === undefined) throw new Error("No Cancel button.");
    fireEvent.click(button);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("EffectErrorDialog", () => {
  it("with only the message, has no footer and closes from the title bar's button", () => {
    const onClose = vi.fn();
    render(
      <EffectErrorDialog
        isOpen
        title="Gaussian Blur"
        message="Gaussian Blur could not be applied. Your image has not been changed."
        onClose={onClose}
      />,
    );
    expect(document.body.textContent).toContain("Your image has not been changed.");
    expect(findButton("Close")).toBeUndefined();
    expect(document.querySelector(".modal-actions")).toBeNull();
    const titleClose = document.querySelector<HTMLButtonElement>(
      '.modal-header button[aria-label="Close"]',
    );
    if (titleClose === null) throw new Error("No title bar close button.");
    fireEvent.click(titleClose);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps its footer Close beside Copy and View error log", () => {
    const onClose = vi.fn();
    render(
      <EffectErrorDialog
        isOpen
        title="Gaussian Blur"
        message="Gaussian Blur could not be applied."
        details="RangeError"
        onClose={onClose}
      />,
    );
    fireEvent.click(buttonNamed("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("hides the details until Show details is pressed, then copies them", () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <EffectErrorDialog
        isOpen
        title="Gaussian Blur"
        message="Gaussian Blur could not be applied. Your image has not been changed."
        details={"RangeError: bad radius\n    at run"}
        onClose={() => undefined}
      />,
    );
    expect(document.getElementById("effect-error-details")).toBeNull();
    fireEvent.click(buttonNamed("Show details"));
    expect(document.getElementById("effect-error-details")?.textContent).toBe(
      "RangeError: bad radius\n    at run",
    );
    fireEvent.click(buttonNamed("Copy to clipboard"));
    expect(writeText).toHaveBeenCalledWith("RangeError: bad radius\n    at run");
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("opens the error log from View error log", () => {
    const onViewErrorLog = vi.fn();
    render(
      <EffectErrorDialog
        isOpen
        title="Gaussian Blur"
        message="Gaussian Blur could not be applied."
        details="RangeError"
        onViewErrorLog={onViewErrorLog}
        onClose={() => undefined}
      />,
    );
    fireEvent.click(buttonNamed("View error log"));
    expect(onViewErrorLog).toHaveBeenCalledOnce();
  });

  it("offers no details or error log when neither is given", () => {
    render(
      <EffectErrorDialog
        isOpen
        title="Gaussian Blur"
        message="Gaussian Blur could not be applied."
        onClose={() => undefined}
      />,
    );
    expect(findButton("Show details")).toBeUndefined();
    expect(findButton("View error log")).toBeUndefined();
  });
});

function findButton(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  );
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = findButton(name);
  if (button === undefined) throw new Error(`No ${name} button.`);
  return button;
}
