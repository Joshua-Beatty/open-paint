import { CURVES_DIALOG_ID, LEVELS_DIALOG_ID } from "@openpaint/effects";
import { CurvesDialog } from "./curves/CurvesDialog";
import type { CustomDialogComponent } from "./custom-dialog-types";
import { LevelsDialog } from "./levels/LevelsDialog";

/**
 * The custom dialog providers, by token (EXT-V1-02, EXT-03-03). An effect names its token in its
 * descriptor's `customDialog`, and the runtime shows the matching editor in place of the generated
 * dialog. A token with no provider falls back to the generated dialog.
 */
export const CUSTOM_DIALOGS: ReadonlyMap<string, CustomDialogComponent> = new Map<
  string,
  CustomDialogComponent
>([
  [LEVELS_DIALOG_ID, LevelsDialog],
  [CURVES_DIALOG_ID, CurvesDialog],
]);
