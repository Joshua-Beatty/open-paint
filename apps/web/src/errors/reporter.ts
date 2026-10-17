import type { Translate } from "@openpaint/i18n";
import type { ErrorLog, ErrorLogEntry } from "@openpaint/storage";
import { describeError, formatLogEntry } from "./error-entry";

/** One reported error: the entry that was logged, and whether it leaves the app unusable. */
export interface ErrorReport {
  readonly entry: ErrorLogEntry;
  readonly fatal: boolean;
}

export interface ReportOptions {
  /** A fatal error shows the OpenPaint Error dialog (SET-ERR-02). */
  readonly fatal?: boolean;
  /** Where the error was caught, such as the engine worker or an effect's name. */
  readonly context?: string;
}

export interface ErrorReporterOptions {
  readonly log: ErrorLog;
  readonly version: string;
  readonly translate: Translate;
  readonly now?: () => Date;
}

/** Produces the SET-ERR-05 report text. It may fail, and the entry then says so. */
export type DiagnosticsProvider = () => Promise<string>;

/**
 * Turns caught errors into local log entries (SET-ERR-01, WEB-SEC-03) and tells the host about
 * fatal ones. The same reporter serves the global handlers, the engine worker and the effects.
 */
export class ErrorReporter {
  readonly log: ErrorLog;
  readonly #options: ErrorReporterOptions;
  readonly #fatalListeners = new Set<(report: ErrorReport) => void>();
  #diagnostics: DiagnosticsProvider;

  constructor(options: ErrorReporterOptions) {
    this.log = options.log;
    this.#options = options;
    this.#diagnostics = async () => options.translate("error.log.unavailable");
  }

  /** Installs the source of the diagnostics block (SET-ERR-05), once the app can gather it. */
  setDiagnostics(provider: DiagnosticsProvider): void {
    this.#diagnostics = provider;
  }

  /** Calls `listener` with every fatal report. Returns the function that stops it. */
  onFatal(listener: (report: ErrorReport) => void): () => void {
    this.#fatalListeners.add(listener);
    return () => {
      this.#fatalListeners.delete(listener);
    };
  }

  /** Logs `cause` and returns what was logged. Fatal reports also go to the fatal listeners. */
  async report(cause: unknown, options: ReportOptions = {}): Promise<ErrorReport> {
    const { translate, version } = this.#options;
    const time = (this.#options.now ?? (() => new Date()))();
    const formatted = formatLogEntry({
      time,
      version,
      details: describeError(cause),
      context: options.context,
      diagnostics: await this.#gatherDiagnostics(),
      translate,
    });
    const entry = this.log.record({
      time: time.toISOString(),
      title: formatted.title,
      text: formatted.text,
    });
    const report: ErrorReport = { entry, fatal: options.fatal === true };
    if (report.fatal) {
      for (const listener of this.#fatalListeners) listener(report);
    }
    return report;
  }

  async #gatherDiagnostics(): Promise<string> {
    try {
      return await this.#diagnostics();
    } catch {
      return this.#options.translate("error.log.unavailable");
    }
  }
}
