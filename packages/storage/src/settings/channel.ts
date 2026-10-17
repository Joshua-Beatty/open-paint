/** The BroadcastChannel that keeps every open tab's settings in step (WEB-UI-07). */
export const SETTINGS_CHANNEL_NAME = "openpaint-settings";

/** One changed setting. A null value means the setting is absent, so it has its default. */
export interface SettingChangeRecord {
  readonly path: string;
  readonly value: unknown | null;
}

export interface SettingsChangeMessage {
  readonly type: "settings-changed";
  readonly changes: readonly SettingChangeRecord[];
}

export interface SettingsChannel {
  post(message: SettingsChangeMessage): void;
  /** Calls the listener for messages from other instances. Returns the unsubscribe function. */
  listen(listener: (message: unknown) => void): () => void;
  close(): void;
}

/** A BroadcastChannel-backed channel, or undefined where the browser has none. */
export function openSettingsChannel(
  name: string = SETTINGS_CHANNEL_NAME,
): SettingsChannel | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  const channel = new BroadcastChannel(name);
  return {
    post: (message) => channel.postMessage(message),
    listen(listener) {
      const handler = (event: MessageEvent) => listener(event.data);
      channel.addEventListener("message", handler);
      return () => channel.removeEventListener("message", handler);
    },
    close: () => channel.close(),
  };
}
