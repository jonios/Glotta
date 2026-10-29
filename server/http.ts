import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import type { Scope } from './authz/scope.js';
import type { Queryable } from './db/client.js';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new HttpError(400, 'validation_error', 'Invalid request', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export function scopeOf(req: FastifyRequest): Scope {
  if (!req.scope) throw new HttpError(401, 'unauthenticated', 'Sign in required');
  return req.scope;
}

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | number;
  platformIds?: number[];
  languageId?: number | null;
  before?: unknown;
  after?: unknown;
  jobRef?: string;
}

export async function audit(q: Queryable, actorId: number | null, entry: AuditEntry, ip = ''): Promise<void> {
  await q.query(
    `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, platform_ids, language_id, before, after, job_ref, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      actorId,
      entry.action,
      entry.resourceType,
      String(entry.resourceId ?? ''),
      entry.platformIds ?? [],
      entry.languageId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.jobRef ?? null,
      ip,
    ],
  );
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });

export const csvInts = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const parts = (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean);
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error('invalid id list');
    return nums;
  });

export function sendFile(reply: FastifyReply, fileName: string, contentType: string, body: Buffer | string) {
  const safe = fileName.replace(/[^\w.\-]+/g, '_');
  return reply
    .header('Content-Type', contentType)
    .header('Content-Disposition', `attachment; filename="${safe}"`)
    .header('Cache-Control', 'no-store')
    .send(body);
}

declare module 'fastify' {
  interface FastifyRequest {
    scope?: Scope;
    userId?: number;
    sessionCsrf?: string;
  }
}
