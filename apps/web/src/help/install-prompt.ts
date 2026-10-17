/** The event Chromium-based browsers fire when the app can be installed. It is not in the DOM typings. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>;
}

/** The part of a window that the install hint listens to. */
export interface InstallEventTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface InstallHintSnapshot {
  /** The hint is on screen. */
  readonly visible: boolean;
}

export interface InstallHintOptions {
  /** True when the app already runs as an installed app (`display-mode: standalone`). */
  readonly installed: boolean;
}

/**
 * The non-blocking install hint, shown on the first launch where the browser can install the app
 * (08 SET-LIFE-01 step 4, [SHOULD]). The hint waits for the browser's deferred install prompt and
 * never shows in an installed app. It only runs the browser's own prompt when the user asks.
 */
export class InstallHint {
  readonly #installed: boolean;
  readonly #listeners = new Set<() => void>();
  #firstRun = false;
  #deferred: BeforeInstallPromptEvent | undefined;
  #dismissed = false;
  #snapshot: InstallHintSnapshot = { visible: false };

  constructor(options: InstallHintOptions) {
    this.#installed = options.installed;
  }

  get snapshot(): InstallHintSnapshot {
    return this.#snapshot;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Listens for the browser's install events on `target`, and returns the detach. */
  attach(target: InstallEventTarget): () => void {
    const onPrompt = (event: Event) => this.offer(event as BeforeInstallPromptEvent);
    const onInstalled = () => this.markInstalled();
    target.addEventListener("beforeinstallprompt", onPrompt);
    target.addEventListener("appinstalled", onInstalled);
    return () => {
      target.removeEventListener("beforeinstallprompt", onPrompt);
      target.removeEventListener("appinstalled", onInstalled);
    };
  }

  /** Marks this launch as the first run, so the hint may show (SET-LIFE-01). */
  beginFirstRun(): void {
    this.#firstRun = true;
    this.#publish();
  }

  /** The browser can install the app. The event is kept until the user asks (WEB-ENV-03). */
  offer(event: BeforeInstallPromptEvent): void {
    event.preventDefault();
    this.#deferred = event;
    this.#publish();
  }

  /** The app is installed, so the hint never shows again. */
  markInstalled(): void {
    this.#deferred = undefined;
    this.#publish();
  }

  /** "Not now": hides the hint for this launch. */
  dismiss(): void {
    if (this.#dismissed) return;
    this.#dismissed = true;
    this.#publish();
  }

  /** Runs the browser's install prompt. The hint hides whatever the user answers. */
  async install(): Promise<void> {
    const event = this.#deferred;
    if (event === undefined) return;
    this.#deferred = undefined;
    this.#publish();
    await event.prompt();
  }

  #publish(): void {
    const visible =
      this.#firstRun && !this.#installed && !this.#dismissed && this.#deferred !== undefined;
    if (visible === this.#snapshot.visible) return;
    this.#snapshot = { visible };
    for (const listener of this.#listeners) listener();
  }
}

/** True when the app runs in its installed window, from the `display-mode` media query. */
export function isInstalledApp(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
