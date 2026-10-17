import type { MessageId } from "@openpaint/i18n";
import type { PropertySchema } from "@openpaint/properties";

/**
 * The outline of a shape as SVG path data in a unit square (EXT-08-02, TL-SHAPE-02). The shape is
 * scaled to the drag rectangle when drawn.
 */
export interface ShapeGeometry {
  /**
   * SVG path data, for example `M 0,0 L 1,0 L 1,1 Z`. Tokens such as `{radius.x}` are replaced by
   * the property handle values when the shape is drawn (TL-SHAPE-02).
   */
  readonly path: string;
  readonly fillRule: "nonzero" | "evenodd";
  /** The natural width-to-height ratio that Shift keeps (TL-SHAPE-01). Defaults to 1. */
  readonly aspect?: number;
}

/** A shape in the Shapes tool's picker (EXT-08-02, TL-FRAME-07). */
export interface ShapeDescriptor {
  readonly id: string;
  /** The major API version this descriptor targets (EXT-02-13). */
  readonly apiVersion: number;
  readonly label: MessageId;
  /** Picker group, such as "basic". Groups appear in registration order. */
  readonly category: string;
  readonly geometry: ShapeGeometry;
  /** Shape-dependent toolbar settings (TL-OPT-SHAPE), keyed by their setting name, such as `shapes.radius`. */
  readonly settings: PropertySchema;
  /** Names of the property handles the shape shows on the canvas, for example `radius` or `tail`. */
  readonly handles?: readonly string[];
  /** A tool the picker opens instead of drawing this shape, such as Line / Curve (TL-SHAPE-02). */
  readonly tool?: string;
}
