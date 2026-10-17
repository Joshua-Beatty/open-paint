import { Surface } from "@openpaint/document";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasteDialog } from "./PasteDialog";

const image = { pixels: new Surface(2, 2) };

describe("PasteDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("is closed without an image", () => {
    render(<PasteDialog image={undefined} onChoose={vi.fn()} />);
    expect(screen.queryByRole("dialog", { name: "Paste" })).toBeNull();
  });

  it("offers Expand canvas, Keep canvas size and Cancel for a pasted image (DOC-CLP-05)", () => {
    render(<PasteDialog image={image} onChoose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Paste" });
    expect(dialog.textContent).toContain("larger than the canvas size");
    expect(screen.getByRole("button", { name: "Expand canvas" }).className).toContain("is-default");
    expect(screen.getByRole("button", { name: "Keep canvas size" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
  });

  it("reports the button the user chose", () => {
    const onChoose = vi.fn();
    render(<PasteDialog image={image} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand canvas" }));
    expect(onChoose).toHaveBeenLastCalledWith("expand");
    fireEvent.click(screen.getByRole("button", { name: "Keep canvas size" }));
    expect(onChoose).toHaveBeenLastCalledWith("keep");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChoose).toHaveBeenLastCalledWith("cancel");
  });

  it("treats Esc as Cancel", () => {
    const onChoose = vi.fn();
    render(<PasteDialog image={image} onChoose={onChoose} />);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Paste" }), { key: "Escape" });
    expect(onChoose).toHaveBeenLastCalledWith("cancel");
  });
});
