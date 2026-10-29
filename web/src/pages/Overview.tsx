import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, FileDown, FileUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { cx, EmptyState, ErrorState, PageHeader, pct, Progress, Skeleton, StatusBadge, relTime } from '../components/ui';

function Tile({ to, className, children, label }: { to?: string; className?: string; children: ReactNode; label: string }) {
  const body = (
    <>
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        {to && <ArrowUpRight size={14} className="text-subtle transition-colors group-hover:text-accent" aria-hidden />}
      </div>
      {children}
    </>
  );
  const cls = cx('card group flex min-w-0 flex-col gap-3 p-4', to && 'transition-colors duration-fast hover:border-line-strong', className);
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <section className={cls} aria-label={label}>
      {body}
    </section>
  );
}

const Big = ({ children, tone }: { children: ReactNode; tone?: string }) => <div className={cx('text-[28px] font-semibold leading-none tracking-[-0.02em] tabular-nums', tone)}>{children}</div>;

export default function Overview() {
  const { me, can } = useSession();
  const d = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get('/api/dashboard') });
  if (d.isError) return <div className="p-6"><ErrorState error={d.error} retry={() => d.refetch()} /></div>;
  const t = d.data?.totals;
  const loading = d.isLoading;

  return (
    <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
      <PageHeader
        title={`Hello, ${me.user.name.split(' ')[0]}`}
        description={me.scope.allLanguages && me.scope.allPlatforms ? 'All platforms and languages' : 'Figures cover only the platforms and languages assigned to you.'}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Tile label="Translation keys" to="/workspace" className="col-span-1 xl:col-span-1">
          {loading ? <Skeleton className="h-7 w-20" /> : <Big>{t.keys.toLocaleString()}</Big>}
          <span className="text-[12px] text-subtle">active, in your platforms</span>
        </Tile>
        <Tile label="Languages" to="/languages">
          {loading ? <Skeleton className="h-7 w-12" /> : <Big>{t.languages}</Big>}
          <span className="text-[12px] text-subtle">target languages</span>
        </Tile>
        <Tile label="Platforms" to="/platforms">
          {loading ? <Skeleton className="h-7 w-12" /> : <Big>{t.platforms}</Big>}
          <span className="text-[12px] text-subtle">active workspaces</span>
        </Tile>
        <Tile label="Completed" to="/workspace?statuses=approved">
          {loading ? <Skeleton className="h-7 w-24" /> : <Big tone="text-ok">{t.approved.toLocaleString()}</Big>}
          <span className="text-[12px] text-subtle">approved · {loading ? '' : pct(t.approved, t.slots)} of all slots</span>
        </Tile>
        <Tile label="Missing" to="/workspace?statuses=missing">
          {loading ? <Skeleton className="h-7 w-24" /> : <Big tone={t.missing ? 'text-warn' : undefined}>{t.missing.toLocaleString()}</Big>}
          <span className="text-[12px] text-subtle">untranslated key × language</span>
        </Tile>
        <Tile label="Pending review" to={can('approve') || can('review') ? '/review' : '/workspace?statuses=needs_review'}>
          {loading ? <Skeleton className="h-7 w-16" /> : <Big tone={t.needsReview ? 'text-review' : undefined}>{t.needsReview.toLocaleString()}</Big>}
          <span className="text-[12px] text-subtle">{loading ? '' : `${t.inProgress} returned · ${t.draft} drafts`}</span>
        </Tile>

        <Tile label="Progress by language" className="col-span-2 md:col-span-4 xl:col-span-3 xl:row-span-2">
          {loading ? (
            <Skeleton className="h-48" />
          ) : d.data.byLanguage.length === 0 ? (
            <EmptyState title="No languages assigned" />
          ) : (
            <ul className="flex max-h-[360px] flex-col gap-2.5 overflow-y-auto pr-1">
              {d.data.byLanguage.map((l: any) => (
                <li key={l.id}>
                  <Link to={`/workspace?lang=${l.id}&statuses=missing`} className="grid grid-cols-[110px_1fr_88px] items-center gap-3 rounded px-1 py-0.5 hover:bg-hover/60">
                    <span className="truncate text-[13px]">
                      <span className="mr-1.5 font-mono text-[11px] text-accent">{l.code}</span>
                      {l.name}
                    </span>
                    <div className="relative">
                      <Progress value={l.translated} total={t.keys} label={`${l.name} translated`} />
                      <div className="pointer-events-none absolute inset-0">
                        <div className="h-1.5 rounded-full bg-ok" style={{ width: `${t.keys ? (l.approved / t.keys) * 100 : 0}%`, opacity: 0.9 }} />
                      </div>
                    </div>
                    <span className="text-right text-[12px] tabular-nums text-muted">{pct(l.translated, t.keys)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-4 text-[12px] text-subtle">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-ok" /> approved</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent" /> translated</span>
          </div>
        </Tile>

        <Tile label="Progress by platform" className="col-span-2 md:col-span-4 xl:col-span-3">
          {loading ? (
            <Skeleton className="h-32" />
          ) : (
            <ul className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
              {d.data.byPlatform.map((p: any) => {
                const slots = p.keys * t.languages;
                return (
                  <li key={p.id}>
                    <Link to={`/workspace?platform=${p.id}`} className="flex flex-col gap-1 rounded px-1 py-0.5 hover:bg-hover/60">
                      <div className="flex justify-between text-[13px]">
                        <span className="truncate">{p.name}</span>
                        <span className="tabular-nums text-muted">{pct(p.translated, slots)}</span>
                      </div>
                      <Progress value={p.translated} total={slots} label={`${p.name} translated`} />
                      <span className="text-[11px] text-subtle">{p.keys.toLocaleString()} keys</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Tile>

        <Tile label="Needs attention" className="col-span-2 md:col-span-2 xl:col-span-3">
          {loading ? (
            <Skeleton className="h-24" />
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {d.data.needsAttention.map((l: any) => (
                <li key={l.id} className="flex items-center justify-between py-1.5 text-[13px]">
                  <Link to={`/workspace?lang=${l.id}&statuses=missing`} className="hover:text-accent">
                    {l.name} <span className="font-mono text-[11px] text-subtle">{l.code}</span>
                  </Link>
                  <span className="tabular-nums text-muted">
                    {(t.keys - l.translated).toLocaleString()} missing{l.needsReview ? ` · ${l.needsReview} to review` : ''}
                  </span>
                </li>
              ))}
              {t?.openConflicts > 0 && (
                <li className="flex items-center justify-between py-1.5 text-[13px]">
                  <Link to={can('import') ? '/import-export/conflicts' : '/workspace?flags=conflicts'} className="hover:text-accent">
                    Open import conflicts
                  </Link>
                  <span className="tabular-nums text-warn">{t.openConflicts.toLocaleString()}</span>
                </li>
              )}
            </ul>
          )}
        </Tile>

        <Tile label="Recently updated translations" className="col-span-2 md:col-span-4 xl:col-span-3">
          {loading ? (
            <Skeleton className="h-32" />
          ) : d.data.recent.length === 0 ? (
            <p className="text-[13px] text-muted">No edits yet. Changes made in the workspace appear here.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {d.data.recent.map((r: any) => (
                <li key={r.id} className="py-1.5">
                  <Link to={`/workspace?lang=${r.languageId}&key=${r.keyId}&q=${encodeURIComponent(r.identifier)}`} className="grid grid-cols-[1fr_auto] gap-x-3 text-[13px] hover:text-accent">
                    <span className="truncate font-mono text-[12px]">{r.identifier}</span>
                    <StatusBadge status={r.status} compact />
                    <span className="truncate text-muted">
                      <span className="mr-1 font-mono text-[11px] text-accent">{r.languageCode}</span>
                      {r.value || '—'}
                    </span>
                    <span className="text-[12px] text-subtle">
                      {r.updatedBy} · {relTime(r.updatedAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Tile>

        <Tile label="Activity" to="/activity" className="col-span-2 md:col-span-2 xl:col-span-3">
          {loading ? (
            <Skeleton className="h-32" />
          ) : d.data.activity.length === 0 ? (
            <p className="text-[13px] text-muted">No activity yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {d.data.activity.map((a: any) => (
                <li key={a.id} className="flex justify-between gap-3">
                  <span className="truncate">
                    <span className="text-muted">{a.actor ?? 'system'}</span> {a.action.replace('.', ' ').replace(/_/g, ' ')}
                    {a.languageCode && <span className="ml-1 font-mono text-[11px] text-accent">{a.languageCode}</span>}
                  </span>
                  <span className="shrink-0 text-[12px] text-subtle">{relTime(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Tile>

        {(can('import') || can('export')) && (
          <Tile label="Recent import / export jobs" to="/import-export" className="col-span-2 md:col-span-4 xl:col-span-3">
            {loading ? (
              <Skeleton className="h-20" />
            ) : d.data.jobs.length === 0 ? (
              <p className="text-[13px] text-muted">No jobs yet.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-[13px]">
                {d.data.jobs.map((j: any) => (
                  <li key={`${j.type}${j.id}`} className="flex items-center gap-2">
                    {j.type === 'import' ? <FileUp size={14} className="text-info" aria-hidden /> : <FileDown size={14} className="text-ok" aria-hidden />}
                    <span className="flex-1 truncate">{j.fileName}</span>
                    <span className="text-[12px] text-subtle">{j.status}</span>
                    <span className="text-[12px] text-subtle">{relTime(j.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Tile>
        )}
      </div>
    </div>
  );
}
