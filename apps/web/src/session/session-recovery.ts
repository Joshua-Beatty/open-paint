import {
  Document,
  type DocumentCheckpointManifest,
  isUntouchedBlankCheckpoint,
  type MemoryAccountant,
} from "@openpaint/document";
import {
  holdOwnerLock,
  liveSessionOwners,
  openSessionStore,
  requestPersistentStorage,
  type SessionCheckpoint,
  type SessionEntry,
  type SessionStore,
  sessionOwnerId,
} from "@openpaint/storage";
import { isBlankImage, type OpenImage } from "../tabs/open-image";
import { yieldWhileBusy } from "../workers/yield-to-host";

/** A document's checkpoint is written this long after its last change (WEB-MEM-05). */
export const CHECKPOINT_DELAY_MS = 1000;

/** A checkpoint from an earlier session that Restore can bring back (SET-LIFE-11). */
export interface SessionOffer {
  readonly id: string;
  readonly name: string;
}

/** An image rebuilt from a checkpoint. Track it under `key`, which names its new checkpoint. */
export interface RestoredImage {
  readonly name: string;
  readonly document: Document;
  readonly key: string;
}

/**
 * What a checkpoint stores next to its blobs: the tab name, the document manifest, and whether the
 * image had a file.
 */
interface Payload {
  readonly name: string;
  readonly manifest: DocumentCheckpointManifest;
  readonly file?: true;
}

interface Tracked {
  readonly key: string;
  image: OpenImage;
  unsubscribe: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  pending: Promise<void> | undefined;
  again: boolean;
  removed: boolean;
  /** The blobs of the last checkpoint written under `key`, which the next one keeps (L2). */
  stored: ReadonlySet<string>;
  /** True when a checkpoint may exist under `key`, so one that is no longer kept is deleted. */
  written: boolean;
}

interface Offer {
  readonly entry: SessionEntry;
  readonly checkpoint: SessionCheckpoint;
}

export interface SessionRecoveryOptions {
  readonly store: SessionStore;
  /** This instance's owner id. Its own checkpoints are always offered after a reload. */
  readonly owner: string;
  readonly liveOwners: typeof liveSessionOwners;
  readonly accountant: () => MemoryAccountant;
  readonly persist: () => Promise<boolean>;
  readonly onError: (error: unknown) => void;
  /**
   * True while an interactive edit is in progress: a tool stroke, drag or pending result, or an
   * effect dialog's live preview. Scheduled checkpoints wait until it ends, so a checkpoint never
   * saves a half-drawn preview as the layer's pixels.
   */
  readonly interacting?: () => boolean;
  /**
   * Pauses a checkpoint between the slices in which it copies the layers' pixels, so the copy of a
   * large image never makes one long task, and waits while the user interacts (L5).
   */
  readonly pause?: () => Promise<void>;
  readonly delayMs?: number;
  /**
   * The name a new image gets. An image with this name and no file whose content is still the
   * default blank image is neither checkpointed nor offered (`isBlankImage`).
   */
  readonly untitled?: string;
}

/**
 * Session recovery (WEB-MEM-05, SET-LIFE-02, SET-LIFE-11). Each open image is checkpointed to OPFS
 * after a change, under this instance's owner id. At start-up the checkpoints of instances that are
 * no longer alive, and this instance's own from before a reload, are offered for restore. Writes wait
 * until `begin` has fixed that list, so a new checkpoint cannot be offered as an old one.
 */
export class SessionRecovery {
  readonly #options: SessionRecoveryOptions;
  readonly #tracked = new Map<string, Tracked>();
  readonly #offers = new Map<string, Offer>();
  #enabled = false;
  #persistRequested = false;

  constructor(options: SessionRecoveryOptions) {
    this.#options = options;
  }

  /**
   * Starts checkpointing `image` under tab `id`. `key` names its checkpoint, and a new one is made
   * when none is given. Calling it again for the same document only updates the image.
   */
  track(id: string, image: OpenImage, key?: string): void {
    const known = this.#tracked.get(id);
    if (known !== undefined && known.image.document === image.document) {
      known.image = image;
      return;
    }
    if (known !== undefined) this.#drop(known);
    const entry: Tracked = {
      key: known?.key ?? key ?? crypto.randomUUID(),
      image,
      unsubscribe: () => {},
      timer: undefined,
      pending: undefined,
      again: false,
      removed: false,
      stored: new Set(),
      written: known?.written ?? key !== undefined,
    };
    // A selection preview changes nothing a checkpoint keeps until it is committed or put back.
    entry.unsubscribe = image.document.subscribe((change) => {
      if (change !== "selection") this.#schedule(entry);
    });
    this.#tracked.set(id, entry);
    this.#schedule(entry);
  }

  /** Stops checkpointing tab `id` and deletes its checkpoint, because the image was closed. */
  untrack(id: string): void {
    const entry = this.#tracked.get(id);
    if (entry === undefined) return;
    this.#tracked.delete(id);
    this.#drop(entry);
    this.#remove(entry);
  }

  /** Untracks every tab that is not in `ids`, such as images closed in another way. */
  retain(ids: readonly string[]): void {
    for (const id of [...this.#tracked.keys()]) {
      if (!ids.includes(id)) this.untrack(id);
    }
  }

  /**
   * Fixes the list of checkpoints to offer and starts writing. Returns the offers in store order.
   * Checkpoints of other instances that are alive are left alone, and damaged ones are not offered.
   */
  async begin(): Promise<readonly SessionOffer[]> {
    const live = await this.#options.liveOwners();
    for (const entry of await this.#options.store.list()) {
      const mine = entry.owner === this.#options.owner;
      if (!mine && (live === "all" || live.has(entry.owner))) continue;
      try {
        const checkpoint = await this.#options.store.read(entry.owner, entry.key);
        const payload = parsePayload(checkpoint.document);
        if (
          payload.file === undefined &&
          payload.name === this.#options.untitled &&
          isUntouchedBlankCheckpoint(payload.manifest)
        ) {
          await this.#options.store.remove(entry.owner, entry.key);
          continue;
        }
        this.#offers.set(offerId(entry), { entry, checkpoint });
      } catch {
        // A checkpoint that cannot be read is not offered, and stays in the store.
      }
    }
    this.#enabled = true;
    for (const entry of this.#tracked.values()) this.#schedule(entry);
    return [...this.#offers.entries()].map(([id, offer]) => ({
      id,
      name: parsePayload(offer.checkpoint.document).name,
    }));
  }

  /**
   * Rebuilds an offered image. A new checkpoint is written under a new key, and the old one is
   * deleted, so the restored image is saved as the same state (SET-LIFE-11).
   */
  async restore(offer: SessionOffer): Promise<RestoredImage> {
    const found = this.#offers.get(offer.id);
    if (found === undefined) throw new Error("The session checkpoint is no longer available.");
    this.#offers.delete(offer.id);
    const payload = parsePayload(found.checkpoint.document);
    const document = await Document.fromCheckpoint(
      { manifest: payload.manifest, blobs: found.checkpoint.blobs },
      { accountant: this.#options.accountant() },
    );
    const key = crypto.randomUUID();
    await this.#save(key, { name: payload.name, document });
    await this.#options.store.remove(found.entry.owner, found.entry.key);
    return { name: payload.name, document, key };
  }

  /** Deletes the checkpoints of the offers that the user chose to discard (SET-LIFE-11). */
  async discard(offers: readonly SessionOffer[]): Promise<void> {
    for (const offer of offers) {
      const found = this.#offers.get(offer.id);
      this.#offers.delete(offer.id);
      if (found !== undefined) {
        await this.#options.store.remove(found.entry.owner, found.entry.key);
      }
    }
  }

  /** True while a checkpoint is being written. */
  get saving(): boolean {
    return [...this.#tracked.values()].some((entry) => entry.pending !== undefined);
  }

  /**
   * Writes every tracked image's checkpoint now, and waits for the writes in progress. Unlike a
   * scheduled checkpoint, it does not wait for an interactive edit to end.
   */
  async flush(): Promise<void> {
    await Promise.all([...this.#tracked.values()].map((entry) => this.#write(entry, true)));
  }

  #schedule(entry: Tracked): void {
    if (!this.#enabled || entry.removed || entry.timer !== undefined) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.#write(entry, false);
    }, this.#options.delayMs ?? CHECKPOINT_DELAY_MS);
  }

  #write(entry: Tracked, now: boolean): Promise<void> {
    if (!this.#enabled || entry.removed) return Promise.resolve();
    if (entry.pending !== undefined) {
      entry.again = true;
      return entry.pending;
    }
    if (entry.image.document.history.busy || (!now && this.#options.interacting?.() === true)) {
      this.#schedule(entry);
      return Promise.resolve();
    }
    const kept = !isBlankImage(entry.image, this.#options.untitled);
    if (!kept && !entry.written) return Promise.resolve();
    entry.written = true;
    const work = kept
      ? this.#save(entry.key, entry.image, entry.stored)
      : this.#options.store.remove(this.#options.owner, entry.key).then(() => {
          entry.written = false;
          return new Set<string>();
        });
    entry.pending = work
      .then((stored) => {
        entry.stored = stored;
      })
      .catch((cause: unknown) => {
        entry.stored = new Set();
        this.#options.onError(cause);
      })
      .finally(() => {
        entry.pending = undefined;
        if (entry.removed) {
          this.#remove(entry);
        } else if (entry.again) {
          entry.again = false;
          this.#schedule(entry);
        }
      });
    return entry.pending;
  }

  /**
   * Writes the image's checkpoint under `key`. Blobs in `stored`, which the last write under `key`
   * left in the store, are kept rather than captured and written again. Returns the blobs the
   * checkpoint now holds.
   */
  async #save(
    key: string,
    image: OpenImage,
    stored: ReadonlySet<string> = new Set(),
  ): Promise<ReadonlySet<string>> {
    const checkpoint = await image.document.checkpoint(stored, this.#options.pause);
    const payload: Payload = {
      name: image.name,
      manifest: checkpoint.manifest,
      ...(image.file === undefined ? {} : { file: true }),
    };
    const retained = checkpoint.reused ?? [];
    await this.#options.store.write(this.#options.owner, key, {
      document: payload,
      blobs: checkpoint.blobs,
      retained,
    });
    if (!this.#persistRequested) {
      this.#persistRequested = true;
      void this.#options.persist();
    }
    return new Set([...checkpoint.blobs.keys(), ...retained]);
  }

  #drop(entry: Tracked): void {
    entry.removed = true;
    entry.unsubscribe();
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  #remove(entry: Tracked): void {
    this.#options.store.remove(this.#options.owner, entry.key).catch((cause: unknown) => {
      this.#options.onError(cause);
    });
  }
}

/**
 * The session recovery of this browser, or undefined when the origin has no OPFS. Holds this tab's
 * owner lock, so other tabs know this instance is alive (SET-LIFE-02).
 */
export function createSessionRecovery(
  onError: (error: unknown) => void,
  accountant: () => MemoryAccountant,
  interacting: () => boolean,
  untitled: string,
): SessionRecovery | undefined {
  const store = openSessionStore();
  if (store === undefined) return undefined;
  const owner = sessionOwnerId();
  holdOwnerLock(owner);
  return new SessionRecovery({
    store,
    owner,
    liveOwners: liveSessionOwners,
    accountant,
    persist: requestPersistentStorage,
    onError,
    interacting,
    pause: yieldWhileBusy(interacting),
    untitled,
  });
}

function offerId(entry: SessionEntry): string {
  return `${entry.owner}/${entry.key}`;
}

function parsePayload(value: unknown): Payload {
  if (typeof value === "object" && value !== null) {
    const { name, manifest, file } = value as Partial<Payload>;
    if (typeof name === "string" && typeof manifest === "object" && manifest !== null) {
      return { name, manifest, ...(file === true ? { file } : {}) };
    }
  }
  throw new Error("The session checkpoint is damaged.");
}
