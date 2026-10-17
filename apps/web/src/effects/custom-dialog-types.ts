import type { EffectSource } from "@openpaint/effects";
import type { PropertySchema, PropertyValues } from "@openpaint/properties";
import type { ReactElement } from "react";

/**
 * What a custom dialog gets from the runtime (EXT-V1-02). It edits the same token as the generated
 * dialog, so its changes go through the same preview, OK and Cancel.
 */
export interface CustomDialogProps {
  readonly title: string;
  readonly schema: PropertySchema;
  /** The starting values, the remembered ones or the defaults. */
  readonly values: PropertyValues;
  /** The pixels the effect reads, and the selection over them, for analysis. */
  readonly source: EffectSource | undefined;
  readonly onValuesChange: (values: PropertyValues) => void;
  readonly onOk: (values: PropertyValues) => void;
  readonly onCancel: () => void;
}

export type CustomDialogComponent = (props: CustomDialogProps) => ReactElement;
