import * as Popover from '@radix-ui/react-popover';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Check, Columns3, Download, Filter, Plus, RotateCcw, SearchX, Tags, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs, type KeyRow, type Segment } from '../lib/api';
import { readPref, useSession, writePref } from '../lib/session';
import { STATUS_LABELS, STATUSES } from '../../../shared/domain';
import {
  Button,
  Checkbox,
  cx,
  EmptyState,
  ErrorState,
  MultiSelect,
  Pagination,
  PlatformBadge,
  SearchInput,
  Segmented,
  SegmentTag,
  Select,
  Skeleton,
  StatusBadge,
  relTime,
  useConfirm,
  useDebounced,
  usePrompt,
  useToast,
  errorMessage,
} from '../components/ui';
import { TranslationEditor } from '../components/Editor';
import { NewKeyDialog } from '../components/NewKeyDialog';

const FLAG_LABELS: Record<string, string> = {
  modified: 'Modified',
  recent: 'Changed in 7 days',
  untranslated_source: 'Empty English source',
  duplicates: 'Duplicate-key candidates',
  conflicts: 'Open import conflicts',
  source_changed: 'Source changed',
  no_segment: 'No segment',
};

type ColumnId = 'identifier' | 'source' | 'translation' | 'status' | 'segments' | 'platforms' | 'updated' | 'by';
const COLUMN_LABELS: Record<ColumnId, string> = {
  identifier: 'Keyword',
  source: 'English source',
  translation: 'Translation',
  status: 'Status',
  segments: 'Segments',
  platforms: 'Platforms',
  updated: 'Last modified',
  by: 'Translator / reviewer',
};
const DEFAULT_WIDTHS: Record<ColumnId, number> = { identifier: 220, source: 300, translation: 320, status: 130, segments: 170, platforms: 170, updated: 110, by: 150 };

type Mode = 'single' | 'compare' | 'all';

export default function Workspace() {
  const { platforms, targetLanguages, sourceLanguage, can } = useSession();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const qc = useQueryClient();

  // ---------------------------------------------------------------- URL-backed state
  const get = (k: string) => params.get(k) ?? '';
  const list = (k: string) => get(k).split(',').filter(Boolean);
  const set = useCallback(
    (patch: Record<string, string | string[] | number | null>, keepPage = false) => {
      setParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            const s = Array.isArray(v) ? v.join(',') : v === null ? '' : String(v);
            s ? sp.set(k, s) : sp.delete(k);
          }
          if (!keepPage && !('page' in patch)) sp.delete('page');
          return sp;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const platformId = Number(get('platform')) || null;
  const multiLang = targetLanguages.length > 1;
  // Compare mode is switched off: old ?mode=compare links fall back to Single.
  const requestedMode = (get('mode') as Mode) || 'single';
  const mode = (multiLang && requestedMode !== 'compare' ? requestedMode : 'single') as Mode;
  const primaryLang = Number(get('lang')) || targetLanguages[0]?.id || null;
  const compareLangs = list('langs').map(Number).filter((id) => targetLanguages.some((l) => l.id === id));
  const languageIds =
    mode === 'all' ? targetLanguages.map((l) => l.id) : mode === 'compare' ? [...new Set([primaryLang!, ...compareLangs])].filter(Boolean) : primaryLang ? [primaryLang] : [];
  const statuses = list('statuses');
  const flags = list('flags');
  const segmentIds = list('segments').map(Number);
  const sort = get('sort') || 'identifier';
  const dir = get('dir') || 'asc';
  const page = Number(get('page')) || 1;
  const pageSize = Number(get('size')) || readPref('pageSize', 50);
  const [search, setSearch] = useState(get('q'));
  const debounced = useDebounced(search, 300);
  useEffect(() => setSearch(get('q')), [params.get('q')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (debounced !== get('q')) set({ q: debounced });
  }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = {
    platformIds: platformId ? [platformId] : [],
    languageIds,
    statuses,
    flags,
    segmentIds,
    search: get('q'),
    sort,
    dir,
    page,
    pageSize,
  };
  const rows = useQuery({
    queryKey: ['keys', query],
    queryFn: () => api.get<{ total: number; rows: KeyRow[]; languageIds: number[] }>(`/api/keys${qs(query)}`),
    placeholderData: keepPreviousData,
    enabled: languageIds.length > 0 || targetLanguages.length === 0,
  });
  const segments = useQuery({ queryKey: ['segments'], queryFn: () => api.get<Segment[]>('/api/segments'), staleTime: 60_000 });

  // ---------------------------------------------------------------- columns
  const [hidden, setHidden] = useState<ColumnId[]>(() => readPref('hiddenCols', ['by']));
  const [widths, setWidths] = useState<Record<ColumnId, number>>(() => ({ ...DEFAULT_WIDTHS, ...readPref('colWidths', {}) }));
  const showPlatforms = !platformId;
  const columns = (Object.keys(COLUMN_LABELS) as ColumnId[]).filter(
    (c) => !hidden.includes(c) && (c !== 'platforms' || showPlatforms) && (c !== 'source' || can('view_source')),
  );
  const startResize = (col: ColumnId, e: React.PointerEvent) => {
    e.preventDefault();
    const start = e.clientX;
    const w0 = widths[col];
    const move = (ev: PointerEvent) => setWidths((w) => ({ ...w, [col]: Math.max(80, w0 + ev.clientX - start) }));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWidths((w) => (writePref('colWidths', w), w));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---------------------------------------------------------------- selection & keyboard
  const data = rows.data;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  useEffect(() => setSelected(new Set()), [JSON.stringify({ ...query, page: 0 })]); // eslint-disable-line react-hooks/exhaustive-deps
  const [cursor, setCursor] = useState(0);
  const tableRef = useRef<HTMLDivElement>(null);
  const openKey = Number(get('key')) || null;
  const openLang = Number(get('editLang')) || primaryLang;
  const open = (id: number, langId?: number) => set({ key: id, editLang: langId ?? null }, true);
  const [newKeyOpen, setNewKeyOpen] = useState(false);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!data?.rows.length || openKey) return;
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      setCursor((c) => Math.min(data.rows.length - 1, c + 1));
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      open(data.rows[cursor].id);
    } else if (e.key === 'x') {
      const id = data.rows[cursor].id;
      setSelected((s) => {
        const n = new Set(s);
        n.has(id) ? n.delete(id) : n.add(id);
        return n;
      });
    }
  };
  useEffect(() => {
    tableRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const idx = data?.rows.findIndex((r) => r.id === openKey) ?? -1;
  const total = data?.total ?? 0;
  const goRelative = (delta: number) => {
    if (!data) return;
    const next = idx + delta;
    if (next >= 0 && next < data.rows.length) {
      setCursor(next);
      open(data.rows[next].id, openLang ?? undefined);
    } else if (delta > 0 && page * pageSize < total) {
      set({ page: page + 1, key: null });
      setPendingOpen('first');
    } else if (delta < 0 && page > 1) {
      set({ page: page - 1, key: null });
      setPendingOpen('last');
    }
  };
  const [pendingOpen, setPendingOpen] = useState<'first' | 'last' | null>(null);
  useEffect(() => {
    if (pendingOpen && data?.rows.length && !rows.isPlaceholderData) {
      const r = pendingOpen === 'first' ? data.rows[0] : data.rows[data.rows.length - 1];
      setPendingOpen(null);
      open(r.id, openLang ?? undefined);
    }
  }, [data, pendingOpen, rows.isPlaceholderData]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- bulk actions
  const selectedIds = [...selected];
  const runBulk = async (label: string, fn: () => Promise<any>) => {
    try {
      const r = await fn();
      toast('ok', `${label}${r?.changed !== undefined ? `: ${r.changed} changed, ${r.skipped} skipped` : ''}`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['keys'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  const bulkReview = async (action: 'approve' | 'request_changes') => {
    if (!primaryLang) return;
    let comment = '';
    if (action === 'request_changes') {
      const text = await prompt({ title: `Request changes on ${selectedIds.length} translations`, label: 'What needs to change? (sent to translators)', confirmLabel: 'Send back' });
      if (!text) return;
      comment = text;
    } else if (!(await confirm({ title: `Approve ${selectedIds.length} translations?`, body: `Approves the ${lang(primaryLang)?.name} value of each selected key. Empty translations are skipped.`, confirmLabel: 'Approve' }))) return;
    runBulk(action === 'approve' ? 'Approved' : 'Changes requested', () =>
      api.post('/api/translations/bulk-review', { items: selectedIds.map((keyId) => ({ keyId, languageId: primaryLang })), action, comment }),
    );
  };
  const [bulkSegs, setBulkSegs] = useState<number[]>([]);
  const lang = (id: number) => targetLanguages.find((l) => l.id === id);

  const activeFilterCount = statuses.length + flags.length + segmentIds.length;
  const platformTabs = [{ id: 0, name: 'All platforms' }, ...platforms];

  if (targetLanguages.length === 0) {
    return (
      <div className="p-6">
        <EmptyState title="No target languages assigned">Ask an administrator to assign at least one language to your account.</EmptyState>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Platform tabs */}
      <div className="border-b border-line bg-surface px-3 sm:px-5">
        <div role="tablist" aria-label="Platform" className="-mb-px flex gap-1 overflow-x-auto pt-2">
          {platformTabs.map((p) => {
            const active = (platformId ?? 0) === p.id;
            return (
              <button
                key={p.id}
                role="tab"
                aria-selected={active}
                onClick={() => {
                  writePref('platform', p.id || '');
                  set({ platform: p.id || null, key: null });
                }}
                className={cx(
                  'h-9 shrink-0 cursor-pointer whitespace-nowrap border-b-2 px-3 text-[13px] transition-colors duration-fast',
                  active ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
                )}
              >
                {p.name}
                {'keyCount' in p && <span className="ml-1.5 text-[11px] tabular-nums text-subtle">{(p as any).keyCount}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5 sm:px-5">
        <SearchInput value={search} onChange={setSearch} placeholder="Search keyword, English, translation, segment…" className="w-full sm:w-[320px]" />
        {multiLang && (
          <Segmented<Mode>
            label="Language view"
            value={mode}
            onChange={(m) => set({ mode: m === 'single' ? null : m })}
            options={[
              { value: 'single', label: 'Single' },
              // Compare mode is switched off for now; restore this line (and the mode fallback above) to bring it back.
              // { value: 'compare', label: 'Compare' },
              { value: 'all', label: 'All languages' },
            ]}
          />
        )}
        {multiLang && (
          <Select
            aria-label="Target language"
            className="w-[190px]"
            value={primaryLang ?? ''}
            onChange={(e) => {
              writePref('lang', e.target.value);
              set({ lang: e.target.value });
            }}
          >
            {targetLanguages.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.code})
              </option>
            ))}
          </Select>
        )}
        {!multiLang && primaryLang && (
          <span className="text-[13px] text-muted">
            English → <span className="text-fg">{lang(primaryLang)?.name}</span>
          </span>
        )}
        {mode === 'compare' && (
          <div className="w-[240px]">
            <MultiSelect
              label="Compare with"
              placeholder="Compare with…"
              options={targetLanguages.filter((l) => l.id !== primaryLang).map((l) => ({ value: l.id, label: l.name, hint: l.code }))}
              value={compareLangs}
              onChange={(v) => set({ langs: v.map(String) }, true)}
            />
          </div>
        )}
        <FiltersPopover
          statuses={statuses}
          flags={flags}
          segmentIds={segmentIds}
          segments={segments.data ?? []}
          onChange={(p) => set(p)}
          count={activeFilterCount}
        />
        <Select
          aria-label="Sort"
          className="w-[170px]"
          value={`${sort}:${dir}`}
          onChange={(e) => {
            const [s, d] = e.target.value.split(':');
            set({ sort: s, dir: d });
          }}
        >
          <option value="identifier:asc">Keyword A→Z</option>
          <option value="identifier:desc">Keyword Z→A</option>
          {can('view_source') && <option value="source:asc">English A→Z</option>}
          <option value="updated:desc">Recently modified</option>
          <option value="updated:asc">Least recently modified</option>
        </Select>
        <ColumnsPopover hidden={hidden} onChange={(h) => (setHidden(h), writePref('hiddenCols', h))} />
        <div className="ml-auto flex items-center gap-3">
          {data && <Pagination page={page} pageSize={pageSize} total={total} onPage={(p) => set({ page: p }, true)} />}
          {can('manage_keys') && (
            <Button variant="primary" icon={Plus} onClick={() => setNewKeyOpen(true)}>
              New key
            </Button>
          )}
        </div>
      </div>
      {can('manage_keys') && (
        <NewKeyDialog
          open={newKeyOpen}
          onOpenChange={setNewKeyOpen}
          defaultPlatformId={platformId}
          segments={segments.data ?? []}
          onCreated={(id) => {
            qc.invalidateQueries({ queryKey: ['keys'] });
            qc.invalidateQueries({ queryKey: ['segments'] });
            qc.invalidateQueries({ queryKey: ['platforms'] });
            qc.invalidateQueries({ queryKey: ['dashboard'] });
            open(id);
          }}
        />
      )}

      {/* Active filter chips */}
      {(activeFilterCount > 0 || get('q')) && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2 sm:px-5">
          {get('q') && <Chip label={`“${get('q')}”`} onRemove={() => (setSearch(''), set({ q: null }))} />}
          {statuses.map((s) => (
            <Chip key={s} label={STATUS_LABELS[s as keyof typeof STATUS_LABELS]} onRemove={() => set({ statuses: statuses.filter((x) => x !== s) })} />
          ))}
          {flags.map((f) => (
            <Chip key={f} label={FLAG_LABELS[f]} onRemove={() => set({ flags: flags.filter((x) => x !== f) })} />
          ))}
          {segmentIds.map((id) => (
            <Chip key={id} label={`Segment: ${segments.data?.find((s) => s.id === id)?.name ?? id}`} onRemove={() => set({ segments: segmentIds.filter((x) => x !== id).map(String) })} />
          ))}
          <button className="cursor-pointer text-[12px] text-accent hover:underline" onClick={() => (setSearch(''), set({ statuses: null, flags: null, segments: null, q: null }))}>
            Clear all
          </button>
        </div>
      )}

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div className="anim-fade flex flex-wrap items-center gap-2 border-b border-accent/30 bg-accent/[0.06] px-3 py-2 sm:px-5" role="region" aria-label="Bulk actions">
          <span className="text-[13px] font-medium">{selected.size} selected</span>
          <Button size="sm" variant="ghost" icon={X} onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <div className="mx-1 h-5 w-px bg-line" />
          {can('approve') && primaryLang && (
            <Button size="sm" icon={Check} onClick={() => bulkReview('approve')}>
              Approve {lang(primaryLang)?.code}
            </Button>
          )}
          {can('review') && primaryLang && (
            <Button size="sm" icon={RotateCcw} onClick={() => bulkReview('request_changes')}>
              Request changes
            </Button>
          )}
          {can('manage_segments') && (
            <Popover.Root>
              <Popover.Trigger asChild>
                <Button size="sm" icon={Tags}>
                  Segments…
                </Button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content sideOffset={6} className="anim-fade z-50 w-[300px] rounded-lg border border-line bg-raised p-3 shadow-pop">
                  <MultiSelect label="Segments" placeholder="Choose segments" options={(segments.data ?? []).map((s) => ({ value: s.id, label: s.name }))} value={bulkSegs} onChange={setBulkSegs} />
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" variant="primary" disabled={!bulkSegs.length} onClick={() => runBulk('Segments added', () => api.post('/api/keys/bulk', { keyIds: selectedIds, addSegmentIds: bulkSegs }))}>
                      Add
                    </Button>
                    <Button size="sm" disabled={!bulkSegs.length} onClick={() => runBulk('Segments removed', () => api.post('/api/keys/bulk', { keyIds: selectedIds, removeSegmentIds: bulkSegs }))}>
                      Remove
                    </Button>
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          )}
          {can('manage_keys') && (
            <Select
              aria-label="Share with platform"
              className="w-[190px]"
              value=""
              onChange={(e) => e.target.value && runBulk('Shared with platform', () => api.post('/api/keys/bulk', { keyIds: selectedIds, addPlatformIds: [Number(e.target.value)] }))}
            >
              <option value="">Share with platform…</option>
              {platforms.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
          {can('manage_keys') && (
            <Button
              size="sm"
              variant="danger"
              icon={Archive}
              onClick={async () =>
                (await confirm({ title: `Archive ${selected.size} keys?`, body: 'Archived keys are hidden from the workspace and excluded from exports. Their translations are kept and can be restored.', confirmLabel: 'Archive', danger: true })) &&
                runBulk('Archived', () => api.post('/api/keys/bulk', { keyIds: selectedIds, archive: true }))
              }
            >
              Archive
            </Button>
          )}
          {can('export') && (
            <Button
              size="sm"
              icon={Download}
              onClick={() =>
                api
                  .download('/api/export/excel', { layout: 'normalized', keyIds: selectedIds, languageIds, platformIds: platformId ? [platformId] : undefined, includeStatus: true })
                  .then((r) => toast('ok', `Downloaded ${r.fileName}`))
                  .catch((e) => toast('error', errorMessage(e)))
              }
            >
              Export selection
            </Button>
          )}
        </div>
      )}

      {/* Table */}
      <div ref={tableRef} tabIndex={0} onKeyDown={onKeyDown} aria-label="Translation keys. Use arrow keys to move, Enter to open, X to select." className="relative min-h-0 flex-1 overflow-auto focus-visible:shadow-none">
        {rows.isError ? (
          <ErrorState error={rows.error} retry={() => rows.refetch()} />
        ) : (
          <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]" aria-rowcount={total}>
            <thead className="sticky top-0 z-10 bg-surface">
              <tr>
                <th className="sticky left-0 z-20 w-10 border-b border-line bg-surface px-3 text-left">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    className="h-4 w-4 cursor-pointer accent-[rgb(var(--accent))]"
                    checked={!!data?.rows.length && data.rows.every((r) => selected.has(r.id))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(data?.rows.map((r) => r.id)) : new Set())}
                  />
                </th>
                {columns.flatMap((c) =>
                  c === 'translation'
                    ? languageIds.map((lid) => (
                        <HeaderCell key={`t${lid}`} width={widths.translation} onResize={(e) => startResize('translation', e)}>
                          {lang(lid)?.name} <span className="font-mono text-[11px] font-normal text-accent">{lang(lid)?.code}</span>
                        </HeaderCell>
                      ))
                    : c === 'status' && languageIds.length > 1
                      ? []
                      : [
                          <HeaderCell key={c} width={widths[c]} onResize={(e) => startResize(c, e)}>
                            {c === 'source' ? `${sourceLanguage?.name ?? 'Source'}` : COLUMN_LABELS[c]}
                          </HeaderCell>,
                        ],
                )}
              </tr>
            </thead>
            <tbody>
              {rows.isLoading &&
                Array.from({ length: 12 }).map((_, i) => (
                  <tr key={i}>
                    <td className="border-b border-line px-3 py-3" colSpan={columns.length + languageIds.length + 1}>
                      <Skeleton className="h-4" />
                    </td>
                  </tr>
                ))}
              {data?.rows.map((r, i) => {
                const t = primaryLang ? r.translations[primaryLang] : undefined;
                return (
                  <tr
                    key={r.id}
                    data-row={i}
                    aria-selected={selected.has(r.id)}
                    onClick={() => (setCursor(i), open(r.id))}
                    className={cx(
                      'group cursor-pointer transition-colors duration-fast',
                      openKey === r.id ? 'bg-accent/[0.08]' : cursor === i ? 'bg-hover/70' : 'hover:bg-hover/50',
                      rows.isPlaceholderData && 'opacity-60',
                    )}
                  >
                    <td className="sticky left-0 border-b border-line bg-inherit px-3 py-2 align-top" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.identifier}`}
                        className="mt-0.5 h-4 w-4 cursor-pointer accent-[rgb(var(--accent))]"
                        checked={selected.has(r.id)}
                        onChange={(e) => {
                          const n = new Set(selected);
                          e.target.checked ? n.add(r.id) : n.delete(r.id);
                          setSelected(n);
                        }}
                      />
                    </td>
                    {columns.flatMap((c) => {
                      const td = (key: string, children: React.ReactNode, w: number, extra?: string) => (
                        <td key={key} className={cx('border-b border-line px-3 py-2 align-top', extra)} style={{ maxWidth: w, width: w }}>
                          {children}
                        </td>
                      );
                      switch (c) {
                        case 'identifier':
                          return [
                            td(
                              c,
                              <div className="flex flex-col gap-0.5">
                                <span className="break-all font-mono text-[12px] text-fg">{r.identifier}</span>
                                <span className="flex items-center gap-1.5 text-[11px] text-subtle">
                                  {r.platformCount > 1 && <span title={`Shared by ${r.platformCount} platforms`}>shared ×{r.platformCount}</span>}
                                  {r.openConflicts > 0 && <span className="text-warn">{r.openConflicts} conflict{r.openConflicts > 1 ? 's' : ''}</span>}
                                </span>
                              </div>,
                              widths.identifier,
                            ),
                          ];
                        case 'source':
                          return [td(c, <CellText text={r.sourceText ?? ''} empty="(empty source)" />, widths.source)];
                        case 'translation':
                          return languageIds.map((lid) => {
                            const tr = r.translations[lid];
                            const l = lang(lid);
                            return (
                              <td
                                key={`t${lid}`}
                                className="border-b border-line px-3 py-2 align-top"
                                style={{ maxWidth: widths.translation, width: widths.translation }}
                                onClick={(e) => (e.stopPropagation(), setCursor(i), open(r.id, lid))}
                              >
                                <div className="flex items-start gap-2">
                                  {languageIds.length > 1 && <StatusDot status={tr?.status ?? 'missing'} />}
                                  <CellText text={tr?.value ?? ''} empty="Missing" dir={l?.direction} />
                                </div>
                              </td>
                            );
                          });
                        case 'status':
                          return languageIds.length > 1
                            ? []
                            : [td(c, <div className="flex flex-col items-start gap-1"><StatusBadge status={t?.status ?? 'missing'} />{t?.sourceChanged && <span className="text-[11px] text-warn">source changed</span>}</div>, widths.status)];
                        case 'segments':
                          return [
                            td(
                              c,
                              <div className="flex flex-wrap gap-1">
                                {r.segments.slice(0, 3).map((s) => (
                                  <SegmentTag key={s.id} name={s.name} />
                                ))}
                                {r.segments.length > 3 && <span className="text-[11px] text-subtle">+{r.segments.length - 3}</span>}
                              </div>,
                              widths.segments,
                            ),
                          ];
                        case 'platforms':
                          return [td(c, <div className="flex flex-wrap gap-1">{r.platforms.map((p) => <PlatformBadge key={p.id} name={p.name} />)}</div>, widths.platforms)];
                        case 'updated':
                          return [td(c, <span className="text-muted">{relTime(t?.updatedAt ?? r.updatedAt)}</span>, widths.updated)];
                        case 'by':
                          return [td(c, <span className="text-muted">{t?.updatedBy ?? '—'}{t?.reviewedBy ? ` · ✓ ${t.reviewedBy}` : ''}</span>, widths.by)];
                      }
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {data && data.rows.length === 0 && !rows.isFetching && (
          <EmptyState icon={SearchX} title="No keys match" action={activeFilterCount || get('q') ? <Button onClick={() => (setSearch(''), set({ statuses: null, flags: null, segments: null, q: null }))}>Clear filters</Button> : undefined}>
            {platformId ? 'Try another platform or loosen the filters.' : 'Try loosening the filters.'}
          </EmptyState>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-1.5 text-[12px] text-subtle sm:px-5">
        <span className="hidden sm:inline">
          <span className="kbd">↑</span> <span className="kbd">↓</span> move · <span className="kbd">Enter</span> open · <span className="kbd">x</span> select
        </span>
        <label className="flex items-center gap-2">
          Rows
          <select
            className="input h-7 w-auto cursor-pointer py-0 text-[12px]"
            value={pageSize}
            onChange={(e) => {
              writePref('pageSize', Number(e.target.value));
              set({ size: e.target.value });
            }}
          >
            {[25, 50, 100, 200].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>

      {openKey && (
        <TranslationEditor
          keyId={openKey}
          languageIds={languageIds}
          activeLanguageId={openLang && languageIds.includes(openLang) ? openLang : languageIds[0]}
          onLanguageChange={(lid) => set({ editLang: lid }, true)}
          onClose={() => set({ key: null, editLang: null }, true)}
          onPrev={() => goRelative(-1)}
          onNext={() => goRelative(1)}
          hasPrev={idx > 0 || page > 1}
          hasNext={(idx >= 0 && idx < (data?.rows.length ?? 0) - 1) || page * pageSize < total}
          position={idx >= 0 ? (page - 1) * pageSize + idx + 1 : null}
          total={total}
        />
      )}
    </div>
  );
}

function HeaderCell({ children, width, onResize }: { children: React.ReactNode; width: number; onResize: (e: React.PointerEvent) => void }) {
  return (
    <th scope="col" className="relative h-9 select-none border-b border-line px-3 text-left text-[12px] font-medium text-muted" style={{ width, minWidth: width, maxWidth: width }}>
      <span className="block truncate">{children}</span>
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize column"
        onPointerDown={onResize}
        className="absolute right-0 top-1.5 h-6 w-1.5 cursor-col-resize rounded hover:bg-accent/60"
      />
    </th>
  );
}

function CellText({ text, empty, dir }: { text: string; empty: string; dir?: string }) {
  if (!text) return <span className="italic text-subtle">{empty}</span>;
  return (
    <span dir={dir === 'rtl' ? 'rtl' : undefined} className="line-clamp-3 whitespace-pre-wrap break-words text-fg">
      {text}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  const c = status === 'approved' ? 'bg-ok' : status === 'needs_review' ? 'bg-review' : status === 'in_progress' ? 'bg-warn' : status === 'draft' ? 'bg-muted' : 'border border-line-strong';
  return <span title={STATUS_LABELS[status as keyof typeof STATUS_LABELS]} className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', c)} />;
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-raised pl-2.5 pr-1 text-[12px]">
      {label}
      <button className="grid h-4 w-4 cursor-pointer place-items-center rounded-full text-subtle hover:bg-hover hover:text-fg" aria-label={`Remove filter ${label}`} onClick={onRemove}>
        <X size={11} aria-hidden />
      </button>
    </span>
  );
}

function FiltersPopover({
  statuses,
  flags,
  segmentIds,
  segments,
  onChange,
  count,
}: {
  statuses: string[];
  flags: string[];
  segmentIds: number[];
  segments: Segment[];
  onChange: (p: Record<string, string[]>) => void;
  count: number;
}) {
  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button icon={Filter}>
          Filters{count ? <span className="rounded bg-accent px-1.5 text-[11px] text-accent-fg">{count}</span> : null}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="anim-fade z-50 w-[320px] rounded-lg border border-line bg-raised p-4 shadow-pop">
          <div className="label mb-2">Status (selected language)</div>
          <div className="mb-4 grid grid-cols-2 gap-1.5">
            {STATUSES.map((s) => (
              <Checkbox key={s} label={STATUS_LABELS[s]} checked={statuses.includes(s)} onChange={() => onChange({ statuses: toggle(statuses, s) })} />
            ))}
          </div>
          <div className="label mb-2">Other</div>
          <div className="mb-4 flex flex-col gap-1.5">
            {Object.entries(FLAG_LABELS).map(([f, l]) => (
              <Checkbox key={f} label={l} checked={flags.includes(f)} onChange={() => onChange({ flags: toggle(flags, f) })} />
            ))}
          </div>
          <div className="label mb-2">Segments</div>
          <MultiSelect
            label="Segments"
            placeholder="Any segment"
            options={segments.filter((s) => s.keyCount > 0).map((s) => ({ value: s.id, label: s.name, hint: String(s.keyCount) }))}
            value={segmentIds}
            onChange={(v) => onChange({ segments: v.map(String) })}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ColumnsPopover({ hidden, onChange }: { hidden: ColumnId[]; onChange: (h: ColumnId[]) => void }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button icon={Columns3} aria-label="Columns">
          <span className="hidden xl:inline">Columns</span>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="anim-fade z-50 w-[220px] rounded-lg border border-line bg-raised p-3 shadow-pop">
          <div className="label mb-2">Visible columns</div>
          <div className="flex flex-col gap-1.5">
            {(Object.keys(COLUMN_LABELS) as ColumnId[])
              .filter((c) => c !== 'identifier' && c !== 'translation')
              .map((c) => (
                <Checkbox key={c} label={COLUMN_LABELS[c]} checked={!hidden.includes(c)} onChange={(v) => onChange(v ? hidden.filter((x) => x !== c) : [...hidden, c])} />
              ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
