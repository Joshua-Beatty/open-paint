import { t } from "@openpaint/i18n";
import { ErrorLog, MemoryErrorLogBackend } from "@openpaint/storage";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FatalErrorDialog, FatalErrorHost, mountFatalErrorHost } from "./FatalErrorDialog";
import { type ErrorReport, ErrorReporter } from "./reporter";

function makeReporter() {
  const log = new ErrorLog(new MemoryErrorLogBackend());
  return new ErrorReporter({ log, version: "1.0.0", translate: t });
}

async function fatalReport(reporter: ErrorReporter): Promise<ErrorReport> {
  return reporter.report(new Error("the crash"), { fatal: true });
}

describe("FatalErrorDialog (SET-ERR-02)", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("shows the title, the message and the two buttons", async () => {
    const report = await fatalReport(makeReporter());
    render(<FatalErrorDialog report={report} onReload={vi.fn()} />);

    expect(screen.getByText("OpenPaint Error")).toBeTruthy();
    expect(
      screen.getByText("Sorry, but OpenPaint has encountered an unexpected error and must reload."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy details" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload OpenPaint" })).toBeTruthy();
  });

  it("shows the log entry only after Show details is pressed", async () => {
    const report = await fatalReport(makeReporter());
    render(<FatalErrorDialog report={report} onReload={vi.fn()} />);

    expect(document.getElementById("error-details")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));

    expect(document.getElementById("error-details")?.textContent).toBe(report.entry.text);
    expect(screen.getByRole("button", { name: "Hide details" })).toBeTruthy();
  });

  it("copies the full entry text with Copy details", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const report = await fatalReport(makeReporter());
    render(<FatalErrorDialog report={report} onReload={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    await act(async () => undefined);

    expect(writeText).toHaveBeenCalledWith(report.entry.text);
    expect(screen.getByText("The details were copied to the clipboard.")).toBeTruthy();
  });

  it("reports a failed copy", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async () => Promise.reject(new Error("denied")) },
      configurable: true,
    });
    const report = await fatalReport(makeReporter());
    render(<FatalErrorDialog report={report} onReload={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));

    expect(await screen.findByText("The details could not be copied.")).toBeTruthy();
  });

  it("reloads from Reload OpenPaint without asking about saves", async () => {
    const onReload = vi.fn();
    const report = await fatalReport(makeReporter());
    render(<FatalErrorDialog report={report} onReload={onReload} />);

    fireEvent.click(screen.getByRole("button", { name: "Reload OpenPaint" }));

    expect(onReload).toHaveBeenCalledTimes(1);
  });
});

describe("FatalErrorHost", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows nothing until a fatal report arrives", async () => {
    const reporter = makeReporter();
    render(<FatalErrorHost reporter={reporter} onReload={vi.fn()} />);

    expect(screen.queryByText("OpenPaint Error")).toBeNull();
    await act(async () => {
      await fatalReport(reporter);
    });

    expect(await screen.findByText("OpenPaint Error")).toBeTruthy();
  });

  it("does not show a report that is not fatal", async () => {
    const reporter = makeReporter();
    render(<FatalErrorHost reporter={reporter} onReload={vi.fn()} />);

    await act(async () => {
      await reporter.report(new Error("minor"));
    });

    expect(screen.queryByText("OpenPaint Error")).toBeNull();
  });

  it("mounts in its own root and unmounts with its container", async () => {
    const reporter = makeReporter();
    let unmount: () => void = () => undefined;
    act(() => {
      unmount = mountFatalErrorHost(reporter, vi.fn());
    });
    const before = document.body.children.length;

    await act(async () => {
      await fatalReport(reporter);
    });
    expect(await screen.findByText("OpenPaint Error")).toBeTruthy();

    unmount();
    expect(document.body.children.length).toBe(before - 1);
    expect(screen.queryByText("OpenPaint Error")).toBeNull();
  });
});
