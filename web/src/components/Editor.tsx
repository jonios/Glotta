import * as Dialog from '@radix-ui/react-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ChevronDown, ChevronUp, Copy, GitFork, History, Info, Pencil, RotateCcw, Save, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type KeyRow, type Segment } from '../lib/api';
import { useSession } from '../lib/session';
import { validateTranslation, type PlaceholderRule } from '../../../shared/placeholders';
import { STATUS_LABELS } from '../../../shared/domain';
import {
  Button,
  cx,
  errorMessage,
  Field,
  IconButton,
  MultiSelect,
  PlatformBadge,
  ReadOnlyNote,
  SegmentTag,
  Skeleton,
  StatusBadge,
  relTime,
  useConfirm,
  usePrompt,
  useToast,
} from './ui';

interface KeyDetail extends KeyRow {
  hiddenPlatformCount: number;
  editable: boolean;
  history: { id: number; languageId: number; value: string; status: string; reason: string; createdAt: string; changedBy: string | null }[];
  reviews: { id: number; languageId: number; action: string; comment: string; createdAt: string; reviewer: string | null }[];
  sourceRevisions: { id: number; sourceText: string; createdAt: string; changedBy: string | null }[];
  alternates: { id: number; sheet: string; row: number; header: string; languageId: number; role: string; value: string }[];
  conflicts: { id: number; kind: string; languageId: number | null; sheet: string; row: number; header: string; currentValue: string; incomingValue: string }[];
}

export function TranslationEditor(props: {
  keyId: number;
  languageIds: number[];
  activeLanguageId: number;
  onLanguageChange: (id: number) => void;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  position: number | null;
  total: number;
}) {
  const { keyId, languageIds, activeLanguageId } = props;
  const { can, targetLanguages, platforms } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const detailKey = ['key', keyId, languageIds.join(',')];
  const q = useQuery({ queryKey: detailKey, queryFn: () => api.get<KeyDetail>(`/api/keys/${keyId}?languageIds=${languageIds.join(',')}`) });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get('/api/settings'), staleTime: 300_000 });
  const segments = useQuery({ queryKey: ['segments'], queryFn: () => api.get<Segment[]>('/api/segments'), staleTime: 60_000 });
  const d = q.data;
  const lang = targetLanguages.find((l) => l.id === activeLanguageId);
  const tr = d?.translations[activeLanguageId];
  // Reviews arrive newest first; show the reviewer's note while the latest review for this language is a send-back.
  const lastReview = d?.reviews.find((r) => r.languageId === activeLanguageId && r.action !== 'comment');
  const feedback = lastReview?.action === 'request_changes' && lastReview.comment && tr?.status !== 'approved' ? lastReview : null;

  const [draft, setDraft] = useState('');
  const [baseline, setBaseline] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ value: string; status: string; version: number } | null>(null);
  const [tab, setTab] = useState<'details' | 'history'>('details');
  const textRef = useRef<HTMLTextAreaElement>(null);
  const dirty = draft !== baseline;

  // Reset the editor when the key or language changes (after any unsaved-change prompt).
  useEffect(() => {
    if (!d) return;
    const v = d.translations[activeLanguageId]?.value ?? '';
    setDraft(v);
    setBaseline(v);
    setConflict(null);
  }, [d?.id, activeLanguageId, d?.translations[activeLanguageId]?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    textRef.current?.focus();
  }, [keyId, activeLanguageId, d?.id]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const guard = async (action: () => void) => {
    if (dirty && !(await confirm({ title: 'Discard unsaved changes?', body: 'Your edit to this translation has not been saved.', confirmLabel: 'Discard', danger: true }))) return;
    action();
  };

  const canEdit = can('edit_translations') && !!d?.editable;
  const rules = (settings.data?.placeholder_rules as PlaceholderRule[] | undefined) ?? undefined;
  const warnings = useMemo(() => (d ? validateTranslation(d.sourceText ?? '', draft, { rules, maxLength: d.maxLength }) : []), [d, draft, rules]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['key', keyId] });
    qc.invalidateQueries({ queryKey: ['keys'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const save = async (status: 'draft' | 'needs_review' | 'approved', then?: 'next', overrideVersion?: number) => {
    if (!d) return;
    setSaving(true);
    // Optimistic update of the visible row.
    qc.setQueriesData<{ rows: KeyRow[] }>({ queryKey: ['keys'] }, (old) =>
      old
        ? {
            ...old,
            rows: old.rows.map((r) =>
              r.id === keyId ? { ...r, translations: { ...r.translations, [activeLanguageId]: { ...(r.translations[activeLanguageId] ?? ({} as any)), value: draft, status: draft ? status : 'missing' } } } : r,
            ),
          }
        : old,
    );
    try {
      const res = await api.put('/api/translations', {
        keyId,
        languageId: activeLanguageId,
        value: draft,
        status,
        expectedVersion: overrideVersion ?? tr?.version ?? null,
      });
      setBaseline(draft);
      setConflict(null);
      toast('ok', res.unchanged ? 'No changes' : `Saved as ${STATUS_LABELS[res.status as keyof typeof STATUS_LABELS]}${res.warnings?.length ? ` · ${res.warnings.length} warning(s)` : ''}`);
      refresh();
      if (then === 'next' && props.hasNext) props.onNext();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') {
        setConflict(e.details?.current ?? { value: '', status: 'missing', version: 0 });
      } else toast('error', errorMessage(e));
      qc.invalidateQueries({ queryKey: ['keys'] });
    } finally {
      setSaving(false);
    }
  };

  const review = async (action: 'approve' | 'request_changes') => {
    if (!tr) return;
    let comment = '';
    if (action === 'request_changes') {
      const text = await prompt({ title: 'Request changes', label: 'What should the translator change?', placeholder: 'e.g. Use the formal “Sie” form', confirmLabel: 'Send back' });
      if (!text) return;
      comment = text;
    }
    try {
      await api.post(`/api/translations/${tr.id}/review`, { action, comment, expectedVersion: tr.version });
      toast('ok', action === 'approve' ? 'Approved' : 'Changes requested');
      refresh();
    } catch (e) {
      toast('error', errorMessage(e));
      refresh();
    }
  };

  const primarySave = can('approve') ? 'approved' : 'needs_review';
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (canEdit && !saving) save(primarySave, 'next');
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (canEdit && !saving) save(primarySave);
    } else if (e.altKey && e.key === 'ArrowDown' && props.hasNext) {
      e.preventDefault();
      guard(props.onNext);
    } else if (e.altKey && e.key === 'ArrowUp' && props.hasPrev) {
      e.preventDefault();
      guard(props.onPrev);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && guard(props.onClose)} modal={false}>
      <Dialog.Portal>
        <Dialog.Content
          onKeyDown={onKey}
          onInteractOutside={(e) => e.preventDefault()}
          className="anim-slide fixed inset-y-0 right-0 z-30 flex w-full flex-col border-l border-line bg-surface shadow-pop sm:w-[min(640px,92vw)]"
          aria-describedby={undefined}
        >
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate font-mono text-[14px]">{d?.identifier ?? 'Loading…'}</Dialog.Title>
              <p className="text-[12px] text-subtle">
                {props.position ? `${props.position.toLocaleString()} of ${props.total.toLocaleString()}` : ''}
              </p>
            </div>
            <IconButton icon={ChevronUp} label="Previous key (Alt+↑)" disabled={!props.hasPrev} onClick={() => guard(props.onPrev)} />
            <IconButton icon={ChevronDown} label="Next key (Alt+↓)" disabled={!props.hasNext} onClick={() => guard(props.onNext)} />
            <IconButton icon={X} label="Close (Esc)" onClick={() => guard(props.onClose)} />
          </div>

          {!d ? (
            <div className="flex flex-col gap-3 p-4">
              {q.isError ? <p className="text-danger">{errorMessage(q.error)}</p> : <><Skeleton className="h-20" /><Skeleton className="h-40" /></>}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {/* Source */}
              <section className="border-b border-line px-4 py-4">
                <SourceBlock d={d} onSaved={refresh} onCopy={canEdit ? () => (setDraft(d.sourceText ?? ''), textRef.current?.focus()) : undefined} />
              </section>

              {/* Target */}
              <section className="border-b border-line px-4 py-4">
                {languageIds.length > 1 && (
                  <div role="tablist" aria-label="Target language" className="mb-3 flex flex-wrap gap-1">
                    {languageIds.map((lid) => {
                      const l = targetLanguages.find((x) => x.id === lid);
                      return (
                        <button
                          key={lid}
                          role="tab"
                          aria-selected={lid === activeLanguageId}
                          onClick={() => guard(() => props.onLanguageChange(lid))}
                          className={cx('flex h-7 cursor-pointer items-center gap-1.5 rounded px-2 text-[12px]', lid === activeLanguageId ? 'bg-hover text-fg ring-1 ring-line-strong' : 'text-muted hover:bg-hover/60')}
                        >
                          <span className="font-mono text-accent">{l?.code}</span>
                          <StatusDotSmall status={d.translations[lid]?.status ?? 'missing'} />
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="tr-value" className="flex items-center gap-2 text-[13px] font-medium">
                    {lang?.name} <span className="font-mono text-[12px] font-normal text-accent">{lang?.code}</span>
                    {lang?.direction === 'rtl' && <span className="text-[11px] text-subtle">RTL</span>}
                  </label>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={tr?.status ?? 'missing'} />
                    {tr?.sourceChanged && <span className="text-[12px] text-warn">Source changed since translated</span>}
                  </div>
                </div>
                {feedback && (
                  <div role="note" className="mb-2 flex gap-2 rounded border border-warn/40 bg-warn/[0.08] px-3 py-2 text-[13px]">
                    <RotateCcw size={14} className="mt-0.5 shrink-0 text-warn" aria-hidden />
                    <div className="min-w-0">
                      <p className="text-[12px] font-medium text-warn">
                        Changes requested{feedback.reviewer ? ` by ${feedback.reviewer}` : ''} · {relTime(feedback.createdAt)}
                      </p>
                      <p className="mt-0.5 whitespace-pre-wrap break-words text-fg">{feedback.comment}</p>
                    </div>
                  </div>
                )}
                <textarea
                  id="tr-value"
                  ref={textRef}
                  dir={lang?.direction === 'rtl' ? 'rtl' : 'auto'}
                  readOnly={!canEdit}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={6}
                  placeholder={canEdit ? `Enter the ${lang?.name} translation…` : 'No translation'}
                  className="input h-auto min-h-[140px] resize-y py-2 leading-relaxed read-only:opacity-80"
                />
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[12px] text-subtle">
                  <span className={cx('tabular-nums', !!d.maxLength && draft.length > d.maxLength && 'text-danger')}>
                    {draft.length} characters{d.maxLength ? ` / ${d.maxLength}` : ''} · source {(d.sourceText ?? '').length}
                  </span>
                  <span>{tr ? `Updated ${relTime(tr.updatedAt)}${tr.updatedBy ? ` by ${tr.updatedBy}` : ''}` : 'Not translated yet'}</span>
                </div>
                {warnings.length > 0 && draft && (
                  <ul className="mt-3 flex flex-col gap-1 rounded border border-warn/30 bg-warn/[0.06] px-3 py-2 text-[12px] text-warn" aria-live="polite">
                    {warnings.map((w, i) => (
                      <li key={i} className="flex items-center gap-1.5">
                        <AlertTriangle size={12} aria-hidden /> {w.message}
                      </li>
                    ))}
                  </ul>
                )}
                {conflict && (
                  <div role="alert" className="mt-3 rounded border border-danger/40 bg-danger/[0.06] p-3 text-[13px]">
                    <p className="font-medium text-danger">Someone else saved this translation while you were editing.</p>
                    <p className="mt-1 text-muted">Their version ({STATUS_LABELS[conflict.status as keyof typeof STATUS_LABELS] ?? conflict.status}):</p>
                    <p className="mt-1 whitespace-pre-wrap rounded bg-bg px-2 py-1.5">{conflict.value || '(empty)'}</p>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" onClick={() => (setDraft(conflict.value), setBaseline(conflict.value), setConflict(null), refresh())}>
                        Use their version
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => save(primarySave, undefined, conflict.version || undefined)}>
                        Overwrite with mine
                      </Button>
                    </div>
                  </div>
                )}
                {!canEdit && <div className="mt-3"><ReadOnlyNote>{d.editable ? 'You have read-only access to this language.' : 'This key belongs only to archived platforms and is read-only.'}</ReadOnlyNote></div>}
                {canEdit && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button variant="primary" icon={Save} loading={saving} onClick={() => save(primarySave, 'next')} disabled={!props.hasNext && !dirty}>
                      {can('approve') ? 'Approve & next' : 'Submit & next'}
                    </Button>
                    <Button icon={Check} onClick={() => save(primarySave)} disabled={saving}>
                      {can('approve') ? 'Save as approved' : 'Submit for review'}
                    </Button>
                    <Button variant="ghost" onClick={() => save('draft')} disabled={saving || !draft}>
                      Save draft
                    </Button>
                    {dirty && (
                      <Button variant="ghost" onClick={() => setDraft(baseline)}>
                        Cancel
                      </Button>
                    )}
                    <span className="ml-auto hidden text-[11px] text-subtle sm:inline">
                      <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span> save & next
                    </span>
                  </div>
                )}
                {tr && tr.status !== 'missing' && (can('approve') || can('review')) && !dirty && (
                  <div className="mt-3 flex gap-2 border-t border-line pt-3">
                    <span className="label self-center">Review</span>
                    {can('approve') && tr.status !== 'approved' && (
                      <Button size="sm" icon={Check} onClick={() => review('approve')}>
                        Approve
                      </Button>
                    )}
                    {can('review') && (
                      <Button size="sm" icon={RotateCcw} onClick={() => review('request_changes')}>
                        Request changes
                      </Button>
                    )}
                  </div>
                )}
              </section>

              {/* Tabs */}
              <div role="tablist" className="flex gap-1 border-b border-line px-4">
                {(['details', 'history'] as const).map((t) => (
                  <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cx('h-9 cursor-pointer border-b-2 px-2 text-[13px] capitalize', tab === t ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}>
                    {t === 'details' ? 'Details' : `History (${d.history.length})`}
                  </button>
                ))}
              </div>
              {tab === 'details' ? (
                <div className="flex flex-col gap-5 px-4 py-4">
                  <PlatformsBlock d={d} allPlatforms={platforms} onSaved={refresh} />
                  <SegmentsBlock d={d} segments={segments.data ?? []} onSaved={() => (refresh(), qc.invalidateQueries({ queryKey: ['segments'] }))} />
                  <MetaBlock d={d} onSaved={refresh} />
                  {(d.alternates.length > 0 || d.conflicts.length > 0) && <LegacyBlock d={d} languageId={activeLanguageId} onUse={(v) => setDraft(v)} onResolved={refresh} />}
                </div>
              ) : (
                <HistoryBlock d={d} />
              )}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function StatusDotSmall({ status }: { status: string }) {
  const c = status === 'approved' ? 'bg-ok' : status === 'needs_review' ? 'bg-review' : status === 'in_progress' ? 'bg-warn' : status === 'draft' ? 'bg-muted' : 'border border-line-strong';
  return <span className={cx('h-1.5 w-1.5 rounded-full', c)} aria-label={status} />;
}

function SourceBlock({ d, onSaved, onCopy }: { d: KeyDetail; onSaved: () => void; onCopy?: () => void }) {
  const { can, sourceLanguage } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(d.sourceText ?? '');
  useEffect(() => setValue(d.sourceText ?? ''), [d.sourceText]);
  if (d.sourceText === null) return <ReadOnlyNote>You don't have access to source strings.</ReadOnlyNote>;
  const save = async () => {
    if (!(await confirm({ title: 'Change the source string?', body: 'Approved and submitted translations of this key in every language will be marked "In progress" so translators re-check them.', confirmLabel: 'Change source' }))) return;
    try {
      await api.patch(`/api/keys/${d.id}`, { expectedVersion: d.version, sourceText: value });
      toast('ok', 'Source updated');
      setEditing(false);
      onSaved();
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="label">
          {sourceLanguage?.name ?? 'Source'} · source
        </span>
        <div className="flex gap-1">
          {onCopy && <IconButton icon={Copy} label="Copy source into the translation field" onClick={onCopy} />}
          {can('edit_source') && d.editable && !editing && <IconButton icon={Pencil} label="Edit source string" onClick={() => setEditing(true)} />}
        </div>
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea className="input h-auto min-h-[90px] py-2" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Source string" />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={save} disabled={value === d.sourceText}>
              Save source
            </Button>
            <Button size="sm" variant="ghost" onClick={() => (setEditing(false), setValue(d.sourceText ?? ''))}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap rounded bg-bg px-3 py-2.5 text-[15px] leading-relaxed">{d.sourceText || <span className="italic text-subtle">(empty source string)</span>}</p>
      )}
      {d.description && (
        <p className="mt-2 flex gap-1.5 text-[13px] text-muted">
          <Info size={14} className="mt-0.5 shrink-0" aria-hidden /> {d.description}
        </p>
      )}
    </div>
  );
}

function PlatformsBlock({ d, allPlatforms, onSaved }: { d: KeyDetail; allPlatforms: { id: number; name: string }[]; onSaved: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [value, setValue] = useState(d.platforms.map((p) => p.id));
  useEffect(() => setValue(d.platforms.map((p) => p.id)), [d.platforms]);
  const changed = JSON.stringify([...value].sort()) !== JSON.stringify(d.platforms.map((p) => p.id).sort());
  const editable = can('manage_keys') && d.editable;
  const shared = d.platformCount > 1;
  const save = async () => {
    try {
      await api.put(`/api/keys/${d.id}/platforms`, { platformIds: value });
      toast('ok', 'Platforms updated');
      onSaved();
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  const split = async (pid: number, name: string) => {
    if (!(await confirm({ title: `Make a separate key for ${name}?`, body: `${name} stops using this shared key and gets its own copy (same source and translations). Afterwards, edits to one do not affect the other.`, confirmLabel: 'Split key' }))) return;
    try {
      await api.post(`/api/keys/${d.id}/split`, { platformId: pid });
      toast('ok', `${name} now has its own key`);
      onSaved();
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="label">Platforms</span>
        {shared && <span className="text-[12px] text-info">Shared key · one translation used by {d.platformCount} platforms</span>}
      </div>
      {editable ? (
        <>
          <MultiSelect
            label="Platforms"
            placeholder="Assign platforms"
            options={allPlatforms.map((p) => ({ value: p.id, label: p.name }))}
            value={value}
            onChange={setValue}
            renderTag={(o, remove) => (
              <span className="inline-flex h-[24px] items-center gap-1 rounded bg-hover pl-2 pr-1 text-[12px]">
                {o.label}
                {shared && d.platforms.some((p) => p.id === o.value) && (
                  <button type="button" title={`Split into a separate key for ${o.label}`} aria-label={`Split key for ${o.label}`} className="grid h-4 w-4 cursor-pointer place-items-center rounded text-subtle hover:text-fg" onClick={() => split(o.value, o.label)}>
                    <GitFork size={11} aria-hidden />
                  </button>
                )}
                <button type="button" aria-label={`Remove ${o.label}`} className="grid h-4 w-4 cursor-pointer place-items-center rounded text-subtle hover:text-fg" onClick={remove}>
                  <X size={11} aria-hidden />
                </button>
              </span>
            )}
          />
          {changed && (
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" variant="primary" onClick={save}>
                Save platforms
              </Button>
              <span className="text-[12px] text-subtle">Added platforms share this key and its translations.</span>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-wrap gap-1">
          {d.platforms.map((p) => (
            <PlatformBadge key={p.id} name={p.name} />
          ))}
        </div>
      )}
      {d.hiddenPlatformCount > 0 && <p className="mt-1.5 text-[12px] text-subtle">Also used by {d.hiddenPlatformCount} platform(s) outside your access. Your edits apply there too.</p>}
    </div>
  );
}

function SegmentsBlock({ d, segments, onSaved }: { d: KeyDetail; segments: Segment[]; onSaved: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [value, setValue] = useState(d.segments.map((s) => s.id));
  const [created, setCreated] = useState<string[]>([]);
  useEffect(() => (setValue(d.segments.map((s) => s.id)), setCreated([])), [d.segments]);
  const editable = can('manage_segments') && d.editable;
  const changed = created.length > 0 || JSON.stringify([...value].sort()) !== JSON.stringify(d.segments.map((s) => s.id).sort());
  const save = async () => {
    try {
      await api.put(`/api/keys/${d.id}/segments`, { segmentIds: value, createNames: created });
      toast('ok', 'Segments updated');
      onSaved();
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  return (
    <div>
      <div className="label mb-2">Segments <span className="normal-case tracking-normal text-subtle">· optional</span></div>
      {editable ? (
        <>
          <MultiSelect
            label="Segments"
            placeholder="Add segments…"
            options={segments.map((s) => ({ value: s.id, label: s.name, hint: String(s.keyCount) }))}
            value={value}
            onChange={setValue}
            onCreate={(name) => setCreated((c) => [...new Set([...c, name])])}
          />
          {created.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {created.map((c) => (
                <SegmentTag key={c} name={`${c} (new)`} onRemove={() => setCreated(created.filter((x) => x !== c))} />
              ))}
            </div>
          )}
          {changed && (
            <Button size="sm" variant="primary" className="mt-2" onClick={save}>
              Save segments
            </Button>
          )}
        </>
      ) : d.segments.length ? (
        <div className="flex flex-wrap gap-1">
          {d.segments.map((s) => (
            <SegmentTag key={s.id} name={s.name} />
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-subtle">No segments</p>
      )}
      {d.segments.length > 0 && (
        <p className="mt-2 text-[12px] text-subtle">
          See other keys in{' '}
          {d.segments.slice(0, 4).map((s, i) => (
            <span key={s.id}>
              {i > 0 && ', '}
              <Link className="text-accent hover:underline" to={`/workspace?segments=${s.id}`}>
                {s.name}
              </Link>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function MetaBlock({ d, onSaved }: { d: KeyDetail; onSaved: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [identifier, setIdentifier] = useState(d.identifier);
  const [description, setDescription] = useState(d.description);
  const [maxLength, setMaxLength] = useState(d.maxLength ? String(d.maxLength) : '');
  useEffect(() => (setIdentifier(d.identifier), setDescription(d.description), setMaxLength(d.maxLength ? String(d.maxLength) : '')), [d]);
  const editable = can('manage_keys') && d.editable;
  const save = async () => {
    try {
      await api.patch(`/api/keys/${d.id}`, {
        expectedVersion: d.version,
        identifier: identifier !== d.identifier ? identifier : undefined,
        description,
        maxLength: maxLength ? Number(maxLength) : null,
      });
      toast('ok', 'Key updated');
      setEditing(false);
      onSaved();
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="label">Key</span>
        {editable && !editing && (
          <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-3">
          <Field label="Keyword identifier" hint="Renaming changes the resource name in every platform export.">
            <input className="input font-mono" value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
          </Field>
          <Field label="Description / translator note">
            <textarea className="input h-auto min-h-[70px] py-2" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Character limit" hint="Optional. Translations longer than this get a warning.">
            <input className="input w-32" inputMode="numeric" value={maxLength} onChange={(e) => setMaxLength(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={save}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 text-[13px]">
          <dt className="text-subtle">Identifier</dt>
          <dd className="break-all font-mono">{d.identifier}</dd>
          <dt className="text-subtle">Note</dt>
          <dd className="text-muted">{d.description || '—'}</dd>
          <dt className="text-subtle">Char limit</dt>
          <dd className="text-muted">{d.maxLength ?? '—'}</dd>
        </dl>
      )}
    </div>
  );
}

function LegacyBlock({ d, languageId, onUse, onResolved }: { d: KeyDetail; languageId: number; onUse: (v: string) => void; onResolved: () => void }) {
  const { can, targetLanguages } = useSession();
  const toast = useToast();
  const resolve = async (id: number, resolution: string) => {
    try {
      await api.post(`/api/conflicts/${id}/resolve`, { resolution });
      toast('ok', 'Conflict resolved');
      onResolved();
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  const langName = (id: number | null) => (id === null ? 'Source' : targetLanguages.find((l) => l.id === id)?.code ?? id);
  const conflicts = d.conflicts.filter((c) => c.languageId === languageId || c.languageId === null);
  const alternates = d.alternates.filter((a) => a.languageId === languageId);
  return (
    <div>
      <div className="label mb-2">From the legacy workbook</div>
      {conflicts.map((c) => (
        <div key={c.id} className="mb-2 rounded border border-warn/30 bg-warn/[0.05] p-3 text-[13px]">
          <p className="text-[12px] text-warn">
            {c.kind.replace('_', ' ')} · {c.sheet} row {c.row} · column “{c.header}” · {langName(c.languageId)}
          </p>
          <div className="mt-1.5 grid grid-cols-[70px_1fr] gap-x-2 gap-y-1">
            <span className="text-subtle">Current</span>
            <span className="whitespace-pre-wrap">{c.currentValue || '—'}</span>
            <span className="text-subtle">Workbook</span>
            <span className="whitespace-pre-wrap">{c.incomingValue}</span>
          </div>
          {(c.languageId ? can('edit_translations') : can('edit_source')) && d.editable && (
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => resolve(c.id, 'kept_current')}>
                Keep current
              </Button>
              <Button size="sm" onClick={() => resolve(c.id, 'used_incoming')}>
                Use workbook value
              </Button>
            </div>
          )}
        </div>
      ))}
      {alternates
        .filter((a) => !conflicts.some((c) => c.incomingValue === a.value))
        .map((a) => (
          <div key={a.id} className="mb-2 rounded border border-line p-3 text-[13px]">
            <p className="text-[12px] text-subtle">
              {a.sheet} · column “{a.header}” ({a.role.replace('_', ' ')})
            </p>
            <p className="mt-1 whitespace-pre-wrap">{a.value}</p>
            {can('edit_translations') && d.editable && (
              <Button size="sm" variant="ghost" className="mt-1" onClick={() => onUse(a.value)}>
                Use this text
              </Button>
            )}
          </div>
        ))}
      {!conflicts.length && !alternates.length && <p className="text-[13px] text-subtle">Nothing for this language.</p>}
    </div>
  );
}

function HistoryBlock({ d }: { d: KeyDetail }) {
  const { targetLanguages } = useSession();
  const code = (id: number) => targetLanguages.find((l) => l.id === id)?.code;
  const items = [
    ...d.history.map((h) => ({ at: h.createdAt, kind: 'h', h })),
    ...d.reviews.map((r) => ({ at: r.createdAt, kind: 'r', r })),
    ...d.sourceRevisions.map((s) => ({ at: s.createdAt, kind: 's', s })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  if (!items.length) return <p className="px-4 py-6 text-[13px] text-subtle">No history yet.</p>;
  return (
    <ol className="flex flex-col gap-3 px-4 py-4">
      {items.map((it, i) => (
        <li key={i} className="flex gap-3 text-[13px]">
          <History size={14} className="mt-0.5 shrink-0 text-subtle" aria-hidden />
          <div className="min-w-0 flex-1">
            {it.kind === 'h' && (
              <>
                <p className="text-muted">
                  <span className="font-mono text-[11px] text-accent">{code((it as any).h.languageId)}</span> {(it as any).h.reason} by {(it as any).h.changedBy ?? 'import'} · <StatusBadge status={(it as any).h.status} />
                </p>
                <p className="mt-0.5 whitespace-pre-wrap break-words">{(it as any).h.value || <span className="italic text-subtle">(empty)</span>}</p>
              </>
            )}
            {it.kind === 'r' && (
              <p className="text-muted">
                <span className="font-mono text-[11px] text-accent">{code((it as any).r.languageId)}</span> {(it as any).r.action.replace('_', ' ')} by {(it as any).r.reviewer}
                {(it as any).r.comment && <span className="mt-0.5 block text-fg">“{(it as any).r.comment}”</span>}
              </p>
            )}
            {it.kind === 's' && (
              <>
                <p className="text-muted">Source set by {(it as any).s.changedBy ?? 'import'}</p>
                <p className="mt-0.5 whitespace-pre-wrap">{(it as any).s.sourceText}</p>
              </>
            )}
            <p className="text-[11px] text-subtle">{new Date(it.at).toLocaleString()}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
