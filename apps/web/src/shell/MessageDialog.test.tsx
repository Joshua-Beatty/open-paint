import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageDialog } from "./MessageDialog";

describe("MessageDialog", () => {
  it("shows the message with no footer, focused, and closes from the title bar or Esc", () => {
    const onClose = vi.fn();
    render(
      <MessageDialog isOpen title="Out of Memory" message="Not enough memory." onClose={onClose} />,
    );
    const dialog = screen.getByRole("dialog", { name: "Out of Memory" });
    expect(dialog.textContent).toContain("Not enough memory.");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(dialog.querySelector(".modal-actions")).toBeNull();
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.closest(".modal-header")).not.toBeNull();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
