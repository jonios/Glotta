import type { Queryable } from '../db/client.js';
import { CAPABILITIES, type Capability, type Role } from '../../shared/domain.js';
import { HttpError } from '../http.js';

/**
 * The effective permissions of one user, resolved once per request from the database.
 * Every data-access path receives a Scope and must filter with it in SQL; nothing relies on
 * the client to hide data.
 */
export class Scope {
  constructor(
    readonly userId: number,
    readonly role: Role,
    readonly capabilities: ReadonlySet<Capability>,
    readonly allLanguages: boolean,
    readonly languageIds: ReadonlySet<number>,
    readonly allPlatforms: boolean,
    readonly platformIds: ReadonlySet<number>,
    readonly sourceLanguageId: number,
  ) {}

  get isSuperAdmin() {
    return this.role === 'super_admin';
  }

  can(cap: Capability): boolean {
    return this.isSuperAdmin || this.capabilities.has(cap);
  }

  require(cap: Capability): void {
    if (!this.can(cap)) throw new HttpError(403, 'forbidden', `Missing permission: ${cap}`);
  }

  canSeeLanguage(languageId: number): boolean {
    if (languageId === this.sourceLanguageId) return this.can('view_source') || this.allLanguages || this.isSuperAdmin;
    return this.isSuperAdmin || this.allLanguages || this.languageIds.has(languageId);
  }

  canSeePlatform(platformId: number): boolean {
    return this.isSuperAdmin || this.allPlatforms || this.platformIds.has(platformId);
  }

  /** Target languages (never the source) the user may read. `null` means "all". */
  languageFilter(): number[] | null {
    return this.isSuperAdmin || this.allLanguages ? null : [...this.languageIds].filter((id) => id !== this.sourceLanguageId);
  }

  /** Platform ids the user may read. `null` means "all". */
  platformFilter(): number[] | null {
    return this.isSuperAdmin || this.allPlatforms ? null : [...this.platformIds];
  }

  /**
   * Intersects requested language ids with the scope. Explicitly requesting a language
   * outside the scope is an error rather than a silent drop, so tampering is visible.
   */
  resolveLanguages(requested: number[] | undefined, allTargets: number[]): number[] {
    const allowed = this.languageFilter();
    const pool = allowed === null ? allTargets : allTargets.filter((id) => allowed.includes(id));
    if (!requested || requested.length === 0) return pool;
    for (const id of requested) {
      if (!pool.includes(id)) throw new HttpError(403, 'language_forbidden', 'You do not have access to one of the requested languages');
    }
    return requested;
  }

  resolvePlatforms(requested: number[] | undefined, allPlatforms: number[]): number[] {
    const allowed = this.platformFilter();
    const pool = allowed === null ? allPlatforms : allPlatforms.filter((id) => allowed.includes(id));
    if (!requested || requested.length === 0) return pool;
    for (const id of requested) {
      if (!pool.includes(id)) throw new HttpError(403, 'platform_forbidden', 'You do not have access to one of the requested platforms');
    }
    return requested;
  }

  toJSON() {
    return {
      role: this.role,
      capabilities: this.isSuperAdmin ? [...CAPABILITIES] : [...this.capabilities],
      allLanguages: this.isSuperAdmin || this.allLanguages,
      languageIds: [...this.languageIds],
      allPlatforms: this.isSuperAdmin || this.allPlatforms,
      platformIds: [...this.platformIds],
    };
  }
}

export async function loadScope(q: Queryable, userId: number): Promise<Scope | null> {
  const u = await q.one<{ role: Role; is_active: boolean; all_languages: boolean; all_platforms: boolean }>(
    'SELECT role, is_active, all_languages, all_platforms FROM users WHERE id=$1',
    [userId],
  );
  if (!u || !u.is_active) return null;
  const [caps, langs, plats, src] = await Promise.all([
    q.query<{ capability: Capability }>('SELECT capability FROM user_capabilities WHERE user_id=$1', [userId]),
    q.query<{ language_id: number }>(
      'SELECT ul.language_id FROM user_languages ul JOIN languages l ON l.id=ul.language_id WHERE ul.user_id=$1 AND l.is_active',
      [userId],
    ),
    q.query<{ platform_id: number }>('SELECT platform_id FROM user_platforms WHERE user_id=$1', [userId]),
    q.one<{ id: number }>('SELECT id FROM languages WHERE is_source'),
  ]);
  return new Scope(
    userId,
    u.role,
    new Set(caps.map((c) => c.capability).filter((c) => (CAPABILITIES as readonly string[]).includes(c))),
    u.all_languages,
    new Set(langs.map((l) => l.language_id)),
    u.all_platforms,
    new Set(plats.map((p) => p.platform_id)),
    src?.id ?? -1,
  );
}

/** SQL fragment: key is linked to at least one platform in scope (and not archived platform for non-admins). */
export function keyVisibleSql(scope: Scope, keyAlias: string, params: unknown[]): string {
  const pf = scope.platformFilter();
  if (pf === null) return 'TRUE';
  params.push(pf);
  return `EXISTS (SELECT 1 FROM key_platforms kp_s WHERE kp_s.key_id = ${keyAlias}.id AND kp_s.platform_id = ANY($${params.length}::int[]))`;
}
