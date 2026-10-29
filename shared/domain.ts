// Domain constants shared by the API and the web client.

export const CAPABILITIES = [
  'view',               // view authorised platforms/languages
  'view_source',        // see source-language (English) strings
  'edit_translations',  // write target-language values in scope
  'edit_source',        // change source strings
  'manage_keys',        // create/archive keys, change platform assignments, descriptions
  'manage_segments',    // create segments and change key-segment assignments
  'review',             // request changes / comment on translations
  'approve',            // approve translations
  'import',             // run Excel imports
  'export',             // export Excel and localization resources (within scope)
  'manage_platforms',
  'manage_languages',
  'manage_users',
  'view_audit',
  'manage_settings',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  view: 'View authorised resources',
  view_source: 'View source (English) strings',
  edit_translations: 'Edit translations',
  edit_source: 'Edit source strings',
  manage_keys: 'Manage keys & platform assignment',
  manage_segments: 'Manage segments',
  review: 'Review (request changes)',
  approve: 'Approve translations',
  import: 'Import Excel',
  export: 'Export (Excel & resources)',
  manage_platforms: 'Manage platforms',
  manage_languages: 'Manage languages',
  manage_users: 'Manage users & permissions',
  view_audit: 'View audit log',
  manage_settings: 'Manage settings',
};

export const ROLES = ['super_admin', 'manager', 'translator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  manager: 'Translation Manager',
  translator: 'Translator',
  viewer: 'Read-only',
};

/** Capabilities pre-selected when an administrator picks a role. They remain editable per user. */
export const ROLE_DEFAULT_CAPABILITIES: Record<Role, Capability[]> = {
  super_admin: [...CAPABILITIES],
  manager: ['view', 'view_source', 'edit_translations', 'manage_segments', 'review', 'approve', 'export', 'view_audit'],
  translator: ['view', 'view_source', 'edit_translations', 'export'],
  viewer: ['view', 'view_source'],
};

/** Roles that may create API keys for the public API, and whose keys keep working. */
export const API_KEY_ROLES: readonly Role[] = ['super_admin', 'manager'];
export const canUseApiAccess = (role: Role) => API_KEY_ROLES.includes(role);

export const STATUSES =['missing', 'draft', 'in_progress', 'needs_review', 'approved'] as const;
export type TranslationStatus = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<TranslationStatus, string> = {
  missing: 'Missing',
  draft: 'Draft',
  in_progress: 'In progress',
  needs_review: 'Needs review',
  approved: 'Approved',
};

/**
 * Workflow:
 *   missing      – no value. Saving an empty value always returns a translation here.
 *   draft        – translator saved work that is not ready (explicit "Save draft").
 *   needs_review – translator submitted the value (default "Save").
 *   in_progress  – sent back: a reviewer requested changes, or the source string changed
 *                  after the translation was written. It needs translator attention.
 *   approved     – accepted by a user with the `approve` capability. Only approved,
 *                  non-empty values count as complete.
 */
export const STATUS_DESCRIPTIONS: Record<TranslationStatus, string> = {
  missing: 'No translation yet',
  draft: 'Saved, not yet submitted',
  in_progress: 'Returned for changes or source updated',
  needs_review: 'Submitted, waiting for a reviewer',
  approved: 'Reviewed and approved – counts as complete',
};

/** Statuses a user may set when saving a value. `approved` additionally needs `approve`. */
export const SAVE_TARGET_STATUSES = ['draft', 'needs_review', 'approved'] as const;
export type SaveTargetStatus = (typeof SAVE_TARGET_STATUSES)[number];

export const MISSING_POLICIES = ['skip', 'empty', 'fallback_source'] as const;
export type MissingPolicy = (typeof MISSING_POLICIES)[number];

export const IMPORT_STRATEGIES = ['skip_existing', 'only_missing', 'update_existing', 'manual'] as const;
export type ImportStrategy = (typeof IMPORT_STRATEGIES)[number];
export const IMPORT_STRATEGY_LABELS: Record<ImportStrategy, string> = {
  skip_existing: 'Skip existing values – add new keys and fill blanks only',
  only_missing: 'Only missing translations – never create keys, only fill blanks on existing keys',
  update_existing: 'Update existing values – overwrite differing values (recorded in history)',
  manual: 'Ask me – differing values become conflicts to resolve',
};
