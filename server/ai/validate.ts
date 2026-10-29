import { parse as parseIcu, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { z } from 'zod';
import { validateTranslation, type PlaceholderRule } from '../../shared/placeholders.js';

/** Hard cap on one translated value, independent of the key's own character limit. */
export const MAX_VALUE_LENGTH = 10_000;

const replySchema = z.object({ translations: z.array(z.object({ id: z.string(), text: z.string() }).strict()) }).strict();

export type ItemOutcome = { id: string; ok: true; value: string } | { id: string; ok: false; reason: string; error: string; retryable: boolean };

export interface ValidationResult {
  /** The whole reply was unusable (not JSON, wrong shape): retry the batch. */
  malformed?: string;
  outcomes: ItemOutcome[];
  /** Ids in the reply that were not asked for, or appeared twice; logged, never written. */
  unexpected: string[];
}

const ICU_COMPLEX = /\{\s*[\w.]+\s*,\s*(plural|select|selectordinal)\s*,/;

/** Argument names (and plural/select structure) of an ICU message, or an error if it doesn't parse. */
function icuArguments(message: string): { ok: true; args: Set<string> } | { ok: false; error: string } {
  try {
    const args = new Set<string>();
    const walk = (els: MessageFormatElement[]) => {
      for (const el of els) {
        if (el.type === TYPE.literal || el.type === TYPE.pound) continue;
        if ('value' in el && typeof el.value === 'string' && el.type !== TYPE.tag) args.add(`${TYPE[el.type]}:${el.value}`);
        if (el.type === TYPE.plural || el.type === TYPE.select) for (const opt of Object.values(el.options)) walk(opt.value);
        if (el.type === TYPE.tag) walk(el.children);
      }
    };
    walk(parseIcu(message, { ignoreTag: true }));
    return { ok: true, args };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Multiset of HTML-like tag names (`<b>`, `</b>`, `<br/>`), compared between source and translation. */
function tags(text: string): string {
  return [...text.matchAll(/<\/?([A-Za-z][\w-]*)\b[^<>]*>/g)]
    .map((m) => (m[0].startsWith('</') ? '/' : '') + m[1].toLowerCase())
    .sort()
    .join(',');
}

/** Checks one translated value against its source. Returns a failure reason, or null when it is acceptable. */
export function checkValue(source: string, value: string, rules?: PlaceholderRule[]): { reason: string; error: string } | null {
  if (!value.trim()) return { reason: 'empty', error: 'The model returned an empty translation' };
  if (value.length > MAX_VALUE_LENGTH || value.length > Math.max(400, source.length * 8)) {
    return { reason: 'too_long', error: `The translation is implausibly long (${value.length} characters)` };
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) return { reason: 'invalid_characters', error: 'The translation contains control characters' };
  const icu = ICU_COMPLEX.test(source);
  // For ICU plural/select messages the brace-balance heuristics misread nested braces; the ICU parser
  // below checks structure instead, so only token (placeholder) mismatches count here.
  const issues = validateTranslation(source, value, { rules }).filter((i) => i.kind !== 'too_long' && !(icu && i.kind === 'malformed'));
  if (issues.length) return { reason: 'invalid_placeholders', error: issues.map((i) => i.message).join('; ') };
  if (icu) {
    const src = icuArguments(source);
    const dst = icuArguments(value);
    if (src.ok) {
      if (!dst.ok) return { reason: 'invalid_icu', error: `ICU message does not parse: ${dst.error}` };
      const missing = [...src.args].filter((a) => !dst.args.has(a));
      const extra = [...dst.args].filter((a) => !src.args.has(a));
      if (missing.length || extra.length) return { reason: 'invalid_icu', error: `ICU arguments differ (missing: ${missing.join(', ') || '—'}; extra: ${extra.join(', ') || '—'})` };
    }
  }
  if (tags(source) !== tags(value)) return { reason: 'invalid_markup', error: 'HTML tags differ from the source' };
  return null;
}

/**
 * Validates a whole model reply against the requested items. Every requested id gets exactly one
 * outcome; results are matched by id only, never by position.
 */
export function validateReply(raw: string, requested: { id: string; source: string }[], rules?: PlaceholderRule[]): ValidationResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { malformed: 'The reply was not valid JSON', outcomes: [], unexpected: [] };
  }
  const parsed = replySchema.safeParse(json);
  if (!parsed.success) return { malformed: `The reply did not match the expected shape: ${parsed.error.issues[0]?.message ?? 'invalid'}`, outcomes: [], unexpected: [] };

  const wanted = new Map(requested.map((r) => [r.id, r.source]));
  const seen = new Map<string, string[]>();
  const unexpected: string[] = [];
  for (const t of parsed.data.translations) {
    if (!wanted.has(t.id)) {
      unexpected.push(t.id);
      continue;
    }
    seen.set(t.id, [...(seen.get(t.id) ?? []), t.text]);
  }
  const outcomes: ItemOutcome[] = requested.map(({ id, source }) => {
    const got = seen.get(id);
    if (!got) return { id, ok: false, reason: 'missing_in_reply', error: 'The model did not return this key', retryable: true };
    if (got.length > 1) {
      unexpected.push(id);
      if (new Set(got).size > 1) return { id, ok: false, reason: 'duplicate_in_reply', error: 'The model returned this key twice with different texts', retryable: true };
    }
    const problem = checkValue(source, got[0], rules);
    return problem ? { id, ok: false, ...problem, retryable: true } : { id, ok: true, value: got[0] };
  });
  return { outcomes, unexpected };
}
