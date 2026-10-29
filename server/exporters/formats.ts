// Localization resource exporters. Each format is an adapter: it receives the entries of one
// language (or all languages, for multi-locale formats) and returns files. Adding a format is a
// matter of registering another adapter in FORMATS.

export interface Entry {
  identifier: string;
  value: string | null; // null = missing in this language (after missing-policy handling)
  source: string;
  description: string;
}

export interface LocaleBundle {
  code: string; // BCP-47
  isSource: boolean;
  entries: Entry[];
}

export interface ExportFile {
  path: string;
  content: string;
}

export interface FormatOptions {
  nested: boolean;
  sourceCode: string;
}

export interface FormatAdapter {
  id: string;
  label: string;
  extension: string;
  description: string;
  supportsNested?: boolean;
  /** Multi-locale formats get every bundle at once. */
  multiLocale?: boolean;
  render(bundles: LocaleBundle[], opts: FormatOptions, warn: (msg: string) => void): ExportFile[];
}

// --------------------------------------------------------------------------- locale helpers
const ANDROID_SCRIPT_REGION: Record<string, string> = { 'zh-Hans': 'zh-rCN', 'zh-Hant': 'zh-rTW' };
const ANDROID_LEGACY_LANG: Record<string, string> = { he: 'iw', id: 'in', yi: 'ji' };

/** Android resource qualifier for a BCP-47 code: values-it, values-pt-rBR, values-zh-rCN, values-b+fil. */
export function androidValuesDir(code: string, isSource: boolean): string {
  if (isSource) return 'values';
  if (ANDROID_SCRIPT_REGION[code]) return `values-${ANDROID_SCRIPT_REGION[code]}`;
  const [lang, ...rest] = code.split('-');
  const l = ANDROID_LEGACY_LANG[lang] ?? lang.toLowerCase();
  if (l.length === 3 || rest.some((p) => p.length === 4)) return `values-b+${[l, ...rest].join('+')}`;
  if (rest.length === 0) return `values-${l}`;
  if (rest.length === 1 && /^[A-Za-z]{2}$/.test(rest[0])) return `values-${l}-r${rest[0].toUpperCase()}`;
  return `values-b+${[l, ...rest].join('+')}`;
}

/** Apple lproj folder: en.lproj, pt-BR.lproj, zh-Hans.lproj. */
export function appleLproj(code: string): string {
  return `${code}.lproj`;
}

/** Flutter ARB suffix: app_pt_BR.arb, app_zh_Hant.arb. */
export function arbLocale(code: string): string {
  return code.replace(/-/g, '_');
}

// ------------------------------------------------------------------------------ escaping
export function androidName(identifier: string): string | null {
  const n = identifier
    .normalize('NFKD')
    .replace(/[​-‏﻿]/g, '')
    .replace(/[^A-Za-z0-9_.]/g, '_');
  if (!/^[A-Za-z_]/.test(n)) return null;
  return n;
}

export function escapeAndroid(value: string): string {
  let v = value
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\t/g, '\\t');
  if (/^[@?]/.test(v)) v = '\\' + v;
  // Leading/trailing spaces are collapsed by aapt unless quoted.
  if (/^\s|\s$/.test(value) && !/^\s+$/.test(value)) v = `"${v}"`;
  return v;
}

export function escapeAppleStrings(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function escapeXmlComment(s: string) {
  return s.replace(/--/g, '- -').replace(/\r?\n/g, ' ');
}

function poEscape(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r\n|\r|\n/g, '\\n').replace(/\t/g, '\\t');
}

function csvCell(s: string) {
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Counts unpositioned printf specifiers; Android needs formatted="false" when there are several. */
function unpositionedFormats(v: string): number {
  return (v.match(/%(?!\d+\$)[-+ 0#]*\d*(?:\.\d+)?[sdif]/g) ?? []).length;
}

// ---------------------------------------------------------------------------- adapters
const present = (b: LocaleBundle) => b.entries.filter((e): e is Entry & { value: string } => e.value !== null);

function nest(entries: { identifier: string; value: string }[], warn: (m: string) => void): Record<string, unknown> {
  const root: Record<string, any> = {};
  for (const e of entries) {
    const parts = e.identifier.split('.');
    let node = root;
    let ok = true;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (node[p] === undefined) node[p] = {};
      else if (typeof node[p] !== 'object') {
        ok = false;
        break;
      }
      node = node[p];
    }
    const leaf = parts[parts.length - 1];
    if (!ok || (node[leaf] !== undefined && typeof node[leaf] === 'object') || parts.some((p) => p === '')) {
      warn(`"${e.identifier}" collides with a nested group; written as a flat key`);
      root[e.identifier] = e.value;
    } else node[leaf] = e.value;
  }
  return root;
}

export const FORMATS: FormatAdapter[] = [
  {
    id: 'json',
    label: 'JSON',
    extension: 'json',
    description: 'Generic key/value JSON (i18next, Vue I18n, React Intl). Flat or nested by "."',
    supportsNested: true,
    render: (bundles, opts, warn) =>
      bundles.map((b) => {
        const entries = present(b);
        const obj = opts.nested ? nest(entries, warn) : Object.fromEntries(entries.map((e) => [e.identifier, e.value]));
        return { path: `${b.code}.json`, content: JSON.stringify(obj, null, 2) + '\n' };
      }),
  },
  {
    id: 'android',
    label: 'Android XML (Kotlin/Java)',
    extension: 'xml',
    description: 'res/values-*/strings.xml string resources, used by Kotlin and Java Android apps',
    render: (bundles, _opts, warn) =>
      bundles.map((b) => {
        const seen = new Map<string, string>();
        const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<resources>'];
        for (const e of present(b)) {
          const name = androidName(e.identifier);
          if (!name) {
            warn(`[${b.code}] "${e.identifier}" is not a valid Android resource name; skipped`);
            continue;
          }
          if (seen.has(name)) {
            warn(`[${b.code}] "${e.identifier}" and "${seen.get(name)}" both map to "${name}"; second skipped`);
            continue;
          }
          seen.set(name, e.identifier);
          if (name !== e.identifier) warn(`[${b.code}] "${e.identifier}" renamed to "${name}" for Android`);
          const formatted = unpositionedFormats(e.value) > 1 ? ' formatted="false"' : '';
          if (e.description) lines.push(`    <!-- ${escapeXmlComment(e.description)} -->`);
          lines.push(`    <string name="${name}"${formatted}>${escapeAndroid(e.value)}</string>`);
        }
        lines.push('</resources>', '');
        return { path: `${androidValuesDir(b.code, b.isSource)}/strings.xml`, content: lines.join('\n') };
      }),
  },
  {
    id: 'ios-strings',
    label: 'iOS / macOS .strings',
    extension: 'strings',
    description: 'Apple Localizable.strings in <locale>.lproj folders (UTF-8)',
    render: (bundles) =>
      bundles.map((b) => ({
        path: `${appleLproj(b.code)}/Localizable.strings`,
        content:
          present(b)
            .map((e) => `${e.description ? `/* ${e.description.replace(/\*\//g, '* /')} */\n` : ''}"${escapeAppleStrings(e.identifier)}" = "${escapeAppleStrings(e.value)}";`)
            .join('\n') + '\n',
      })),
  },
  {
    id: 'xcstrings',
    label: 'Apple String Catalog (.xcstrings)',
    extension: 'xcstrings',
    description: 'Xcode 15+ Localizable.xcstrings containing every selected language',
    multiLocale: true,
    render: (bundles, opts) => {
      const strings: Record<string, any> = {};
      for (const b of bundles) {
        for (const e of b.entries) {
          strings[e.identifier] ??= { extractionState: 'manual', localizations: {} };
          if (e.description) strings[e.identifier].comment = e.description;
          if (e.value !== null) strings[e.identifier].localizations[b.code] = { stringUnit: { state: 'translated', value: e.value } };
        }
      }
      return [{ path: 'Localizable.xcstrings', content: JSON.stringify({ sourceLanguage: opts.sourceCode, strings, version: '1.0' }, null, 2) + '\n' }];
    },
  },
  {
    id: 'arb',
    label: 'Flutter ARB',
    extension: 'arb',
    description: 'app_<locale>.arb files for flutter gen-l10n',
    render: (bundles, _opts, warn) =>
      bundles.map((b) => {
        const obj: Record<string, unknown> = { '@@locale': arbLocale(b.code) };
        for (const e of present(b)) {
          if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(e.identifier)) {
            warn(`[${b.code}] "${e.identifier}" is not a valid ARB/Dart identifier; skipped`);
            continue;
          }
          obj[e.identifier] = e.value;
          if (e.description && b.isSource) obj[`@${e.identifier}`] = { description: e.description };
        }
        return { path: `app_${arbLocale(b.code)}.arb`, content: JSON.stringify(obj, null, 2) + '\n' };
      }),
  },
  {
    id: 'po',
    label: 'Gettext PO',
    extension: 'po',
    description: 'One .po per language; msgctxt = key, msgid = source text',
    render: (bundles) =>
      bundles.map((b) => {
        const out = ['msgid ""', 'msgstr ""', `"Language: ${b.code}\\n"`, '"MIME-Version: 1.0\\n"', '"Content-Type: text/plain; charset=UTF-8\\n"', '"Content-Transfer-Encoding: 8bit\\n"', ''];
        for (const e of b.entries) {
          if (e.description) out.push(`#. ${e.description.replace(/\r?\n/g, ' ')}`);
          out.push(`msgctxt "${poEscape(e.identifier)}"`, `msgid "${poEscape(e.source)}"`, `msgstr "${poEscape(e.value ?? '')}"`, '');
        }
        return { path: `${b.code}.po`, content: out.join('\n') };
      }),
  },
  {
    id: 'yaml',
    label: 'YAML',
    extension: 'yml',
    description: 'Rails-style <locale>: { key: "value" } YAML (JSON-quoted scalars)',
    render: (bundles) =>
      bundles.map((b) => ({
        path: `${b.code}.yml`,
        content: `${JSON.stringify(b.code)}:\n` + present(b).map((e) => `  ${JSON.stringify(e.identifier)}: ${JSON.stringify(e.value)}`).join('\n') + '\n',
      })),
  },
  {
    id: 'csv',
    label: 'CSV',
    extension: 'csv',
    description: 'key,source,translation per language (UTF-8 with BOM for Excel)',
    render: (bundles) =>
      bundles.map((b) => ({
        path: `${b.code}.csv`,
        content: '﻿' + ['key,source,translation', ...b.entries.map((e) => [e.identifier, e.source, e.value ?? ''].map(csvCell).join(','))].join('\r\n') + '\r\n',
      })),
  },
];

export function getFormat(id: string): FormatAdapter | undefined {
  return FORMATS.find((f) => f.id === id);
}
