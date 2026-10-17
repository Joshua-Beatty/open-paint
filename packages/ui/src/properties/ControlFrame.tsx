import { useTranslation } from "@openpaint/i18n/react";
import { type ReactNode, useContext } from "react";
import { Button } from "react-aria-components";
import { ControlLayoutContext, STRIP_ITEM_ATTRIBUTE } from "./layout-context";

export interface ControlFrameProps {
  /** The name the control is known by. It names the reset button. */
  readonly name: string;
  /** Heading text, or undefined for a control without a heading. */
  readonly heading?: string;
  readonly showHeaderLine: boolean;
  readonly description?: string;
  readonly footnote?: string;
  /** Shows the reset-to-default button when given. */
  readonly onReset?: () => void;
  readonly resetDisabled: boolean;
  /** The short label before the control in the inline layout, or undefined for none. */
  readonly inlineLabel?: string;
  readonly children: ReactNode;
}

/**
 * The chrome around one control: heading with its header line, description, body, reset and
 * footnote. In the inline layout it is one strip item: an optional short label and the control,
 * since a toolbar row has no room for headings, notes or reset buttons.
 */
export function ControlFrame({
  name,
  heading,
  showHeaderLine,
  description,
  footnote,
  onReset,
  resetDisabled,
  inlineLabel,
  children,
}: ControlFrameProps) {
  const t = useTranslation();
  const layout = useContext(ControlLayoutContext);
  if (layout === "inline") {
    return (
      <div className="prop-control is-inline" {...{ [STRIP_ITEM_ATTRIBUTE]: "" }}>
        {inlineLabel !== undefined && (
          <span className="prop-inline-label" aria-hidden="true">
            {inlineLabel}
          </span>
        )}
        {children}
      </div>
    );
  }
  return (
    <div className="prop-control">
      {heading !== undefined && (
        <div className="prop-heading-row">
          <span className="prop-heading">{heading}</span>
          {showHeaderLine && <hr className="prop-header-line" />}
        </div>
      )}
      {description !== undefined && <p className="prop-description">{description}</p>}
      <div className="prop-body">
        {children}
        {onReset !== undefined && (
          <Button
            className="prop-reset"
            aria-label={t("property.resetFor", { name })}
            isDisabled={resetDisabled}
            onPress={onReset}
          >
            {t("property.reset")}
          </Button>
        )}
      </div>
      {footnote !== undefined && <p className="prop-footnote">{footnote}</p>}
    </div>
  );
}
