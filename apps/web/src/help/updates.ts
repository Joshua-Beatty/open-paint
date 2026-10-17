/** Checks for a new version every 24 hours while the app is open (SET-UPD-02, proposed). */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How the service worker is reached. The app stays on its own side of this boundary. */
export interface UpdateHost {
  /** Asks the browser for a new service worker. Resolves true when a new version is waiting. */
  check(): Promise<boolean>;
  /** Makes the waiting version the active one and reloads the page. Callers check for unsaved work first. */
  activate(): void;
}

/** For a browser with no service worker. Nothing is ever waiting, and a check reports an error. */
export const NO_SERVICE_WORKER: UpdateHost = {
  check: () => Promise.reject(new Error("Service workers are not supported.")),
  activate: () => {},
};

/** The update states of SET-UPD-04, as the UI shows them. */
export type UpdateState =
  | "idle"
  | "checking"
  | "upToDate"
  | "updateAvailable"
  | "error"
  | "offline";

export interface UpdateSnapshot {
  readonly state: UpdateState;
  /** The update notice is on screen. "Later" hides it until the next time a version is found. */
  readonly noticeVisible: boolean;
}

/** The result of the last check, before a waiting version is taken into account. */
type CheckResult = "idle" | "upToDate" | "error" | "offline";

export interface UpdateControllerOptions {
  readonly isOnline: () => boolean;
  readonly intervalMs?: number;
}

/**
 * Tracks the update state for the notice and the manual "Check for updates" result (SET-UPD-01,
 * SET-UPD-02, SET-UPD-04). It never reloads the page by itself. Reloading is `applyUpdate`, which
 * the app calls only after its unsaved-work check.
 */
export class UpdateController {
  readonly #host: UpdateHost;
  readonly #isOnline: () => boolean;
  readonly #intervalMs: number;
  readonly #listeners = new Set<() => void>();
  #result: CheckResult = "idle";
  #lastCheckedAt: Date | undefined;
  #checking = false;
  #waiting = false;
  #dismissed = false;
  #snapshot: UpdateSnapshot = { state: "idle", noticeVisible: false };

  constructor(host: UpdateHost, options: UpdateControllerOptions) {
    this.#host = host;
    this.#isOnline = options.isOnline;
    this.#intervalMs = options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  }

  get snapshot(): UpdateSnapshot {
    return this.#snapshot;
  }

  /** When the service worker was last asked for an update, or undefined before the first check (SET-ERR-05). */
  get lastCheckedAt(): Date | undefined {
    return this.#lastCheckedAt;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Checks again on each interval while the app stays open, and returns the stop. The start-up check
   * is the caller's, since it needs the service worker to be registered first.
   */
  start(): () => void {
    const timer = setInterval(() => void this.checkNow(), this.#intervalMs);
    return () => clearInterval(timer);
  }

  /** The "Check for updates" action. Shows its result inline (SET-DLG-09). */
  async checkNow(): Promise<void> {
    if (!this.#isOnline()) {
      this.#finish("offline");
      return;
    }
    this.#checking = true;
    this.#publish();
    try {
      const waiting = await this.#host.check();
      if (waiting) this.#markWaiting();
      this.#checking = false;
      this.#lastCheckedAt = new Date();
      this.#finish("upToDate");
    } catch {
      this.#checking = false;
      this.#lastCheckedAt = new Date();
      this.#finish("error");
    }
  }

  /** The service worker reported a new version that is installed and waiting (SET-UPD-01). */
  markWaiting(): void {
    this.#markWaiting();
    this.#publish();
  }

  /** "Later": hides the notice. The new version is used the next time the app opens. */
  dismissNotice(): void {
    if (this.#dismissed) return;
    this.#dismissed = true;
    this.#publish();
  }

  /** Reloads onto the waiting version. The caller has already handled unsaved changes. */
  applyUpdate(): void {
    this.#host.activate();
  }

  #markWaiting(): void {
    if (!this.#waiting) this.#dismissed = false;
    this.#waiting = true;
  }

  #finish(result: CheckResult): void {
    this.#result = result;
    this.#publish();
  }

  #publish(): void {
    const state: UpdateState = this.#checking
      ? "checking"
      : this.#waiting
        ? "updateAvailable"
        : this.#result;
    const noticeVisible = this.#waiting && !this.#dismissed;
    if (state === this.#snapshot.state && noticeVisible === this.#snapshot.noticeVisible) return;
    this.#snapshot = { state, noticeVisible };
    for (const listener of this.#listeners) listener();
  }
}
