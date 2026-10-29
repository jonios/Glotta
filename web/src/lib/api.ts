// Typed fetch wrapper. Adds the CSRF header to mutating requests and normalises errors.

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: any) {
    super(message);
  }
}

let csrfToken = '';
export const setCsrf = (t: string) => (csrfToken = t);

async function request<T>(method: string, url: string, body?: unknown, opts: { raw?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  if (!res.ok) {
    let data: any = {};
    try {
      data = await res.json();
    } catch {
      /* non-JSON error */
    }
    if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new CustomEvent('tms:unauthenticated'));
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? res.statusText, data.details);
  }
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T = any>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  patch: <T = any>(url: string, body?: unknown) => request<T>('PATCH', url, body ?? {}),
  del: <T = any>(url: string) => request<T>('DELETE', url),
  upload: <T = any>(url: string, form: FormData) => request<T>('POST', url, form),
  /** POST that returns a file; triggers a browser download. */
  async download(url: string, body: unknown): Promise<{ fileName: string; warnings: number }> {
    const res = await request<Response>('POST', url, body, { raw: true });
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') ?? '';
    const fileName = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'export';
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    return { fileName, warnings: Number(res.headers.get('X-Export-Warnings') ?? 0) };
  },
};

export function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ------------------------------------------------------------------ shared response types
export interface Language {
  id: number;
  code: string;
  name: string;
  nativeName: string;
  direction: 'ltr' | 'rtl';
  isSource: boolean;
  isActive: boolean;
  sortOrder: number;
  totalKeys: number;
  translated: number;
  approved: number;
  needsReview: number;
  aliases: { alias: string; kind: string }[];
  note: string;
}
export interface Platform {
  id: number;
  slug: string;
  name: string;
  description: string;
  kind: string;
  isArchived: boolean;
  sortOrder: number;
  keyCount: number;
  languageCount: number;
  translated: number;
  approved: number;
  hasLegacyLayout: boolean;
}
export interface Segment {
  id: number;
  name: string;
  description: string;
  keyCount: number;
}
export interface TranslationCell {
  id: number;
  value: string;
  status: string;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
  reviewedBy: string | null;
  sourceChanged: boolean;
  feedback: { comment: string; reviewer: string | null; createdAt: string } | null;
}
export interface KeyRow {
  id: number;
  namespace: string;
  identifier: string;
  sourceText: string | null;
  description: string;
  maxLength: number | null;
  isArchived: boolean;
  version: number;
  updatedAt: string;
  platformCount: number;
  segments: { id: number; name: string }[];
  platforms: { id: number; name: string }[];
  openConflicts: number;
  translations: Record<number, TranslationCell>;
}
