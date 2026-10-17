import type { SettingsStore } from "@openpaint/storage";
import { useEffect } from "react";

/**
 * Keeps the "Animations" default in step with `prefers-reduced-motion` (WEB-UI-04, UI-ANIM-01).
 * The default is off while the browser asks for reduced motion, until the user stores a choice.
 */
export function useReducedMotionSetting(settings: SettingsStore | null): void {
  useEffect(() => {
    if (settings === null || typeof globalThis.matchMedia !== "function") return;
    const query = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => settings.setReducedMotion(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [settings]);
}
