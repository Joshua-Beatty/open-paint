import type { MessageId } from "@openpaint/i18n";
import type { ControlOptions, PropertySchema } from "@openpaint/properties";

export type HelpKind = "none" | "plainText" | "custom";

/** The options that shape the dialog itself rather than one control (EXT-06C-02). */
export interface DialogSettings {
  /** A custom title that replaces the dialog's title. */
  readonly title?: MessageId;
  readonly widthScale: number;
  readonly resizable: boolean;
  readonly bottomSeparator: boolean;
  readonly help: HelpKind;
  readonly helpContent: string;
  /** Plain-text help from the message catalog, which replaces `helpContent`. */
  readonly helpMessage?: MessageId;
}

/**
 * The dialog-level options of a schema. Each comes from the first control, in declaration order,
 * that sets it. Without one, the dialog uses the defaults: width 1, fixed size, a bottom separator
 * and no help button.
 */
export function dialogSettings(schema: PropertySchema): DialogSettings {
  const controls = schema.properties.flatMap((definition) =>
    definition.control === undefined ? [] : [definition.control],
  );
  const first = <K extends keyof ControlOptions>(key: K): ControlOptions[K] => {
    for (const control of controls) {
      const value = control[key];
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const helpMessage = first("dialogHelpMessage");
  return {
    title: first("dialogTitle"),
    widthScale: first("dialogWidthScale") ?? 1,
    resizable: first("dialogIsResizable") ?? false,
    bottomSeparator: first("dialogShowBottomSeparator") ?? true,
    help: first("dialogHelpContentType") ?? (helpMessage === undefined ? "none" : "plainText"),
    helpContent: first("dialogHelpContent") ?? "",
    ...(helpMessage === undefined ? {} : { helpMessage }),
  };
}
