// Placeholder detection and comparison. Pure functions used by the editor (live warnings)
// and by the API (warnings returned on save). Validation never rewrites values and never
// blocks a save: frameworks legitimately differ, so the result is advisory.

export interface PlaceholderRule {
  id: string;
  label: string;
  pattern: string; // JavaScript RegExp source, global flag is added automatically
  enabled: boolean;
}

export const DEFAULT_PLACEHOLDER_RULES: PlaceholderRule[] = [
  { id: 'mustache', label: '{{variable}}', pattern: String.raw`\{\{\s*[\w.\-]+\s*\}\}`, enabled: true },
  { id: 'dollar', label: '${var}', pattern: String.raw`\$\{[\w.\-]+\}`, enabled: true },
  { id: 'icu', label: '{name}', pattern: String.raw`(?<![{$])\{[A-Za-z_][\w.\-]*\}(?!\})`, enabled: true },
  { id: 'printf', label: '%s %d %@ %1$s %.2f', pattern: String.raw`%(?:\d+\$)?[-+ 0#]*\d*(?:\.\d+)?(?:ll|l|h)?[sdif@xXuc]`, enabled: true },
  { id: 'xxx', label: 'xxx (legacy marker)', pattern: String.raw`\bxxx\b`, enabled: true },
];

export interface PlaceholderIssue {
  kind: 'missing' | 'extra' | 'malformed' | 'too_long';
  token: string;
  message: string;
}

function compile(rules: PlaceholderRule[]): RegExp[] {
  const out: RegExp[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    try {
      out.push(new RegExp(r.pattern, 'g'));
    } catch {
      // An invalid custom rule is ignored rather than breaking editing.
    }
  }
  return out;
}

export function extractPlaceholders(text: string, rules = DEFAULT_PLACEHOLDER_RULES): string[] {
  const found: { index: number; token: string }[] = [];
  const taken: [number, number][] = [];
  for (const re of compile(rules)) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue; // overlapping, first rule wins
      taken.push([start, end]);
      found.push({ index: start, token: m[0].replace(/\s+/g, '') });
    }
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.token);
}

function counts(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Normalises positional printf (%1$s → %s) so reordering arguments is not flagged. */
function canonical(token: string): string {
  return token.replace(/^%\d+\$/, '%');
}

export function validateTranslation(
  source: string,
  translation: string,
  opts: { rules?: PlaceholderRule[]; maxLength?: number | null } = {},
): PlaceholderIssue[] {
  const issues: PlaceholderIssue[] = [];
  if (!translation) return issues;
  const rules = opts.rules ?? DEFAULT_PLACEHOLDER_RULES;
  const src = counts(extractPlaceholders(source, rules).map(canonical));
  const dst = counts(extractPlaceholders(translation, rules).map(canonical));
  for (const [tok, n] of src) {
    const have = dst.get(tok) ?? 0;
    if (have < n) issues.push({ kind: 'missing', token: tok, message: `Placeholder ${tok} is missing${n > 1 ? ` (${have}/${n})` : ''}` });
  }
  for (const [tok, n] of dst) {
    const want = src.get(tok) ?? 0;
    if (n > want) issues.push({ kind: 'extra', token: tok, message: `Placeholder ${tok} does not appear in the source` });
  }
  // Malformed: unbalanced mustache braces, or a stray "% " / "%" at end that looks like a broken specifier.
  const opens = (translation.match(/\{\{/g) ?? []).length;
  const closes = (translation.match(/\}\}/g) ?? []).length;
  if (opens !== closes) issues.push({ kind: 'malformed', token: '{{ }}', message: 'Unbalanced {{ }} braces' });
  const srcSingle = (source.match(/(?<!\{)\{(?!\{)/g) ?? []).length - (source.match(/(?<!\})\}(?!\})/g) ?? []).length;
  const dstSingle = (translation.match(/(?<!\{)\{(?!\{)/g) ?? []).length - (translation.match(/(?<!\})\}(?!\})/g) ?? []).length;
  if (dstSingle !== 0 && srcSingle === 0) issues.push({ kind: 'malformed', token: '{ }', message: 'Unbalanced { } braces' });
  if (/%\s+[sd@]/.test(translation) && !/%\s+[sd@]/.test(source)) {
    issues.push({ kind: 'malformed', token: '% s', message: 'Format specifier contains a space (e.g. "% s")' });
  }
  if (opts.maxLength && translation.length > opts.maxLength) {
    issues.push({ kind: 'too_long', token: '', message: `Longer than the ${opts.maxLength}-character limit (${translation.length})` });
  }
  return issues;
}
