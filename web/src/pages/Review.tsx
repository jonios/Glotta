import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCheck, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs, type KeyRow } from '../lib/api';
import { useSession } from '../lib/session';
import { validateTranslation } from '../../../shared/placeholders';
import { Button, EmptyState, ErrorState, PageHeader, Pagination, PermissionDenied, Segmented, Select, Skeleton, StatusBadge, errorMessage, relTime, useToast } from '../components/ui';

export default function Review() {
  const { can, targetLanguages, platforms } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [lang, setLang] = useState<number>(targetLanguages[0]?.id ?? 0);
  const [platform, setPlatform] = useState<number>(0);
  const [status, setStatus] = useState<'needs_review' | 'in_progress'>('needs_review');
  const [page, setPage] = useState(1);
  const [comments, setComments] = useState<Record<number, string>>({});
  const query = { languageIds: [lang], statuses: [status], platformIds: platform ? [platform] : [], page, pageSize: 25, sort: 'updated', dir: 'desc' };
  const rows = useQuery({
    queryKey: ['keys', 'review', query],
    queryFn: () => api.get<{ total: number; rows: KeyRow[] }>(`/api/keys${qs(query)}`),
    enabled: !!lang && (can('review') || can('approve')),
    placeholderData: keepPreviousData,
  });
  if (!can('review') && !can('approve')) return <PermissionDenied />;

  const act = async (r: KeyRow, action: 'approve' | 'request_changes') => {
    const t = r.translations[lang];
    if (!t) return;
    const comment = comments[r.id] ?? '';
    if (action === 'request_changes' && !comment.trim()) return toast('error', 'Add a comment explaining what to change');
    try {
      await api.post(`/api/translations/${t.id}/review`, { action, comment, expectedVersion: t.version });
      toast('ok', action === 'approve' ? `Approved ${r.identifier}` : `Sent back ${r.identifier}`);
      qc.invalidateQueries({ queryKey: ['keys'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (e) {
      toast('error', errorMessage(e));
      rows.refetch();
    }
  };
  const approvePage = async () => {
    if (!rows.data?.rows.length) return;
    try {
      const r = await api.post('/api/translations/bulk-review', { items: rows.data.rows.map((x) => ({ keyId: x.id, languageId: lang })), action: 'approve' });
      toast('ok', `Approved ${r.changed}`);
      qc.invalidateQueries({ queryKey: ['keys'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };

  return (
    <div className="mx-auto max-w-[1200px] p-4 sm:p-6">
      <PageHeader
        title="Review"
        description="Approve submitted translations or send them back with a comment."
        actions={
          <>
            <Segmented
              label="Queue"
              value={status}
              onChange={(s) => (setStatus(s), setPage(1))}
              options={[
                { value: 'needs_review', label: 'Waiting for review' },
                { value: 'in_progress', label: 'Returned' },
              ]}
            />
            <Select aria-label="Language" className="w-[190px]" value={lang} onChange={(e) => (setLang(Number(e.target.value)), setPage(1))}>
              {targetLanguages.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.needsReview} to review)
                </option>
              ))}
            </Select>
            <Select aria-label="Platform" className="w-[180px]" value={platform} onChange={(e) => (setPlatform(Number(e.target.value)), setPage(1))}>
              <option value={0}>All platforms</option>
              {platforms.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </>
        }
      />
      {rows.isError ? (
        <ErrorState error={rows.error} retry={() => rows.refetch()} />
      ) : rows.isLoading ? (
        <div className="flex flex-col gap-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : !rows.data?.rows.length ? (
        <EmptyState icon={CheckCheck} title={status === 'needs_review' ? 'Nothing waiting for review' : 'Nothing returned for changes'}>
          Submitted translations in this language appear here.
        </EmptyState>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between">
            <Pagination page={page} pageSize={25} total={rows.data.total} onPage={setPage} />
            {can('approve') && status === 'needs_review' && (
              <Button icon={CheckCheck} onClick={approvePage}>
                Approve all on this page
              </Button>
            )}
          </div>
          <ul className="flex flex-col gap-2">
            {rows.data.rows.map((r) => {
              const t = r.translations[lang];
              const l = targetLanguages.find((x) => x.id === lang);
              const warnings = validateTranslation(r.sourceText ?? '', t?.value ?? '');
              return (
                <li key={r.id} className="card grid gap-3 p-4 md:grid-cols-[1fr_1fr_220px]">
                  <div className="min-w-0">
                    <Link to={`/workspace?lang=${lang}&key=${r.id}&q=${encodeURIComponent(r.identifier)}`} className="font-mono text-[12px] text-accent hover:underline">
                      {r.identifier}
                    </Link>
                    <p className="mt-1 whitespace-pre-wrap text-[14px]">{r.sourceText}</p>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={t?.status ?? 'missing'} />
                      <span className="text-[12px] text-subtle">
                        {t?.updatedBy ?? 'import'} · {relTime(t?.updatedAt)}
                      </span>
                    </div>
                    <p dir={l?.direction} className="mt-1 whitespace-pre-wrap text-[14px]">{t?.value}</p>
                    {warnings.length > 0 && <p className="mt-1 text-[12px] text-warn">{warnings.map((w) => w.message).join(' · ')}</p>}
                    {t?.feedback && (
                      <div role="note" className="mt-2 flex gap-2 rounded border border-warn/40 bg-warn/[0.08] px-3 py-2 text-[13px]">
                        <RotateCcw size={14} className="mt-0.5 shrink-0 text-warn" aria-hidden />
                        <div className="min-w-0">
                          <p className="text-[12px] font-medium text-warn">
                            Changes requested{t.feedback.reviewer ? ` by ${t.feedback.reviewer}` : ''} · {relTime(t.feedback.createdAt)}
                          </p>
                          <p className="mt-0.5 whitespace-pre-wrap break-words">{t.feedback.comment}</p>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    <input className="input h-8 text-[13px]" aria-label={`Comment for ${r.identifier}`} placeholder="Comment (required to send back)" value={comments[r.id] ?? ''} onChange={(e) => setComments({ ...comments, [r.id]: e.target.value })} />
                    <div className="flex gap-2">
                      {can('approve') && (
                        <Button size="sm" variant="primary" icon={Check} onClick={() => act(r, 'approve')}>
                          Approve
                        </Button>
                      )}
                      {can('review') && status === 'needs_review' && (
                        <Button size="sm" icon={RotateCcw} onClick={() => act(r, 'request_changes')}>
                          Send back
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
