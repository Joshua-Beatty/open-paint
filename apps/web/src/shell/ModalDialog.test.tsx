import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModalDialog } from "./ModalDialog";

describe("ModalDialog (WEB-UI-02)", () => {
  it("renders a labelled dialog only while open", () => {
    const { rerender } = render(
      <ModalDialog isOpen={false} onClose={() => {}} title="About">
        <button type="button">OK</button>
      </ModalDialog>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(
      <ModalDialog isOpen onClose={() => {}} title="About">
        <button type="button">OK</button>
      </ModalDialog>,
    );
    expect(screen.getByRole("dialog", { name: "About" })).toBeDefined();
  });

  it("calls onClose when Esc is pressed", () => {
    const onClose = vi.fn();
    render(
      <ModalDialog isOpen onClose={onClose} title="About">
        <button type="button">OK</button>
      </ModalDialog>,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("has a close button in the title bar that calls onClose", () => {
    const onClose = vi.fn();
    render(
      <ModalDialog isOpen onClose={onClose} title="About">
        <button type="button">OK</button>
      </ModalDialog>,
    );
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.closest(".modal-header")?.querySelector(".modal-title")?.textContent).toBe(
      "About",
    );
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves the close button out of a dialog that must be answered, and disables it on request", () => {
    const { rerender } = render(
      <ModalDialog isOpen onClose={() => {}} title="Saving" closable={false}>
        <p>Saving...</p>
      </ModalDialog>,
    );
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    rerender(
      <ModalDialog isOpen onClose={() => {}} title="Saving" closeDisabled>
        <p>Canceling...</p>
      </ModalDialog>,
    );
    expect(screen.getByRole("button", { name: "Close" }).hasAttribute("disabled")).toBe(true);
  });

  it("dims the page behind it unless it previews on the canvas", () => {
    const { rerender } = render(
      <ModalDialog isOpen onClose={() => {}} title="About">
        <p>About</p>
      </ModalDialog>,
    );
    const overlay = () => screen.getByRole("dialog").closest(".modal-overlay");
    expect(overlay()?.classList.contains("is-clear")).toBe(false);
    rerender(
      <ModalDialog isOpen onClose={() => {}} title="Levels" backdrop="clear">
        <p>Levels</p>
      </ModalDialog>,
    );
    expect(overlay()?.classList.contains("is-clear")).toBe(true);
    expect(screen.getByRole("dialog", { name: "Levels" })).toBeDefined();
  });
});
