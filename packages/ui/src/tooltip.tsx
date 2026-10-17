import {
  TooltipTrigger as AriaTooltipTrigger,
  type TooltipTriggerComponentProps,
} from "react-aria-components";
import "./tooltip.css";

/**
 * The app's tooltip trigger. A tooltip closes as soon as the pointer leaves its trigger, with no
 * grace period for moving onto the tooltip, and the tooltip never takes the pointer (tooltip.css),
 * so it cannot get in the way of a neighbouring button. Keyboard focus still opens it (WEB-A11Y).
 */
export function TooltipTrigger({ closeDelay = 0, ...props }: TooltipTriggerComponentProps) {
  return <AriaTooltipTrigger closeDelay={closeDelay} {...props} />;
}
