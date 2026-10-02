import en from "./en.json";
import ar from "./ar.json";
import type { Language } from "../models/types";

type Dict = Record<string, string>;

const dictionaries: Record<Language, Dict> = { en, ar };

export function t(lang: Language, key: string, vars?: Record<string, string | number>): string {
  const dict = dictionaries[lang] || dictionaries.en;
  let str = dict[key] ?? dictionaries.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(`{${k}}`, String(v));
    }
  }
  return str;
}

export function dirFor(lang: Language): "rtl" | "ltr" {
  return lang === "ar" ? "rtl" : "ltr";
}
