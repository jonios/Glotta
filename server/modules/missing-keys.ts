import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { allPlatformIds } from './key-query.js';
import { HttpError, parse, scopeOf, sendFile } from '../http.js';
import { DEFAULT_PLACEHOLDER_RULES, validateTranslation, type PlaceholderRule } from '../../shared/placeholders.js';
import { checkValue } from '../ai/validate.js';

export const ISSUE_KINDS = ['missing', 'empty', 'invalid', 'outdated', 'empty_source', 'orphaned'] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

export interface MissingRow {
  keyId: number;
  identifiers: string[];
  platforms: string[];
  sourceText: string;
  value: string;
  status: string;
  translationVersion: number | null;
  keyVersion: number;
  sourceChanged: boolean;
  updatedAt: string | null;
  issues: IssueKind[];
  issueDetail: string;
  lastAiFailure: { jobId: number; reason: string; error: string } | null;
}

/**
 * Missing-keys report for one target language. The comparison set is every non-archived key linked to
 * the chosen platforms (so platform-specific keys only count where they exist), compared with that
 * key's translation. Translations are per key, so a key shared by several platforms appears once.
 * Orphaned rows are translations whose key is archived or linked to no platform; they are reported,
 * never deleted.
 */
export function missingKeysRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/api/missing-keys', async (req, reply) => {
    const scope = scopeOf(req);
    scope.require('view');
    const q = parse(
      z.object({
        languageId: z.coerce.number().int().positive(),
        platformIds: z.string().optional(),
        kind: z.enum([...ISSUE_KINDS, 'all']).default('all'),
        q: z.string().trim().max(200).optional(),
        page: z.coerce.number().int().positive().default(1),
        pageSize: z.coerce.number().int().min(1).max(500).default(50),
        format: z.enum(['json', 'csv']).default('json'),
      }),
      req.query,
    );
    const lang = await db.one<{ id: number; code: string; is_source: boolean }>('SELECT id, code, is_source FROM languages WHERE id=$1 AND is_active', [q.languageId]);
    if (!lang) throw new HttpError(404, 'language_not_found', 'Language not found');
    if (lang.is_source) throw new HttpError(400, 'bad_language', 'Choose a target language, not the source language');
    if (!scope.canSeeLanguage(lang.id)) throw new HttpError(403, 'language_forbidden', 'You have no access to this language');
    const requested = q.platformIds ? q.platformIds.split(',').map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0) : undefined;
    const platformIds = scope.resolvePlatforms(requested, await allPlatformIds(db, false));
    if (q.format === 'csv') scope.require('export');

    const settingsRow = await db.one<{ value: unknown }>(`SELECT value FROM settings WHERE key='placeholder_rules'`);
    const rules = Array.isArray(settingsRow?.value) ? (settingsRow!.value as PlaceholderRule[]) : DEFAULT_PLACEHOLDER_RULES;

    const params: unknown[] = [lang.id, platformIds];
    let search = '';
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      search = `AND (lower(k.source_text) LIKE $3 OR EXISTS (SELECT 1 FROM key_platforms s WHERE s.key_id=k.id AND lower(s.identifier) LIKE $3))`;
    }
    // One indexed pass over the scoped keys; classification happens in memory (a few thousand rows).
    const rows = await db.query<{
      id: number; source_text: string; version: number; identifiers: string[]; platforms: string[];
      value: string | null; status: string | null; tversion: number | null; source_changed: boolean | null; updated_at: string | null;
    }>(
      `SELECT k.id, k.source_text, k.version, x.identifiers, x.platforms, t.value, t.status, t.version AS tversion, t.source_changed, t.updated_at
       FROM translation_keys k
       JOIN LATERAL (
         SELECT array_agg(DISTINCT kp.identifier) AS identifiers, array_agg(p.name ORDER BY p.sort_order) AS platforms
         FROM key_platforms kp JOIN platforms p ON p.id=kp.platform_id
         WHERE kp.key_id=k.id AND kp.platform_id = ANY($2::int[])
       ) x ON x.identifiers IS NOT NULL
       LEFT JOIN translations t ON t.key_id=k.id AND t.language_id=$1
       WHERE NOT k.is_archived ${search}
       ORDER BY x.identifiers[1], k.id`,
      params,
    );
    const orphans = await db.query<{ id: number; source_text: string; version: number; identifiers: string[] | null; value: string; status: string; tversion: number; updated_at: string; archived: boolean }>(
      `SELECT k.id, k.source_text, k.version, ARRAY(SELECT DISTINCT kp.identifier FROM key_platforms kp WHERE kp.key_id=k.id) AS identifiers,
              t.value, t.status, t.version AS tversion, t.updated_at, k.is_archived AS archived
       FROM translations t JOIN translation_keys k ON k.id=t.key_id
       WHERE t.language_id=$1 AND t.value <> ''
         AND (k.is_archived OR NOT EXISTS (SELECT 1 FROM key_platforms kp WHERE kp.key_id=k.id))
         ${q.q ? `AND (lower(k.source_text) LIKE $2 OR lower(k.identifier) LIKE $2)` : ''}
       ORDER BY k.identifier`,
      q.q ? [lang.id, `%${q.q.toLowerCase()}%`] : [lang.id],
    );
    const failures = new Map(
      (
        await db.query<{ key_id: number; job_id: number; reason: string; error: string }>(
          `SELECT DISTINCT ON (i.key_id) i.key_id, i.job_id, i.reason, i.error
           FROM translation_job_items i JOIN translation_jobs j ON j.id=i.job_id
           WHERE j.target_language_id=$1 AND i.status='failed'
           ORDER BY i.key_id, i.updated_at DESC`,
          [lang.id],
        )
      ).map((f) => [f.key_id, { jobId: f.job_id, reason: f.reason, error: f.error }]),
    );

    const report: MissingRow[] = [];
    for (const r of rows) {
      const value = r.value ?? '';
      const status = r.status ?? 'missing';
      const issues: IssueKind[] = [];
      let detail = '';
      if (!r.source_text.trim()) {
        issues.push('empty_source');
        detail = 'The source text is empty, so there is nothing to translate';
      }
      if (status === 'missing' && !value) issues.push('missing');
      else if (!value.trim()) {
        issues.push('empty');
        detail = 'The translation is blank';
      } else if (r.source_text.trim()) {
        const problem = checkValue(r.source_text, value, rules);
        const placeholderIssues = validateTranslation(r.source_text, value, { rules }).filter((i) => i.kind !== 'too_long');
        if (problem && problem.reason !== 'too_long') {
          issues.push('invalid');
          detail = problem.error;
        } else if (placeholderIssues.length) {
          issues.push('invalid');
          detail = placeholderIssues.map((i) => i.message).join('; ');
        }
      }
      if (r.source_changed) {
        issues.push('outdated');
        detail ||= 'The source text changed after this translation was written';
      }
      // A failed AI attempt only matters while the key still has a problem.
      const failure = issues.length ? failures.get(r.id) ?? null : null;
      if (!issues.length) continue;
      report.push({
        keyId: r.id,
        identifiers: r.identifiers,
        platforms: r.platforms,
        sourceText: r.source_text,
        value,
        status,
        translationVersion: r.tversion,
        keyVersion: r.version,
        sourceChanged: !!r.source_changed,
        updatedAt: r.updated_at,
        issues,
        issueDetail: detail,
        lastAiFailure: failure,
      });
    }
    for (const o of orphans) {
      report.push({
        keyId: o.id,
        identifiers: o.identifiers?.length ? o.identifiers : [],
        platforms: [],
        sourceText: o.source_text,
        value: o.value,
        status: o.status,
        translationVersion: o.tversion,
        keyVersion: o.version,
        sourceChanged: false,
        updatedAt: o.updated_at,
        issues: ['orphaned'],
        issueDetail: o.archived ? 'The key is archived; this translation is no longer used' : 'The key is not on any platform; this translation is no longer used',
        lastAiFailure: null,
      });
    }

    const summary = Object.fromEntries(ISSUE_KINDS.map((k) => [k, report.filter((r) => r.issues.includes(k)).length])) as Record<IssueKind, number>;
    // "All issues" excludes orphans: they need a decision, not a translation.
    const filtered = q.kind === 'all' ? report.filter((r) => !r.issues.includes('orphaned')) : report.filter((r) => r.issues.includes(q.kind as IssueKind));

    if (q.format === 'csv') {
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [
        ['key', 'platforms', 'source', 'translation', 'status', 'issues', 'detail', 'translation_version', 'last_ai_failure'].join(','),
        ...filtered.map((r) => [r.identifiers.join(' | '), r.platforms.join(' | '), r.sourceText, r.value, r.status, r.issues.join(' '), r.issueDetail, r.translationVersion ?? '', r.lastAiFailure?.error ?? ''].map(esc).join(',')),
      ];
      return sendFile(reply, `missing-keys-${lang.code}-${q.kind}.csv`, 'text/csv; charset=utf-8', '﻿' + lines.join('\r\n'));
    }
    return {
      language: { id: lang.id, code: lang.code },
      platformIds,
      summary,
      total: filtered.length,
      eligibleKeyIds: filtered.filter((r) => !r.issues.includes('orphaned') && !r.issues.includes('empty_source')).map((r) => r.keyId),
      rows: filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
    };
  });
}
