import { IndexedDbSettingsBackend, MemorySettingsBackend, type SettingsBackend } from "./backend";
import {
  openSettingsChannel,
  type SettingChangeRecord,
  type SettingsChangeMessage,
  type SettingsChannel,
} from "./channel";
import {
  findDefinition,
  type GpuPerformanceClass,
  SETTING_DEFINITIONS,
  type SettingDefinition,
  type SettingsContext,
  type SettingValue,
} from "./definitions";
import { SETTINGS_MIGRATIONS, SETTINGS_SCHEMA_VERSION, type SettingsMigration } from "./migrations";
import { defaultMirror, type MirrorStorage, writeMirror } from "./mirror";
import { cloneSetting, defaultOf, normalizeSetting } from "./values";

/** The record that holds the schema version (SET-STO-01). */
export const SCHEMA_VERSION_KEY = "settings.schemaVersion";

const DEFAULT_FLUSH_DELAY_MS = 500;

export class SettingsError extends Error {
  override readonly name = "SettingsError";
}

/** A change to one setting. `value` is the effective value after the change. */
export interface SettingChange {
  readonly path: string;
  readonly value: SettingValue | undefined;
  readonly source: "local" | "remote";
}

export type SettingsListener = (change: SettingChange) => void;

/** The page events that flush pending writes (SET-STO-01): `pagehide` and hiding the document. */
export interface SettingsLifecycle {
  readonly page: EventTarget;
  readonly document: EventTarget & { readonly visibilityState: string };
}

export interface SettingsStoreOptions {
  /** Where records live. Defaults to the IndexedDB `settings` store. */
  readonly backend?: SettingsBackend;
  /** Live sync with other tabs (WEB-UI-07). Defaults to a BroadcastChannel; null disables it. */
  readonly channel?: SettingsChannel | null;
  /** The localStorage mirror for early values. Defaults to localStorage; null disables it. */
  readonly mirror?: MirrorStorage | null;
  /** The page events to flush on. Defaults to the window and document; null disables them. */
  readonly lifecycle?: SettingsLifecycle | null;
  readonly migrations?: readonly SettingsMigration[];
  readonly schemaVersion?: number;
  /** How long writes wait before they are batched and flushed (SET-STO-01). */
  readonly flushDelayMs?: number;
}

interface Change {
  readonly path: string;
  readonly value: SettingValue | undefined;
}

/**
 * The settings of one app instance (SET-STO-01..03, SET-STO-05, SET-STO-06). Reads are
 * synchronous from memory. Writes take effect at once, are batched and flushed to storage, and
 * are broadcast to the other open tabs. A removed record means the setting has its default.
 */
export class SettingsStore {
  /** False when storage could not be opened, so settings live only for this session. */
  readonly persistent: boolean;
  readonly #backend: SettingsBackend;
  /** The stored image: every record, including keys this build does not know. */
  readonly #records: Map<string, unknown>;
  /** Stored, valid values of known settings. Absent entries have their defaults. */
  readonly #values = new Map<string, SettingValue>();
  readonly #pendingWrites = new Map<string, unknown>();
  readonly #pendingDeletes = new Set<string>();
  readonly #listeners = new Set<SettingsListener>();
  readonly #channel: SettingsChannel | null;
  readonly #mirror: MirrorStorage | null;
  readonly #flushDelayMs: number;
  readonly #stopChannel: () => void;
  readonly #stopLifecycle: () => void;
  #context: SettingsContext = { gpuPerformanceClass: "VeryLow" };
  #timer: ReturnType<typeof setTimeout> | undefined;
  #chain: Promise<void> = Promise.resolve();

  private constructor(
    persistent: boolean,
    backend: SettingsBackend,
    records: Map<string, unknown>,
    channel: SettingsChannel | null,
    mirror: MirrorStorage | null,
    lifecycle: SettingsLifecycle | null,
    flushDelayMs: number,
  ) {
    this.persistent = persistent;
    this.#backend = backend;
    this.#records = records;
    this.#channel = channel;
    this.#mirror = mirror;
    this.#flushDelayMs = flushDelayMs;
    this.#stopChannel = channel ? channel.listen((message) => this.#receive(message)) : () => {};
    if (lifecycle) {
      const onPageHide = () => this.#flushQuietly();
      const onVisibility = () => {
        if (lifecycle.document.visibilityState === "hidden") this.#flushQuietly();
      };
      lifecycle.page.addEventListener("pagehide", onPageHide);
      lifecycle.document.addEventListener("visibilitychange", onVisibility);
      this.#stopLifecycle = () => {
        lifecycle.page.removeEventListener("pagehide", onPageHide);
        lifecycle.document.removeEventListener("visibilitychange", onVisibility);
      };
    } else {
      this.#stopLifecycle = () => {};
    }
  }

  /**
   * Opens the settings. Migrations run before anything is read (SET-STO-01). If the backend cannot
   * be read, the store works in memory with `persistent` false.
   */
  static async open(options: SettingsStoreOptions = {}): Promise<SettingsStore> {
    let backend = options.backend ?? new IndexedDbSettingsBackend();
    let records: Map<string, unknown>;
    let persistent = true;
    try {
      records = await backend.readAll();
    } catch {
      backend = new MemorySettingsBackend();
      records = new Map();
      persistent = false;
    }
    const channel = options.channel === undefined ? openSettingsChannel() : options.channel;
    const mirror = options.mirror === undefined ? defaultMirror() : options.mirror;
    const lifecycle = options.lifecycle === undefined ? defaultLifecycle() : options.lifecycle;
    const store = new SettingsStore(
      persistent,
      backend,
      records,
      channel ?? null,
      mirror,
      lifecycle,
      options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS,
    );
    store.#load(
      options.migrations ?? SETTINGS_MIGRATIONS,
      options.schemaVersion ?? SETTINGS_SCHEMA_VERSION,
    );
    store.#syncMirror();
    return store;
  }

  /** The effective value of a setting: the stored value, else its default. */
  get(path: string): SettingValue | undefined {
    const definition = this.#definition(path);
    const stored = this.#values.get(path);
    return stored === undefined
      ? defaultOf(definition, this.#context)
      : cloneSetting(definition.type, stored);
  }

  /** Stores a value. It is clamped to the setting's range and rejected when its type is wrong. */
  set(path: string, value: SettingValue): void {
    const definition = this.#definition(path);
    this.#apply([{ path, value: validate(definition, value) }], true);
  }

  /** Restores one setting to its default. Remembered values are removed (SET-STO-06). */
  reset(path: string): void {
    this.#definition(path);
    this.#apply([{ path, value: undefined }], true);
  }

  /** Restores every `layout.*` setting to its default (SET-STO-05). Dialog bounds are kept. */
  resetPanelLayout(): void {
    this.#apply(
      this.#storedChanges((path) => path.startsWith("layout.")),
      true,
    );
  }

  /**
   * Restores every known setting to its default, including remembered effect and adjustment
   * values (SET-STO-05, SET-STO-06). Keys this build does not know are kept.
   */
  resetAll(): void {
    this.#apply(
      this.#storedChanges(() => true),
      true,
    );
  }

  /**
   * Switches the rendering backend and resets the GPU effect quality to the default for the new
   * device's performance class (SET-DLG-07a, SET-STO-03).
   */
  changeBackend(backend: string, gpuPerformanceClass: GpuPerformanceClass): void {
    const value = validate(this.#definition("graphics.backend"), backend);
    this.#context = { ...this.#context, gpuPerformanceClass };
    this.#apply(
      [
        { path: "graphics.backend", value },
        { path: "effects.defaultQualityGpu", value: undefined },
      ],
      true,
    );
    this.#emit(["effects.defaultQualityGpu"], "local");
  }

  /**
   * Sets the GPU performance class that the GPU quality default depends on. Nothing is written,
   * and a change to the default is announced.
   */
  setGpuPerformanceClass(gpuPerformanceClass: GpuPerformanceClass): void {
    this.#context = { ...this.#context, gpuPerformanceClass };
    this.#emit(["effects.defaultQualityGpu"], "local");
  }

  /**
   * Sets whether the browser asks for reduced motion. While "Animations" has never been stored,
   * its default follows this (WEB-UI-04). Nothing is written, and a change to the default is announced.
   */
  setReducedMotion(reducedMotion: boolean): void {
    this.#context = { ...this.#context, reducedMotion };
    if (this.#values.get("ui.animations") === undefined) this.#emit(["ui.animations"], "local");
  }

  /** Calls the listener for every change, local or from another tab (SET-STO-02). */
  onChange(listener: SettingsListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Writes all pending changes now. Rejects, and keeps them for retry, if the write fails. */
  flush(): Promise<void> {
    this.#cancelTimer();
    const run = this.#chain.then(() => this.#commit());
    this.#chain = run.catch(() => {});
    return run;
  }

  /** Flushes pending writes, then stops listening and closes the channel. */
  async dispose(): Promise<void> {
    this.#stopLifecycle();
    this.#stopChannel();
    try {
      await this.flush();
    } finally {
      this.#channel?.close();
      this.#listeners.clear();
    }
  }

  #load(migrations: readonly SettingsMigration[], schemaVersion: number): void {
    const stored = this.#records.get(SCHEMA_VERSION_KEY);
    const storedVersion =
      typeof stored === "number" && Number.isInteger(stored) && stored >= 1 ? stored : 1;
    if (storedVersion < schemaVersion) {
      const before = [...this.#records.keys()];
      for (let version = storedVersion; version < schemaVersion; version += 1) {
        migrations.find((migration) => migration.from === version)?.migrate(this.#records);
      }
      for (const key of before) {
        if (!this.#records.has(key)) this.#pendingDeletes.add(key);
      }
      for (const [key, value] of this.#records) this.#pendingWrites.set(key, value);
    }
    if (storedVersion <= schemaVersion && this.#records.get(SCHEMA_VERSION_KEY) !== schemaVersion) {
      this.#records.set(SCHEMA_VERSION_KEY, schemaVersion);
      this.#pendingWrites.set(SCHEMA_VERSION_KEY, schemaVersion);
    }
    for (const [key, raw] of this.#records) {
      const definition = findDefinition(key);
      if (!definition) continue;
      const value = normalizeSetting(definition, raw);
      if (value !== undefined) this.#values.set(key, value);
    }
    if (this.#pendingWrites.size > 0 || this.#pendingDeletes.size > 0) this.#schedule();
  }

  /** Keeps the localStorage mirror equal to the effective values of mirrored settings. */
  #syncMirror(): void {
    if (!this.#mirror) return;
    for (const definition of SETTING_DEFINITIONS) {
      if (definition.mirrored) {
        writeMirror(definition.key, this.get(definition.key), this.#mirror);
      }
    }
  }

  #definition(path: string): SettingDefinition {
    const definition = findDefinition(path);
    if (!definition) throw new SettingsError(`Unknown setting: ${path}.`);
    return definition;
  }

  #storedChanges(match: (path: string) => boolean): Change[] {
    return [...this.#records.keys()]
      .filter((path) => path !== SCHEMA_VERSION_KEY && findDefinition(path) && match(path))
      .map((path) => ({ path, value: undefined }));
  }

  /** Applies changes locally (written, mirrored, broadcast) or from another tab (in memory only). */
  #apply(changes: readonly Change[], local: boolean): void {
    const applied = changes.filter(
      ({ path, value }) => value !== undefined || this.#records.has(path),
    );
    if (applied.length === 0) return;
    for (const { path, value } of applied) {
      if (value === undefined) {
        this.#values.delete(path);
        this.#records.delete(path);
        if (local) {
          this.#pendingWrites.delete(path);
          this.#pendingDeletes.add(path);
        }
      } else {
        this.#values.set(path, value);
        this.#records.set(path, value);
        if (local) {
          this.#pendingDeletes.delete(path);
          this.#pendingWrites.set(path, value);
        }
      }
    }
    if (local) {
      if (this.#mirror) {
        for (const { path, value } of applied) {
          if (this.#definition(path).mirrored) writeMirror(path, value, this.#mirror);
        }
      }
      this.#schedule();
      this.#channel?.post({
        type: "settings-changed",
        changes: applied.map(
          ({ path, value }): SettingChangeRecord => ({ path, value: value ?? null }),
        ),
      });
    }
    this.#emit(
      applied.map(({ path }) => path),
      local ? "local" : "remote",
    );
  }

  #emit(paths: readonly string[], source: SettingChange["source"]): void {
    for (const path of paths) {
      const change: SettingChange = { path, value: this.get(path), source };
      for (const listener of this.#listeners) listener(change);
    }
  }

  #receive(message: unknown): void {
    if (!isChangeMessage(message)) return;
    const changes: Change[] = [];
    for (const change of message.changes) {
      const definition = typeof change?.path === "string" ? findDefinition(change.path) : undefined;
      if (!definition) continue;
      if (change.value === null) {
        changes.push({ path: change.path, value: undefined });
        continue;
      }
      const value = normalizeSetting(definition, change.value);
      if (value !== undefined) changes.push({ path: change.path, value });
    }
    this.#apply(changes, false);
  }

  #schedule(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flushQuietly();
    }, this.#flushDelayMs);
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #flushQuietly(): void {
    void this.flush().catch(() => {});
  }

  async #commit(): Promise<void> {
    if (this.#pendingWrites.size === 0 && this.#pendingDeletes.size === 0) return;
    const writes = new Map(this.#pendingWrites);
    const deletes = new Set(this.#pendingDeletes);
    this.#pendingWrites.clear();
    this.#pendingDeletes.clear();
    try {
      await this.#backend.commit(writes, deletes);
    } catch (error) {
      for (const [path, value] of writes) {
        if (!this.#pendingWrites.has(path) && !this.#pendingDeletes.has(path)) {
          this.#pendingWrites.set(path, value);
        }
      }
      for (const path of deletes) {
        if (!this.#pendingWrites.has(path)) this.#pendingDeletes.add(path);
      }
      this.#schedule();
      throw error;
    }
  }
}

function validate(definition: SettingDefinition, value: SettingValue): SettingValue {
  const normalized = normalizeSetting(definition, value);
  if (normalized === undefined) throw new SettingsError(`Invalid value for ${definition.key}.`);
  return normalized;
}

function defaultLifecycle(): SettingsLifecycle | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  return { page: window, document };
}

function isChangeMessage(value: unknown): value is SettingsChangeMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "settings-changed" &&
    Array.isArray((value as { changes?: unknown }).changes)
  );
}
