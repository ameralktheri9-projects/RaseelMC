export interface BilingualOption {
  value: string;
  en: string;
  ar: string;
}

// Common nationalities for a Saudi medical center's workforce. Not exhaustive — "Other" covers
// anything missing rather than trying to enumerate every country.
export const NATIONALITIES: BilingualOption[] = [
  { value: "Saudi", en: "Saudi", ar: "سعودي" },
  { value: "Egyptian", en: "Egyptian", ar: "مصري" },
  { value: "Jordanian", en: "Jordanian", ar: "أردني" },
  { value: "Syrian", en: "Syrian", ar: "سوري" },
  { value: "Lebanese", en: "Lebanese", ar: "لبناني" },
  { value: "Palestinian", en: "Palestinian", ar: "فلسطيني" },
  { value: "Sudanese", en: "Sudanese", ar: "سوداني" },
  { value: "Yemeni", en: "Yemeni", ar: "يمني" },
  { value: "Indian", en: "Indian", ar: "هندي" },
  { value: "Pakistani", en: "Pakistani", ar: "باكستاني" },
  { value: "Filipino", en: "Filipino", ar: "فلبيني" },
  { value: "Bangladeshi", en: "Bangladeshi", ar: "بنغلاديشي" },
  { value: "Sri Lankan", en: "Sri Lankan", ar: "سريلانكي" },
  { value: "Nepali", en: "Nepali", ar: "نيبالي" },
  { value: "Indonesian", en: "Indonesian", ar: "إندونيسي" },
  { value: "Moroccan", en: "Moroccan", ar: "مغربي" },
  { value: "Tunisian", en: "Tunisian", ar: "تونسي" },
  { value: "Algerian", en: "Algerian", ar: "جزائري" },
  { value: "American", en: "American", ar: "أمريكي" },
  { value: "British", en: "British", ar: "بريطاني" },
  { value: "Other", en: "Other", ar: "أخرى" },
];

// Raseel MC operates under more than one commercial registration.
export const CR_TYPES: BilingualOption[] = [
  { value: "main", en: "Main", ar: "الرئيسي" },
  { value: "branch", en: "Branch", ar: "الفرع" },
  { value: "optics", en: "Optics", ar: "البصريات" },
];

export const SPONSORSHIP_TYPES: BilingualOption[] = [
  { value: "company", en: "Company sponsorship", ar: "كفالة الشركة" },
  { value: "other", en: "Other sponsorship", ar: "كفالة أخرى" },
];

export const SAUDI_BANKS: BilingualOption[] = [
  { value: "Al Rajhi Bank", en: "Al Rajhi Bank", ar: "مصرف الراجحي" },
  { value: "Saudi National Bank", en: "Saudi National Bank (SNB)", ar: "البنك الأهلي السعودي" },
  { value: "Riyad Bank", en: "Riyad Bank", ar: "بنك الرياض" },
  { value: "Banque Saudi Fransi", en: "Banque Saudi Fransi", ar: "البنك السعودي الفرنسي" },
  { value: "Arab National Bank", en: "Arab National Bank", ar: "البنك العربي الوطني" },
  { value: "Saudi British Bank", en: "Saudi British Bank (SABB)", ar: "البنك السعودي البريطاني" },
  { value: "Alinma Bank", en: "Alinma Bank", ar: "مصرف الإنماء" },
  { value: "Bank Aljazira", en: "Bank Aljazira", ar: "بنك الجزيرة" },
  { value: "Bank Albilad", en: "Bank Albilad", ar: "بنك البلاد" },
  { value: "Gulf International Bank", en: "Gulf International Bank", ar: "بنك الخليج الدولي" },
  { value: "Other", en: "Other", ar: "أخرى" },
];

// Default initial contract term when a contract start date is set but no end date is computed
// yet — standard 2-year term, renewable. Not currently configurable per BRD/user spec.
export const DEFAULT_CONTRACT_LENGTH_MONTHS = 24;
