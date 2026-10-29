// Reference data derived from the inspection of "Keywords (5).xlsx".
// This is configuration, not translation content: it seeds languages, their legacy
// aliases and the platform list. Everything here can be changed later in the UI.

export interface LanguageSeed {
  code: string;
  name: string;
  nativeName: string;
  direction?: 'ltr' | 'rtl';
  isSource?: boolean;
  /** Workbook header labels and codes that refer to this language. */
  aliases: string[];
  note?: string;
}

export const LANGUAGE_SEEDS: LanguageSeed[] = [
  { code: 'en', name: 'English', nativeName: 'English', isSource: true, aliases: ['English', 'en'] },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', direction: 'rtl', aliases: ['Arabic', 'ar'] },
  { code: 'az', name: 'Azerbaijani', nativeName: 'Azərbaycanca', aliases: ['Azeri', 'az'] },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština', aliases: ['Czech (čeština)', 'Czech', 'cs'] },
  { code: 'da', name: 'Danish', nativeName: 'Dansk', aliases: ['Danish', 'da'] },
  { code: 'de', name: 'German', nativeName: 'Deutsch', aliases: ['German', 'Germany', 'Deutsch DE', 'Deutsch', 'de'] },
  { code: 'de-AT', name: 'German (Austria)', nativeName: 'Deutsch (Österreich)', aliases: ['Deutsch AT', 'de-AT'] },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά', aliases: ['Greek', 'el'] },
  { code: 'es', name: 'Spanish', nativeName: 'Español', aliases: ['Spanish', 'es'] },
  { code: 'et', name: 'Estonian', nativeName: 'Eesti', aliases: ['et-EE (Estonian)', 'et-EE (Estonian) - new', 'et-EE', 'et'] },
  { code: 'fa', name: 'Persian', nativeName: 'فارسی', direction: 'rtl', aliases: ['Persian', 'fa'] },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi', aliases: ['Finnish', 'fi'] },
  {
    code: 'fr', name: 'French', nativeName: 'Français', aliases: ['French', 'Francais', 'Français', 'Francais   k2', 'fr'],
    note: 'Workbook has both "French" (formal, vous) and "Francais" (informal, tu) columns. "French" is primary; differing "Francais" values are kept as alternates and raised as conflicts.',
  },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית', direction: 'rtl', aliases: ['Hebrew', 'he'] },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', aliases: ['Hindi', 'hi'] },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar', aliases: ['Magyar', 'Hungarian', 'hu'] },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', aliases: ['Italian', 'it'] },
  { code: 'km', name: 'Khmer', nativeName: 'ខ្មែរ', aliases: ['Khmer', 'km'] },
  {
    code: 'ckb', name: 'Kurdish (Sorani)', nativeName: 'کوردی', direction: 'rtl', aliases: ['Kurdish', 'CKB', 'ckb', 'ku'],
    note: 'The "Kurdish" columns contain Sorani (Arabic script) text identical to the "CKB" column, so both map to ckb. The legacy code "ku" is kept as an alias.',
  },
  { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu', aliases: ['Malaysia', 'Malay', 'ms'] },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', aliases: ['Dutch', 'nl'] },
  { code: 'pt', name: 'Portuguese (Portugal)', nativeName: 'Português', aliases: ['Portuguese', 'pt'] },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)', aliases: ['PT-BR (Brazil)', 'pt-br'] },
  { code: 'ro', name: 'Romanian', nativeName: 'Română', aliases: ['Romanian', 'ro'] },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', aliases: ['Russian', 'Русский', 'ru'] },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', aliases: ['Turkish', 'tr'] },
  {
    code: 'tl', name: 'Tagalog', nativeName: 'Tagalog', aliases: ['Tagalog', 'tl'],
    note: 'Kept separate from Filipino: the two columns differ in ~95 Web Service rows.',
  },
  { code: 'fil', name: 'Filipino', nativeName: 'Filipino', aliases: ['Filipino', 'fil'] },
  { code: 'zh-Hans', name: 'Chinese (Simplified)', nativeName: '简体中文', aliases: ['Chinese (Simplified)', 'zh-Hans', 'zh', 'zh-CN'] },
  { code: 'zh-Hant', name: 'Chinese (Traditional)', nativeName: '繁體中文', aliases: ['Chinese Traditional (zh-Hant)', 'zh-Hant', 'zh-TW'] },
];

export interface PlatformSeed {
  slug: string;
  name: string;
  kind: 'ios' | 'android' | 'web' | 'document' | 'other';
  sheet: string;
  archived?: boolean;
  description?: string;
}

export const PLATFORM_SEEDS: PlatformSeed[] = [
  { slug: 'ios-driver', name: 'iOS Driver', kind: 'ios', sheet: 'iOS Driver' },
  { slug: 'ios-customer', name: 'iOS Customer', kind: 'ios', sheet: 'iOS Customer' },
  { slug: 'android-driver', name: 'Android Driver', kind: 'android', sheet: 'Android Driver' },
  { slug: 'android-customer', name: 'Android Customer', kind: 'android', sheet: 'Android Customer' },
  { slug: 'web-service', name: 'Web Service', kind: 'web', sheet: 'Web Service' },
  { slug: 'track-page', name: 'Track Page', kind: 'web', sheet: 'Track Page' },
  { slug: 'customer-panel', name: 'Customer PANEL', kind: 'web', sheet: 'Customer PANEL' },
  { slug: 'receipt', name: 'Receipt', kind: 'document', sheet: 'Receipt' },
  { slug: 'invoice', name: 'Invoice', kind: 'document', sheet: 'Invoice' },
  { slug: 'shipment-label', name: 'Shipment Label', kind: 'document', sheet: 'Shipment Label' },
  { slug: 'dispatcher', name: 'Dispatcher', kind: 'web', sheet: 'Dispatcher' },
  { slug: 'dashboard', name: 'Dashboard', kind: 'web', sheet: 'Dashboard' },
  {
    slug: 'web-service-legacy', name: 'Web Service (deprecated)', kind: 'web', sheet: 'Webservice - deprecated', archived: true,
    description: 'Archived import of the "Webservice - deprecated" worksheet. Kept read-only for history; superseded by Web Service.',
  },
  {
    slug: 'dashboard-frontend-legacy', name: 'Dashboard Front end (deprecated)', kind: 'web', sheet: 'Dashboard Front end - deprecate', archived: true,
    description: 'Archived import of the "Dashboard Front end - deprecate" worksheet. Superseded by Dashboard.',
  },
];

/**
 * Sheet-specific column overrides, for columns whose header is blank but whose contents
 * were verified during inspection. Keyed by sheet name → zero-based column index.
 */
export const COLUMN_OVERRIDES: Record<string, Record<number, string>> = {
  // Header cells are empty; values are German ("Registrieren") and Sorani Kurdish ("خۆتۆمارکردن").
  'iOS Customer': { 16: 'de', 17: 'ckb' },
};

/** Header labels for the non-language columns. */
export const KEYWORD_HEADERS = ['keyword', 'key', 'keywords', 'identifier'];
export const SEGMENT_HEADERS = ['screen', 'page', 'path', 'e', '-', 'segment', 'segments'];
export const NAMESPACE_HEADERS = ['namespace'];
export const PLATFORMS_HEADERS = ['platforms', 'platform'];
export const DESCRIPTION_HEADERS = ['description', 'note', 'notes', 'translator note'];

export function normalizeLabel(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}
