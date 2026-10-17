import { createContext, type ReactNode, useContext, useMemo } from "react";
import { type Catalog, createTranslator, enUS, NEUTRAL_LOCALE, type Translate } from "./index";

const TranslationContext = createContext<Translate>(createTranslator(NEUTRAL_LOCALE, enUS));

export interface I18nProviderProps {
  /** BCP 47 tag used for formatting. Defaults to the neutral en-US. */
  locale?: string;
  /** Messages for `locale`. Defaults to the en-US catalog. */
  catalog?: Catalog;
  children: ReactNode;
}

/** Supplies the translator to the component tree. Components read it with `useTranslation`. */
export function I18nProvider({
  locale = NEUTRAL_LOCALE,
  catalog = enUS,
  children,
}: I18nProviderProps) {
  const translate = useMemo(() => createTranslator(locale, catalog), [locale, catalog]);
  return <TranslationContext value={translate}>{children}</TranslationContext>;
}

/** Returns the `t(id, values?)` function for the nearest `I18nProvider`. */
export function useTranslation(): Translate {
  return useContext(TranslationContext);
}
