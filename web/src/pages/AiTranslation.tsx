import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Ban, Download, Play, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useSession } from '../lib/session';
import { canUseApiAccess } from '../../../shared/domain';
import { AutoTranslateDialog, useAiStatus } from '../components/AutoTranslateDialog';
import {
  Button,
  Checkbox,
  cx,
  EmptyState,
  ErrorState,
  MultiSelect,
  PageHeader,
  Pagination,
  PermissionDenied,
  Progress,
  SearchInput,
  Select,
  Skeleton,
  StatusBadge,
  errorMessage,
  relTime,
  useConfirm,
  useDebounced,
  useToast,
} from '../components/ui';

export default function AiTranslation() {
  const { me, can } = useSession();
  if (!canUseApiAccess(me.scope.role) || !can('edit_translations')) return <PermissionDenied message="AI translation is available to Super Admins and Translation Managers with edit rights." />;
  const tabs = [
    { to: 'missing', label: 'Missing keys' },
    { to: 'jobs', label: 'Jobs' },
  ];
  return (
    <div className="mx-auto max-w-[1300px] p-4 sm:p-6">
      <PageHeader title="AI Translation" description="Find untranslated, invalid or outdated keys and translate them with Claude. Results are saved for review." />
      <SetupBanner />
      <nav className="mb-5 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line" aria-label="AI translation sections">
        {tabs.map((t) => (
          <NavLink key={t.to} to={`/ai-translation/${t.to}`} className={({ isActive }) => cx('h-9 shrink-0 border-b-2 px-3 pt-2 text-[13px]', isActive ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<Navigate to="/ai-translation/missing" replace />} />
        <Route path="missing" element={<MissingKeys />} />
        <Route path="jobs" element={<Jobs />} />
        <Route path="jobs/:id" element={<JobDetail />} />
      </Routes>
    </div>
  );
}

function SetupBanner() {
  const status = useAiStatus();
  if (!status.data || status.data.configured) return null;
  return (
    <div role="alert" className="mb-4 flex gap-2 rounded border border-warn/40 bg-warn/[0.08] px-3 py-2.5 text-[13px] text-warn">
      <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
      <span>
        Auto Translate is not configured, so translation jobs can't start. The missing-keys report works without it. {status.data.setupHelp}
      </span>
    </div>
  );
}

// ======================================================================== missing keys
const KINDS = [
  { value: 'all', label: 'All issues' },
  { value: 'missing', label: 'Missing' },
  { value: 'empty', label: 'Empty' },
  { value: 'invalid', label: 'Invalid' },
  { value: 'outdated', label: 'Outdated' },
  { value: 'empty_source', label: 'Empty source' },
  { value: 'orphaned', label: 'Orphaned' },
] as const;
type Kind = (typeof KINDS)[number]['value'];

interface MissingRow {
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
  issues: string[];
  issueDetail: string;
  lastAiFailure: { jobId: number; reason: string; error: string } | null;
}
interface Report {
  summary: Record<string, number>;
  total: number;
  eligibleKeyIds: number[];
  rows: MissingRow[];
}

const ISSUE_STYLE: Record<string, string> = {
  missing: 'border-line-strong text-muted',
  empty: 'border-warn/50 text-warn',
  invalid: 'border-danger/50 text-danger',
  outdated: 'border-warn/50 text-warn',
  empty_source: 'border-line-strong text-subtle',
  orphaned: 'border-line-strong text-subtle',
};

function MissingKeys() {
  const { targetLanguages, platforms } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [lang, setLang] = useState<number>(targetLanguages[0]?.id ?? 0);
  const [platformIds, setPlatformIds] = useState<number[]>([]);
  const [kind, setKind] = useState<Kind>('all');
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 300);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dialogKeys, setDialogKeys] = useState<number[] | null>(null);
  const query = { languageId: lang, platformIds: platformIds.length ? platformIds.join(',') : undefined, kind, q: q || undefined, page, pageSize: 50 };
  const report = useQuery({ queryKey: ['missing-keys', query], queryFn: () => api.get<Report>(`/api/missing-keys${qs(query)}`), enabled: !!lang, placeholderData: keepPreviousData });
  useEffect(() => setSelected(new Set()), [lang, kind, q, platformIds.join(',')]);
  const d = report.data;
  const selectable = (r: MissingRow) => !r.issues.includes('orphaned') && !r.issues.includes('empty_source');
  const pageSelectable = d?.rows.filter(selectable).map((r) => r.keyId) ?? [];
  const allOnPage = pageSelectable.length > 0 && pageSelectable.every((id) => selected.has(id));
  const toggle = (id: number) => setSelected((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const exportHref = `/api/missing-keys${qs({ ...query, page: undefined, pageSize: undefined, format: 'csv' })}`;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select aria-label="Target language" className="w-[200px]" value={lang} onChange={(e) => (setLang(Number(e.target.value)), setPage(1))}>
          {targetLanguages.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.code})
            </option>
          ))}
        </Select>
        <div className="w-[240px]">
          <MultiSelect label="Platforms" placeholder="All my platforms" options={platforms.map((p) => ({ value: p.id, label: p.name }))} value={platformIds} onChange={(v) => (setPlatformIds(v), setPage(1))} />
        </div>
        <SearchInput value={search} onChange={(v) => (setSearch(v), setPage(1))} placeholder="Search key or source text" className="w-full sm:w-[260px]" />
        <div className="ml-auto flex gap-2">
          <Button icon={RefreshCw} onClick={() => qc.invalidateQueries({ queryKey: ['missing-keys'] })} loading={report.isFetching}>
            Refresh
          </Button>
          <a href={exportHref} className="inline-flex h-9 items-center gap-1.5 rounded border border-line px-3 text-[13px] text-muted hover:bg-hover hover:text-fg">
            <Download size={14} aria-hidden /> Export CSV
          </a>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Issue type">
        {KINDS.map((k) => (
          <button
            key={k.value}
            role="radio"
            aria-checked={kind === k.value}
            onClick={() => (setKind(k.value), setPage(1))}
            className={cx('h-8 cursor-pointer rounded-full border px-3 text-[12.5px]', kind === k.value ? 'border-accent bg-accent/10 text-fg' : 'border-line text-muted hover:text-fg')}
          >
            {k.label}
            {d && k.value !== 'all' && <span className="ml-1.5 tabular-nums text-subtle">{(d.summary[k.value] ?? 0).toLocaleString()}</span>}
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-muted">{selected.size ? `${selected.size} selected` : `${(d?.total ?? 0).toLocaleString()} keys with issues`}</span>
        {selected.size > 0 && (
          <>
            <Button size="sm" variant="primary" icon={Sparkles} onClick={() => setDialogKeys([...selected])}>
              Auto translate selected
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </>
        )}
        {!selected.size && !!d?.eligibleKeyIds.length && (
          <Button size="sm" icon={Sparkles} onClick={() => setDialogKeys(d.eligibleKeyIds)}>
            Auto translate all {d.eligibleKeyIds.length.toLocaleString()}
          </Button>
        )}
        <div className="ml-auto">{d && <Pagination page={page} pageSize={50} total={d.total} onPage={setPage} />}</div>
      </div>

      {report.isError ? (
        <ErrorState error={report.error} retry={() => report.refetch()} />
      ) : report.isLoading ? (
        <Skeleton className="h-64" />
      ) : !d?.rows.length ? (
        <EmptyState icon={Sparkles} title="Nothing to fix here">
          No keys match this filter for the selected language and platforms.
        </EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[1000px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="w-10 px-3 py-2.5">
                  <Checkbox
                    label={<span className="sr-only">Select all on this page</span>}
                    checked={allOnPage}
                    onChange={(v) => setSelected((s) => {
                      const n = new Set(s);
                      for (const id of pageSelectable) v ? n.add(id) : n.delete(id);
                      return n;
                    })}
                  />
                </th>
                <th className="px-3 py-2.5 font-medium">Key</th>
                <th className="px-3 py-2.5 font-medium">Source</th>
                <th className="px-3 py-2.5 font-medium">Current translation</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Issue</th>
                <th className="px-3 py-2.5 font-medium">Versions</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={`${r.keyId}-${r.issues.join()}`} className="border-b border-line align-top last:border-0">
                  <td className="px-3 py-2.5">{selectable(r) && <Checkbox label={<span className="sr-only">Select {r.identifiers[0]}</span>} checked={selected.has(r.keyId)} onChange={() => toggle(r.keyId)} />}</td>
                  <td className="max-w-[220px] px-3 py-2.5">
                    <Link to={`/workspace?lang=${lang}&key=${r.keyId}`} className="break-all font-mono text-[12px] text-accent hover:underline">
                      {r.identifiers.join(', ') || `#${r.keyId}`}
                    </Link>
                    <p className="text-[11px] text-subtle">{r.platforms.join(' · ') || 'no platform'}</p>
                  </td>
                  <td className="max-w-[260px] whitespace-pre-wrap break-words px-3 py-2.5">{r.sourceText || <span className="text-subtle">—</span>}</td>
                  <td className="max-w-[260px] whitespace-pre-wrap break-words px-3 py-2.5" dir="auto">
                    {r.value || <span className="text-subtle">—</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="max-w-[240px] px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {r.issues.map((i) => (
                        <span key={i} className={cx('rounded-full border px-2 py-px text-[11px]', ISSUE_STYLE[i])}>
                          {i.replace('_', ' ')}
                        </span>
                      ))}
                    </div>
                    {r.issueDetail && <p className="mt-1 text-[12px] text-muted">{r.issueDetail}</p>}
                    {r.lastAiFailure && (
                      <p className="mt-1 text-[12px] text-danger">
                        AI failed: {r.lastAiFailure.error}{' '}
                        <Link to={`/ai-translation/jobs/${r.lastAiFailure.jobId}`} className="underline">
                          job #{r.lastAiFailure.jobId}
                        </Link>
                      </p>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-[12px] text-subtle">
                    key v{r.keyVersion}
                    <br />
                    {r.translationVersion ? `translation v${r.translationVersion}` : 'no translation'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialogKeys && (
        <AutoTranslateDialog
          open
          onOpenChange={(o) => !o && setDialogKeys(null)}
          targetLanguageId={lang}
          keyIds={dialogKeys}
          defaultPlatformIds={platformIds}
          onStarted={(id) => navigate(`/ai-translation/jobs/${id}`)}
        />
      )}
    </>
  );
}

// ======================================================================== jobs
interface JobSummary {
  id: number;
  status: string;
  mode: string;
  overwrite: string;
  resultStatus: string;
  model: string;
  totalKeys: number;
  counts: { pending: number; translated: number; skipped: number; failed: number };
  batches: { total: number; done: number; failed: number; running: number; pending: number; retries: number };
  reasons: { reason: string; n: number }[];
  progress: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  apiRequests: number;
  usedMessageBatches: boolean;
  errorSummary: string;
  selectedKeys: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  sourceCode: string;
  targetCode: string;
  targetName: string;
  targetLanguageId: number;
  createdBy: string | null;
}
const ACTIVE = ['queued', 'running', 'cancel_requested'];
const JOB_STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: 'Queued', cls: 'border-line-strong text-muted' },
  running: { label: 'Running', cls: 'border-accent/50 text-accent' },
  cancel_requested: { label: 'Cancelling', cls: 'border-warn/50 text-warn' },
  completed: { label: 'Completed', cls: 'border-ok/50 text-ok' },
  completed_with_errors: { label: 'Completed with errors', cls: 'border-warn/50 text-warn' },
  failed: { label: 'Failed', cls: 'border-danger/50 text-danger' },
  cancelled: { label: 'Cancelled', cls: 'border-line-strong text-muted' },
};
function JobStatus({ status }: { status: string }) {
  const s = JOB_STATUS[status] ?? JOB_STATUS.queued;
  return <span className={cx('inline-block whitespace-nowrap rounded-full border px-2 py-px text-[12px] font-medium', s.cls)}>{s.label}</span>;
}
function Counts({ c }: { c: JobSummary['counts'] }) {
  return (
    <span className="flex flex-wrap gap-x-3 text-[12px]">
      <span className="text-ok">{c.translated.toLocaleString()} translated</span>
      <span className="text-muted">{c.skipped.toLocaleString()} skipped</span>
      <span className={c.failed ? 'text-danger' : 'text-muted'}>{c.failed.toLocaleString()} failed</span>
      <span className="text-subtle">{c.pending.toLocaleString()} pending</span>
    </span>
  );
}

function Jobs() {
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState(false);
  const navigate = useNavigate();
  const jobs = useQuery({
    queryKey: ['ai-jobs', page],
    queryFn: () => api.get<{ total: number; rows: JobSummary[] }>(`/api/ai/jobs?page=${page}`),
    refetchInterval: (q) => (q.state.data?.rows.some((j) => ACTIVE.includes(j.status)) ? 2000 : false),
  });
  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        {jobs.data && <Pagination page={page} pageSize={20} total={jobs.data.total} onPage={setPage} />}
        <Button variant="primary" icon={Sparkles} onClick={() => setDialog(true)}>
          New Auto Translate job
        </Button>
      </div>
      {jobs.isError ? (
        <ErrorState error={jobs.error} />
      ) : jobs.isLoading ? (
        <Skeleton className="h-48" />
      ) : !jobs.data?.rows.length ? (
        <EmptyState icon={Sparkles} title="No translation jobs yet">
          Start one here, from a language on the Languages page, or from the missing-keys report.
        </EmptyState>
      ) : (
        <ul className="card divide-y divide-line">
          {jobs.data.rows.map((j) => (
            <li key={j.id}>
              <Link to={`/ai-translation/jobs/${j.id}`} className="grid gap-2 px-4 py-3 hover:bg-hover/50 md:grid-cols-[minmax(0,1fr)_260px] md:items-center">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-[14px]">
                    <span className="font-medium">#{j.id}</span>
                    <span>
                      {j.sourceCode} → {j.targetName} ({j.targetCode})
                    </span>
                    <JobStatus status={j.status} />
                    {j.selectedKeys && <span className="text-[12px] text-subtle">selected keys</span>}
                  </p>
                  <p className="mt-0.5 text-[12px] text-subtle">
                    {j.totalKeys.toLocaleString()} keys · {j.model}
                    {j.usedMessageBatches ? ' · Message Batches' : ''} · {j.createdBy ?? '—'} · {relTime(j.createdAt)}
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  <Progress value={j.progress} total={100} tone={j.counts.failed ? 'review' : 'ok'} label={`Job ${j.id} progress`} />
                  <Counts c={j.counts} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {dialog && <AutoTranslateDialog open onOpenChange={setDialog} onStarted={(id) => navigate(`/ai-translation/jobs/${id}`)} />}
    </>
  );
}

const REASONS: Record<string, string> = {
  empty_source: 'Empty source text',
  source_changed: 'Source changed while the job ran',
  changed_meanwhile: 'Edited by someone while the job ran',
  key_archived: 'Key archived while the job ran',
  already_translated: 'Already translated when retried',
  no_longer_in_scope: 'No longer in scope',
  invalid_placeholders: 'Placeholders not preserved',
  invalid_icu: 'Invalid ICU message',
  invalid_markup: 'HTML tags changed',
  invalid_characters: 'Invalid characters',
  empty: 'Empty translation returned',
  too_long: 'Implausibly long translation',
  missing_in_reply: 'Not returned by the model',
  duplicate_in_reply: 'Returned twice with different texts',
  malformed_reply: 'Unreadable model reply',
  refused: 'Declined by the model',
  output_too_long: 'Output limit reached',
  rate_limited: 'Rate limited',
  overloaded: 'API overloaded',
  timeout: 'Request timed out',
  network: 'Network error',
  auth: 'API key rejected',
  not_found: 'Unknown model',
  bad_request: 'Request rejected',
  not_processed: 'Not processed',
};
const reasonLabel = (r: string) => REASONS[r] ?? r.replace(/_/g, ' ');

function JobDetail() {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [filter, setFilter] = useState<'failed' | 'skipped' | 'translated' | 'pending'>('failed');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const job = useQuery({
    queryKey: ['ai-job', id],
    queryFn: () => api.get<JobSummary>(`/api/ai/jobs/${id}`),
    refetchInterval: (q) => (q.state.data && ACTIVE.includes(q.state.data.status) ? 1500 : false),
  });
  const active = !!job.data && ACTIVE.includes(job.data.status);
  const items = useQuery({
    queryKey: ['ai-job-items', id, filter, page, job.data?.counts],
    queryFn: () => api.get<{ total: number; rows: any[] }>(`/api/ai/jobs/${id}/items?status=${filter}&page=${page}`),
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    if (job.data && !active) {
      qc.invalidateQueries({ queryKey: ['missing-keys'] });
      qc.invalidateQueries({ queryKey: ['keys'] });
    }
  }, [job.data?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (what: 'cancel' | 'retry' | 'resume') => {
    if (what === 'cancel' && !(await confirm({ title: 'Cancel this job?', body: 'Batches already written stay saved. Keys not yet translated stay pending; you can resume later.', confirmLabel: 'Cancel job', danger: true }))) return;
    setBusy(true);
    try {
      const r = await api.post(`/api/ai/jobs/${id}/${what}`, {});
      if (what !== 'cancel') toast('ok', `${r.requeued} key(s) queued again${r.skipped ? `, ${r.skipped} no longer need translating` : ''}`);
      qc.invalidateQueries({ queryKey: ['ai-job', id] });
      qc.invalidateQueries({ queryKey: ['ai-jobs'] });
    } catch (e) {
      toast('error', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (job.isError) return <ErrorState error={job.error} />;
  if (!job.data) return <Skeleton className="h-64" />;
  const j = job.data;
  return (
    <div className="flex flex-col gap-4">
      <Link to="/ai-translation/jobs" className="flex items-center gap-1 text-[13px] text-muted hover:text-fg">
        <ArrowLeft size={14} aria-hidden /> All jobs
      </Link>
      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex flex-wrap items-center gap-2 text-[17px] font-semibold">
              Job #{j.id}: {j.sourceCode} → {j.targetName} <JobStatus status={j.status} />
            </h2>
            <p className="mt-1 text-[13px] text-muted">
              {j.totalKeys.toLocaleString()} keys · overwrite: {j.overwrite} · saved as {j.resultStatus.replace('_', ' ')} · {j.model}
              {j.usedMessageBatches ? ' · Message Batches API' : ''} · started by {j.createdBy ?? '—'} {relTime(j.createdAt)}
            </p>
          </div>
          <div className="flex gap-2">
            {active && j.status !== 'cancel_requested' && (
              <Button icon={Ban} onClick={() => act('cancel')} loading={busy}>
                Cancel
              </Button>
            )}
            {!active && j.counts.failed > 0 && (
              <Button variant="primary" icon={RotateCcw} onClick={() => act('retry')} loading={busy}>
                Retry {j.counts.failed} failed
              </Button>
            )}
            {!active && j.counts.pending > 0 && (
              <Button icon={Play} onClick={() => act('resume')} loading={busy}>
                Resume {j.counts.pending}
              </Button>
            )}
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-1.5">
          <Progress value={j.progress} total={100} tone={j.counts.failed ? 'review' : 'ok'} label="Progress" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Counts c={j.counts} />
            <span className="text-[12px] text-subtle">{j.progress}%</span>
          </div>
        </div>
        <dl className="mt-4 grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Batches">
            {j.batches.done} done · {j.batches.failed} failed · {j.batches.running} running · {j.batches.pending} waiting
          </Stat>
          <Stat label="Retries">{j.batches.retries}</Stat>
          <Stat label="Requests">{j.apiRequests.toLocaleString()}</Stat>
          <Stat label="Tokens">
            {j.inputTokens.toLocaleString()} in · {j.outputTokens.toLocaleString()} out{j.cacheReadTokens ? ` · ${j.cacheReadTokens.toLocaleString()} cached` : ''}
          </Stat>
          <Stat label="Started">{j.startedAt ? relTime(j.startedAt) : '—'}</Stat>
          <Stat label="Finished">{j.finishedAt ? relTime(j.finishedAt) : '—'}</Stat>
        </dl>
        {j.reasons.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {j.reasons.map((r) => (
              <span key={r.reason} className="rounded-full border border-line px-2 py-px text-[12px] text-muted">
                {reasonLabel(r.reason)}: {r.n}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          {(['failed', 'skipped', 'translated', 'pending'] as const).map((s) => (
            <button
              key={s}
              onClick={() => (setFilter(s), setPage(1))}
              className={cx('h-8 cursor-pointer rounded-full border px-3 text-[12.5px] capitalize', filter === s ? 'border-accent bg-accent/10 text-fg' : 'border-line text-muted hover:text-fg')}
            >
              {s} <span className="tabular-nums text-subtle">{j.counts[s]}</span>
            </button>
          ))}
          <div className="ml-auto">{items.data && <Pagination page={page} pageSize={50} total={items.data.total} onPage={setPage} />}</div>
        </div>
        {!items.data?.rows.length ? (
          <p className="px-4 py-6 text-center text-[13px] text-subtle">No {filter} keys.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px] text-[13px]">
              <tbody>
                {items.data.rows.map((i) => (
                  <tr key={i.id} className="border-b border-line align-top last:border-0">
                    <td className="max-w-[220px] px-4 py-2.5">
                      <Link to={`/workspace?lang=${j.targetLanguageId}&key=${i.keyId}`} className="break-all font-mono text-[12px] text-accent hover:underline">
                        {i.identifier ?? `#${i.keyId}`}
                      </Link>
                    </td>
                    <td className="max-w-[300px] whitespace-pre-wrap break-words px-4 py-2.5 text-muted">{i.sourceText}</td>
                    <td className="max-w-[300px] whitespace-pre-wrap break-words px-4 py-2.5" dir="auto">
                      {i.value ?? <span className="text-subtle">—</span>}
                    </td>
                    <td className="max-w-[260px] px-4 py-2.5">
                      {i.reason && <p className={cx('text-[12px] font-medium', i.status === 'failed' ? 'text-danger' : 'text-muted')}>{reasonLabel(i.reason)}</p>}
                      {i.error && <p className="text-[12px] text-subtle">{i.error}</p>}
                      {i.attempts > 0 && <p className="text-[11px] text-subtle">{i.attempts} attempt{i.attempts === 1 ? '' : 's'}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] text-subtle">{label}</dt>
      <dd className="text-muted">{children}</dd>
    </div>
  );
}
