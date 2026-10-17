/** What the host asks the file picker for, from a file control's file-type filter (EXT-06C-02). */
export interface FilePickRequest {
  /** Dot-prefixed extensions. */
  readonly fileTypes: readonly string[];
  readonly allowAllFiles: boolean;
}

/**
 * Host capabilities that a generated dialog uses. Each one is optional: a control whose service is
 * missing hides the button that needs it (a folder chooser with no directory picker is a text field).
 */
export interface PropertyServices {
  /** Opens the host's file picker. Resolves to the chosen name, or undefined when cancelled. */
  readonly pickFile?: (request: FilePickRequest) => Promise<string | undefined>;
  /** Opens a directory picker where the browser has one. */
  readonly pickFolder?: () => Promise<string | undefined>;
  /** Returns a URL for an image resource key, for example a pan pad's underlay. */
  readonly resolveImage?: (key: string) => string | undefined;
  /** Receives the content of a `custom` help button (EXT-06C-02 dialogHelpContentType). */
  readonly onHelpRequested?: (content: string) => void;
}
