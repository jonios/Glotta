import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy, KeyRound, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { canUseApiAccess } from '../../../shared/domain';
import { Button, cx, EmptyState, ErrorState, Field, Modal, PageHeader, PermissionDenied, Select, Skeleton, errorMessage, relTime, useConfirm, useToast } from '../components/ui';

interface ApiKeyRow {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  revokedAt: string | null;
  createdById: number;
  createdBy: string;
  revokedBy: string | null;
  status: 'active' | 'revoked' | 'expired';
}

export default function ApiAccess() {
  const { me } = useSession();
  if (!canUseApiAccess(me.scope.role)) return <PermissionDenied message="API access is available to Super Admins and Translation Managers." />;
  const tabs = [
    { to: 'keys', label: 'API keys' },
    { to: 'docs', label: 'Documentation' },
  ];
  return (
    <div className="mx-auto max-w-[1100px] p-4 sm:p-6">
      <PageHeader title="API Access" description="Let apps and build tools download translations with an API key." />
      <nav className="mb-5 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line" aria-label="API access sections">
        {tabs.map((t) => (
          <NavLink key={t.to} to={`/api-access/${t.to}`} className={({ isActive }) => cx('h-9 shrink-0 border-b-2 px-3 pt-2 text-[13px]', isActive ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<Navigate to="/api-access/keys" replace />} />
        <Route path="keys" element={<KeysTab />} />
        <Route path="docs" element={<DocsTab />} />
      </Routes>
    </div>
  );
}

// ======================================================================== keys
const EXPIRY_OPTIONS = [
  { value: '', label: 'Never' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];

function KeysTab() {
  const { isAdmin, me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api.get<ApiKeyRow[]>('/api/api-keys') });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);

  const closeCreate = () => {
    setCreating(false);
    setName('');
    setExpiry('');
    setError('');
  };
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/api/api-keys', { name: name.trim(), expiresInDays: expiry ? Number(expiry) : null });
      closeCreate();
      setCreated({ name: r.name, key: r.key });
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (e: any) {
      setError(e.details?.[0]?.message ?? errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (k: ApiKeyRow) => {
    if (!(await confirm({ title: `Revoke “${k.name}”?`, body: 'Apps using this key stop working immediately. This cannot be undone — create a new key if you need access again.', confirmLabel: 'Revoke', danger: true }))) return;
    try {
      await api.post(`/api/api-keys/${k.id}/revoke`);
      toast('ok', `Revoked ${k.name}`);
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[640px] text-[13px] text-muted">
          A key reads the same languages and platforms as the person who created it, and stops working if that person is deactivated or is no longer a Super Admin or Translation Manager.
          {isAdmin ? ' As a Super Admin you see every key.' : ' You see the keys you created.'}
        </p>
        <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
          New API key
        </Button>
      </div>
      {keys.isError ? (
        <ErrorState error={keys.error} retry={() => keys.refetch()} />
      ) : keys.isLoading ? (
        <Skeleton className="h-40" />
      ) : !keys.data?.length ? (
        <EmptyState icon={KeyRound} title="No API keys yet">
          Create a key for each app or build tool that downloads translations, so you can revoke them one by one.
        </EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[820px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Key</th>
                {isAdmin && <th className="px-4 py-2.5 font-medium">Created by</th>}
                <th className="px-4 py-2.5 font-medium">Created</th>
                <th className="px-4 py-2.5 font-medium">Expires</th>
                <th className="px-4 py-2.5 font-medium">Last used</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {keys.data.map((k) => (
                <tr key={k.id} className={cx('border-b border-line align-top last:border-0', k.status !== 'active' && 'opacity-60')}>
                  <td className="px-4 py-3 font-medium">{k.name}</td>
                  <td className="px-4 py-3 font-mono text-[12px] text-muted">{k.prefix}…</td>
                  {isAdmin && <td className="px-4 py-3 text-muted">{k.createdById === me.user.id ? 'You' : k.createdBy}</td>}
                  <td className="px-4 py-3 text-muted">{relTime(k.createdAt)}</td>
                  <td className="px-4 py-3 text-muted">{k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : 'Never'}</td>
                  <td className="px-4 py-3 text-muted">
                    {k.lastUsedAt ? (
                      <>
                        {relTime(k.lastUsedAt)}
                        <span className="block text-[11px] text-subtle">{k.useCount.toLocaleString()} requests</span>
                      </>
                    ) : (
                      'Never'
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <KeyStatus status={k.status} />
                    {k.revokedBy && <span className="block text-[11px] text-subtle">by {k.revokedBy}</span>}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {k.status !== 'revoked' && (
                      <Button size="sm" variant="ghost" onClick={() => revoke(k)}>
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={creating}
        onOpenChange={(o) => !o && closeCreate()}
        title="New API key"
        description="Name the key after the app or tool that will use it."
        footer={
          <>
            <Button onClick={closeCreate}>Cancel</Button>
            <Button variant="primary" onClick={create} loading={busy} disabled={!name.trim()}>
              Create key
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name" htmlFor="ak-name" hint="For example “iOS Driver app” or “Web build pipeline”.">
            <input id="ak-name" autoFocus className="input" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && create()} />
          </Field>
          <Field label="Expires" htmlFor="ak-exp">
            <Select id="ak-exp" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          {error && (
            <p role="alert" className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
              {error}
            </p>
          )}
        </div>
      </Modal>

      <Modal
        open={!!created}
        onOpenChange={(o) => !o && setCreated(null)}
        title={`API key “${created?.name ?? ''}” created`}
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="flex gap-2 rounded border border-warn/40 bg-warn/[0.08] px-3 py-2 text-[13px] text-warn">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
            Copy the key now. For security it is stored only as a hash and can never be shown again.
          </p>
          {created && <CodeBlock code={created.key} label="API key" />}
          <p className="text-[13px] text-muted">
            Send it in the <code className="font-mono text-fg">Authorization: Bearer …</code> header. The Documentation tab has ready-to-use examples.
          </p>
        </div>
      </Modal>
    </>
  );
}

function KeyStatus({ status }: { status: ApiKeyRow['status'] }) {
  const style = { active: 'border-ok/50 text-ok', revoked: 'border-danger/50 text-danger', expired: 'border-line-strong text-muted' }[status];
  return <span className={cx('inline-block rounded-full border px-2 py-px text-[12px] font-medium capitalize', style)}>{status}</span>;
}

// ======================================================================== docs
function CodeBlock({ code, label }: { code: string; label?: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast('error', 'Copy failed — select the text and copy it manually');
    }
  };
  return (
    <div>
      {label && <p className="mb-1 text-[11px] uppercase tracking-wide text-subtle">{label}</p>}
      <div className="relative">
        <pre className="overflow-x-auto rounded border border-line bg-bg px-3 py-2.5 pr-20 font-mono text-[12.5px] leading-relaxed text-fg">
          <code>{code}</code>
        </pre>
        <button
          type="button"
          onClick={copy}
          className="absolute right-2 top-2 flex cursor-pointer items-center gap-1 rounded border border-line-strong bg-raised px-2 py-1 text-[12px] text-muted hover:text-fg"
          aria-label={`Copy ${label ?? 'code'}`}
        >
          {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="card scroll-mt-4 p-5">
      <h2 className="mb-3 text-[16px] font-semibold">{title}</h2>
      <div className="flex flex-col gap-3 text-[13.5px] leading-relaxed text-muted [&_code]:font-mono [&_code]:text-fg">{children}</div>
    </section>
  );
}

function Endpoint({ method, path }: { method: string; path: string }) {
  return (
    <p className="flex flex-wrap items-center gap-2 font-mono text-[13px]">
      <span className="rounded bg-accent/15 px-2 py-0.5 font-semibold text-accent">{method}</span>
      <span className="text-fg">{path}</span>
    </p>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded border border-line">
      <table className="w-full min-w-[560px] text-[13px]">
        <thead>
          <tr className="border-b border-line bg-raised text-left text-[12px] text-muted">
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line align-top last:border-0">
              {r.map((c, j) => (
                <td key={j} className={cx('px-3 py-2', j === 0 ? 'whitespace-nowrap text-fg' : 'text-muted')}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DocsTab() {
  const base = window.location.origin;
  const curl = (path: string) => `curl -H "Authorization: Bearer $GLOTTA_API_KEY" \\\n  "${base}${path}"`;
  const js = (path: string, comment: string) =>
    `const res = await fetch('${base}${path}', {\n  headers: { Authorization: \`Bearer \${GLOTTA_API_KEY}\` },\n});\nif (!res.ok) throw new Error((await res.json()).message);\n${comment}`;

  return (
    <div className="grid gap-5 lg:grid-cols-[190px_minmax(0,1fr)]">
      <nav aria-label="On this page" className="hidden lg:block">
        <ul className="sticky top-4 flex flex-col gap-1 text-[13px]">
          {[
            ['overview', 'Overview'],
            ['auth', 'Authentication'],
            ['languages', 'List languages'],
            ['keywords', 'Keywords of a language'],
            ['platforms', 'List platforms'],
            ['errors', 'Errors'],
            ['limits', 'Limits & CORS'],
          ].map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`} className="block rounded px-2 py-1 text-muted hover:bg-hover hover:text-fg">
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-col gap-5">
        <Section id="overview" title="Overview">
          <p>
            A small, read-only JSON API for apps and build tools. Base URL: <code>{base}/api/v1</code>
          </p>
          <ul className="list-disc pl-5">
            <li>All endpoints use <code>GET</code> and return JSON (UTF-8).</li>
            <li>A key sees only the languages and platforms its creator can see in this dashboard.</li>
            <li>Responses are never cached by the server (<code>Cache-Control: no-store</code>); cache them in your app or build step.</li>
          </ul>
        </Section>

        <Section id="auth" title="Authentication">
          <p>
            Create a key on the <em className="not-italic text-fg">API keys</em> tab and send it with every request in the <code>Authorization</code> header:
          </p>
          <CodeBlock code="Authorization: Bearer glt_…your key…" />
          <p>
            <code>X-API-Key: glt_…</code> works too. Keep keys secret: store them in environment variables or your CI secret store, not in source code. Don’t put a key in a website that anyone can open — browser code is
            public; use a build step or your own server instead. Revoke a key as soon as it may have leaked.
          </p>
          <p>The examples below read the key from an environment variable:</p>
          <CodeBlock code={`export GLOTTA_API_KEY="glt_…your key…"`} />
        </Section>

        <Section id="languages" title="1. List languages">
          <Endpoint method="GET" path="/api/v1/languages" />
          <p>
            All active languages the key can read, source language (English) first, each with its <strong className="text-fg">content version</strong> per platform. Use <code>code</code> in the keywords endpoint.
          </p>
          <Table
            head={['Parameter', 'In', 'Description']}
            rows={[[<code>platform</code>, 'query', <>Optional platform slug. Adds a single <code>version</code> for that platform and limits <code>versions</code> to it.</>]]}
          />
          <CodeBlock label="curl" code={curl('/api/v1/languages')} />
          <CodeBlock label="JavaScript (fetch)" code={js('/api/v1/languages', 'const { languages } = await res.json();\nconsole.log(languages.map((l) => l.code)); // ["en", "ar", "az", …]')} />
          <CodeBlock
            label="Response 200"
            code={`{
  "languages": [
    {
      "code": "en", "name": "English", "nativeName": "English", "direction": "ltr", "isSource": true,
      "versions": { "ios-driver": 14, "android-driver": 9, "web-service": 22 },
      "updatedAt": "2026-10-28T19:52:10.123Z"
    },
    {
      "code": "fa", "name": "Persian", "nativeName": "فارسی", "direction": "rtl", "isSource": false,
      "versions": { "ios-driver": 31, "android-driver": 12, "web-service": 8 },
      "updatedAt": "2026-10-28T20:03:41.512Z"
    }
  ]
}`}
          />
          <CodeBlock
            label="Response 200 — GET /api/v1/languages?platform=ios-driver"
            code={`{
  "languages": [
    { "code": "fa", "name": "Persian", "nativeName": "فارسی", "direction": "rtl", "isSource": false,
      "version": 31, "versions": { "ios-driver": 31 }, "updatedAt": "2026-10-28T20:03:41.512Z" }
  ]
}`}
          />
          <Table
            head={['Field', 'Description']}
            rows={[
              [<code>code</code>, 'Language code (BCP-47), e.g. en, fa, de-AT'],
              [<code>name</code>, 'English name'],
              [<code>nativeName</code>, 'Name in the language itself'],
              [<code>direction</code>, <><code>ltr</code> or <code>rtl</code></>],
              [<code>isSource</code>, <><code>true</code> for the source language (English)</>],
              [<code>versions</code>, <>Content version per platform slug (only platforms the key can read)</>],
              [<code>version</code>, <>Only with <code>?platform=</code>: the content version of that platform</>],
              [<code>updatedAt</code>, <>When any of these versions last changed (ISO 8601), or <code>null</code></>],
            ]}
          />
          <h3 className="mt-2 text-[14px] font-semibold text-fg">Content versions</h3>
          <p>
            Each language has its own version number <em className="not-italic text-fg">per platform</em>. It starts at 1 and goes up by one automatically whenever that language’s keywords on that platform change:
          </p>
          <ul className="list-disc pl-5">
            <li>a translation in that language is added, edited, approved, sent back or imported — only that language goes up;</li>
            <li>a keyword is added to or removed from the platform, renamed, archived, or its English text changes — every language of that platform goes up.</li>
          </ul>
          <p>
            Store the version with the strings you downloaded and only download again when it changed. Saving a translation without changing it does not bump the version. Versions only ever increase; compare them for
            equality, since several changes can happen between two checks.
          </p>
          <CodeBlock
            label="JavaScript — download only when something changed"
            code={`const headers = { Authorization: \`Bearer \${GLOTTA_API_KEY}\` };
const res = await fetch('${base}/api/v1/languages?platform=ios-driver', { headers });
const { languages } = await res.json();
for (const lang of languages) {
  if (lang.version === cache[lang.code]?.version) continue; // unchanged
  const r = await fetch(\`${base}/api/v1/languages/\${lang.code}/keywords?platform=ios-driver\`, { headers });
  cache[lang.code] = { version: Number(r.headers.get('X-Content-Version')), strings: await r.json() };
}`}
          />
        </Section>

        <Section id="keywords" title="2. Keywords of a language">
          <Endpoint method="GET" path="/api/v1/languages/{code}/keywords" />
          <p>
            Every keyword with its translation, as one flat JSON object: <code>{'{ "keyword": "translation" }'}</code>, sorted by keyword. Keywords without a usable translation are left out (unless you use{' '}
            <code>fallback=source</code>). For <code>en</code> you get the English source text.
          </p>
          <Table
            head={['Parameter', 'In', 'Description']}
            rows={[
              [<code>code</code>, 'path', <>Language code from <code>/api/v1/languages</code>; not case-sensitive. Required.</>],
              [<code>platform</code>, 'query', <>Platform slug, e.g. <code>ios-driver</code> (see <code>/api/v1/platforms</code>). Optional — without it, all platforms the key can read are merged.</>],
              [<code>status</code>, 'query', <><code>approved</code> (default): only approved translations. <code>any</code>: also drafts, in-progress and waiting-for-review values.</>],
              [<code>fallback</code>, 'query', <><code>none</code> (default): leave missing translations out. <code>source</code>: use the English text instead.</>],
            ]}
          />
          <p>
            Ask for one platform when you build one app: within a platform every keyword is unique. When several platforms are merged and the same keyword exists with different texts, the shared key wins, then the platform listed
            first.
          </p>
          <CodeBlock label="curl" code={curl('/api/v1/languages/fa/keywords?platform=ios-driver')} />
          <CodeBlock
            label="JavaScript (fetch)"
            code={js('/api/v1/languages/fa/keywords?platform=ios-driver&fallback=source', "const strings = await res.json();\nconsole.log(strings['about_us']); // \"درباره ما\"")}
          />
          <CodeBlock
            label="Response 200"
            code={`{
  "about_us": "درباره ما",
  "accept": "پذیرفتن",
  "address_book": "دفترچه آدرس"
}`}
          />
          <Table
            head={['Response header', 'Description']}
            rows={[
              [<code>X-Keyword-Count</code>, 'Number of keywords in the response'],
              [<code>X-Language</code>, 'The language code that was returned'],
              [<code>X-Platform</code>, <>The platform slug, when <code>platform</code> was given</>],
              [<code>X-Content-Version</code>, <>The content version of this language on this platform, when <code>platform</code> was given — the same number as in <code>/api/v1/languages</code></>],
            ]}
          />
        </Section>

        <Section id="platforms" title="3. List platforms">
          <Endpoint method="GET" path="/api/v1/platforms" />
          <p>
            Platforms the key can read, to find the <code>slug</code> for the <code>platform</code> parameter.
          </p>
          <CodeBlock label="curl" code={curl('/api/v1/platforms')} />
          <CodeBlock
            label="Response 200"
            code={`{
  "platforms": [
    { "slug": "ios-driver", "name": "iOS Driver", "kind": "ios" },
    { "slug": "web-service", "name": "Web Service", "kind": "web" }
  ]
}`}
          />
        </Section>

        <Section id="errors" title="Errors">
          <p>Errors use standard HTTP status codes and this body:</p>
          <CodeBlock code={`{ "error": "language_forbidden", "message": "This API key has no access to \\"fr\\"" }`} />
          <Table
            head={['Status', 'error', 'Meaning']}
            rows={[
              ['400', <code>validation_error</code>, <>A parameter has an invalid value, e.g. <code>status=done</code>. <code>details</code> says which.</>],
              ['403 / 404', <code>platform_forbidden / platform_not_found</code>, <>Also returned by <code>/api/v1/languages?platform=</code></>],
              ['401', <code>missing_api_key</code>, 'No key in the Authorization or X-API-Key header'],
              ['401', <code>invalid_api_key</code>, 'The key does not exist (typo, or copied incompletely)'],
              ['401', <code>api_key_revoked</code>, 'The key was revoked'],
              ['401', <code>api_key_expired</code>, 'The key passed its expiry date'],
              ['401', <code>api_key_disabled</code>, 'The key’s creator was deactivated or is no longer a Super Admin or Translation Manager'],
              ['403', <code>language_forbidden</code>, 'The key has no access to this language'],
              ['403', <code>platform_forbidden</code>, 'The key has no access to this platform'],
              ['404', <code>language_not_found</code>, 'No active language with this code'],
              ['404', <code>platform_not_found</code>, 'No platform with this slug'],
              ['429', <code>rate_limited</code>, 'More than 120 requests in a minute — wait and retry'],
              ['500', <code>internal</code>, 'Unexpected server error'],
            ]}
          />
        </Section>

        <Section id="limits" title="Limits & CORS">
          <ul className="list-disc pl-5">
            <li>120 requests per minute per key.</li>
            <li>
              Cross-origin requests are allowed (<code>Access-Control-Allow-Origin: *</code>), so tools on other domains can call the API. The key still decides what can be read.
            </li>
            <li>Only <code>GET</code> is supported; the API never changes data.</li>
          </ul>
        </Section>
      </div>
    </div>
  );
}
