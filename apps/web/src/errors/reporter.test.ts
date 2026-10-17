import { t } from "@openpaint/i18n";
import { ErrorLog, MemoryErrorLogBackend } from "@openpaint/storage";
import { describe, expect, it, vi } from "vitest";
import { ErrorReporter } from "./reporter";

const NOW = new Date("2026-10-13T12:00:00.000Z");

function makeReporter() {
  const log = new ErrorLog(new MemoryErrorLogBackend());
  const reporter = new ErrorReporter({ log, version: "9.9.9", translate: t, now: () => NOW });
  return { log, reporter };
}

describe("ErrorReporter (SET-ERR-01)", () => {
  it("logs a caught error with its message, time and version", async () => {
    const { log, reporter } = makeReporter();

    const report = await reporter.report(new Error("boom"));

    expect(report.fatal).toBe(false);
    expect(report.entry).toBe(log.entries[0]);
    expect(log.entries[0]?.title).toBe("Error: boom");
    expect(log.entries[0]?.time).toBe("2026-10-13T12:00:00.000Z");
    expect(log.entries[0]?.text).toContain("Version: 9.9.9");
  });

  it("includes the diagnostics from the provider", async () => {
    const { log, reporter } = makeReporter();
    reporter.setDiagnostics(async () => "OpenPaint 9.9.9\n  Browser: Chrome 130");

    await reporter.report("failed");

    expect(log.entries[0]?.text).toContain("OpenPaint 9.9.9\n  Browser: Chrome 130");
  });

  it("says the diagnostics are unavailable when the provider fails", async () => {
    const { log, reporter } = makeReporter();
    reporter.setDiagnostics(async () => {
      throw new Error("no storage");
    });

    await reporter.report("failed");

    expect(log.entries[0]?.text).toContain(t("error.log.unavailable"));
  });

  it("says the diagnostics are unavailable before a provider is set", async () => {
    const { log, reporter } = makeReporter();

    await reporter.report("failed");

    expect(log.entries[0]?.text).toContain(t("error.log.unavailable"));
  });

  it("records the place the error was caught", async () => {
    const { log, reporter } = makeReporter();

    await reporter.report(new Error("lost"), { context: "engine worker" });

    expect(log.entries[0]?.text).toContain("Context: engine worker");
  });

  it("titles a thrown non-Error with its text", async () => {
    const { log, reporter } = makeReporter();

    await reporter.report("plain text");

    expect(log.entries[0]?.title).toBe("plain text");
  });

  it("calls fatal listeners only for fatal reports", async () => {
    const { reporter } = makeReporter();
    const listener = vi.fn();
    reporter.onFatal(listener);

    await reporter.report(new Error("minor"));
    const fatal = await reporter.report(new Error("major"), { fatal: true });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(fatal);
  });

  it("stops calling a fatal listener after it is removed", async () => {
    const { reporter } = makeReporter();
    const listener = vi.fn();
    const stop = reporter.onFatal(listener);
    stop();

    await reporter.report(new Error("major"), { fatal: true });

    expect(listener).not.toHaveBeenCalled();
  });
});
