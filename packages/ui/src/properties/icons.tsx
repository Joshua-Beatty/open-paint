import { iconShape } from "@openpaint/properties";
import "./controls.css";

/**
 * An icon from icon data (`iconShape`) in the text color: 16 x 16 path data is stroked as the
 * class sets, a `filledIcon` is filled (`svg.icon-filled`).
 */
export function Icon({ icon, className }: { readonly icon: string; readonly className: string }) {
  const shape = iconShape(icon);
  return (
    <svg
      className={shape.filled ? `${className} icon-filled` : className}
      viewBox={shape.viewBox}
      aria-hidden="true"
      focusable="false"
    >
      <path d={shape.path} />
    </svg>
  );
}

/** A 16 px option icon from icon data, in the text color. */
export function OptionIcon({ path }: { readonly path: string }) {
  return <Icon icon={path} className="prop-icon" />;
}

/** The small down chevron at the end of a drop-down button. */
export function DropdownChevron() {
  return (
    <svg className="prop-chevron" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 3.5 5 6.5 8 3.5" />
    </svg>
  );
}

/** The up or down chevron of a number field's small stepper button. */
export function StepperIcon({ up }: { readonly up: boolean }) {
  return (
    <svg className="prop-stepper-icon" viewBox="0 0 8 5" aria-hidden="true">
      <path d={up ? "M1 4 4 1 7 4" : "M1 1 4 4 7 1"} />
    </svg>
  );
}
