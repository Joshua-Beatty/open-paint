import { useTranslation } from "@openpaint/i18n/react";
import { filledIcon } from "@openpaint/properties";
import { type ReactNode, useRef, useState } from "react";
import { Button, Heading, Tooltip } from "react-aria-components";
import { Icon } from "../properties/icons";
import { TooltipTrigger } from "../tooltip";
import "../properties/property-dialog.css";
import "./dialog-chrome.css";
import { useDialogDrag } from "./use-dialog-drag";

/**
 * Phosphor Icons 2.1.1 (MIT, Copyright (c) 2023 Phosphor Icons) "x" in the bold weight, copied
 * unmodified from assets/bold/x-bold.svg, like the app's icon set (apps/web/src/icons/icon-set.ts).
 */
const CLOSE_ICON = filledIcon(
  256,
  "M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z",
);

export interface DialogTitleBarProps {
  /** The dialog's title, the heading that names the dialog. */
  readonly title: ReactNode;
  /**
   * What the dialog's Cancel (or Close) does. When given, a close button sits in the title bar's
   * top-right corner and does exactly that. Dialogs the user must answer pass nothing.
   */
  readonly onClose?: (() => void) | undefined;
  /** Disables the close button, for example while a cancel is already under way. */
  readonly closeDisabled?: boolean;
  /**
   * Which dialog this is, so it reopens where the user dragged it this session. Defaults to the
   * title when that is a string.
   */
  readonly positionKey?: string;
}

/**
 * The shared title bar of every modal dialog: the heading, and a 28 px close button with the
 * accessible name and tooltip "Close" in the top-right corner. Esc still closes the dialog through
 * the overlay, so the button is only another way to cancel. Dragging the bar moves the dialog, for
 * example off the part of the canvas a preview changes; double-clicking it centres the dialog.
 */
export function DialogTitleBar({
  title,
  onClose,
  closeDisabled = false,
  positionKey,
}: DialogTitleBarProps) {
  const t = useTranslation();
  // The tooltip shows on hover only: on keyboard focus it would take the first Esc, so closing the
  // dialog would need two. The button's accessible name already says "Close".
  const hovered = useRef(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const drag = useDialogDrag(bar, positionKey ?? (typeof title === "string" ? title : undefined));
  return (
    <div ref={bar} className="modal-header" {...drag}>
      <Heading slot="title" className="modal-title">
        {title}
      </Heading>
      {onClose !== undefined && (
        <TooltipTrigger
          delay={500}
          isOpen={tooltipOpen}
          onOpenChange={(open) => setTooltipOpen(open && hovered.current)}
        >
          <Button
            className="modal-close"
            aria-label={t("dialog.close")}
            isDisabled={closeDisabled}
            onHoverChange={(isHovering) => {
              hovered.current = isHovering;
              if (!isHovering) setTooltipOpen(false);
            }}
            onPress={onClose}
          >
            <Icon icon={CLOSE_ICON} className="modal-close-icon" />
          </Button>
          <Tooltip className="prop-tooltip">{t("dialog.close")}</Tooltip>
        </TooltipTrigger>
      )}
    </div>
  );
}
