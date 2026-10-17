import type { HistoryCommand } from "@openpaint/document";
import type { SettingsStore, SettingValue } from "@openpaint/storage";

/** The option values a step was made with. Undo and redo write them back (TL-FRAME-02). */
export type SettingSnapshot = Readonly<Record<string, SettingValue | undefined>>;

/**
 * The states a pending object passed through (TL-FRAME-01, "Undo while Dirty"). Each state is
 * stored under the history item that ended it. The first state belongs to the item that was
 * latest when the session began. When undo or redo makes an item latest, the session takes that
 * item's state again, so a Dirty object stays editable after undo, redo and commit.
 */
export class PendingSteps<S> {
  readonly #steps: { readonly command: HistoryCommand | undefined; readonly state: S }[];
  #index = 0;

  constructor(anchor: HistoryCommand | undefined, initial: S) {
    this.#steps = [{ command: anchor, state: initial }];
  }

  /**
   * The state that `latest` ends, or undefined when that item is not one of the session's steps.
   * The located step becomes the base of the next `record`.
   */
  locate(latest: HistoryCommand | undefined): S | undefined {
    const index = this.#steps.findIndex((step) => step.command === latest);
    const step = this.#steps[index];
    if (step === undefined) return undefined;
    this.#index = index;
    return step.state;
  }

  /** Records the state that `command` ends, after the located step. Steps undone since are dropped. */
  record(command: HistoryCommand, state: S): void {
    this.#steps.length = this.#index + 1;
    this.#steps.push({ command, state });
    this.#index = this.#steps.length - 1;
  }
}

/** The current values of `paths`, taken when a step is recorded. */
export function snapshotSettings(
  settings: Pick<SettingsStore, "get">,
  paths: readonly string[],
): SettingSnapshot {
  return Object.fromEntries(paths.map((path) => [path, settings.get(path)]));
}

/**
 * Writes the snapshot's values back where they differ. The caller ignores the change events this
 * raises, because undo and redo do not record a step.
 */
export function restoreSettings(
  settings: Pick<SettingsStore, "get" | "set">,
  snapshot: SettingSnapshot,
): void {
  for (const [path, value] of Object.entries(snapshot)) {
    if (value === undefined) continue;
    if (JSON.stringify(settings.get(path)) !== JSON.stringify(value)) settings.set(path, value);
  }
}
