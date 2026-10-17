import { useEffect, useState } from "react";

/** The Color Scheme choice in Settings (UI-THEME-01). */
export type ColorSchemePreference = "Automatic" | "Light" | "Dark";

/** The scheme that is actually drawn. */
export type ColorScheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Picks the drawn scheme. "Automatic" follows the OS preference (WEB-UI-03). */
export function resolveColorScheme(
  preference: ColorSchemePreference,
  systemPrefersDark: boolean,
): ColorScheme {
  if (preference === "Light") return "light";
  if (preference === "Dark") return "dark";
  return systemPrefersDark ? "dark" : "light";
}

function systemPrefersDarkNow(): boolean {
  return globalThis.matchMedia?.(DARK_QUERY).matches ?? false;
}

/**
 * Resolves the scheme and keeps it on the document root as `data-color-scheme`, which the shell
 * stylesheet reads. It updates live when the OS preference changes (UI-THEME-01).
 */
export function useColorScheme(preference: ColorSchemePreference): ColorScheme {
  const [systemPrefersDark, setSystemPrefersDark] = useState(systemPrefersDarkNow);

  useEffect(() => {
    const query = globalThis.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const update = () => setSystemPrefersDark(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const scheme = resolveColorScheme(preference, systemPrefersDark);

  useEffect(() => {
    document.documentElement.dataset.colorScheme = scheme;
  }, [scheme]);

  return scheme;
}
