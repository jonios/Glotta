import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, FileUp, Loader2, Package, Play, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { IMPORT_STRATEGIES, IMPORT_STRATEGY_LABELS, MISSING_POLICIES, type ImportStrategy } from '../../../shared/domain';
import {
  Button,
  Checkbox,
  cx,
  EmptyState,
  ErrorState,
  Field,
  MultiSelect,
  PageHeader,
  Pagination,
  PermissionDenied,
  Progress,
  Segmented,
  Select,
  Skeleton,
  errorMessage,
  relTime,
  useConfirm,
  useToast,
} from '../components/ui';

export default function ImportExport() {
  const { can, isAdmin, me } = useSession();
  const fullScope = isAdmin || (me.scope.allLanguages && me.scope.allPlatforms);
  const canImport = can('import') && fullScope;
  if (!can('import') && !can('export')) return <PermissionDenied />;
  const tabs = [
    canImport && { to: 'import', label: 'Import Excel' },
    canImport && { to: 'conflicts', label: 'Conflicts' },
    can('export') && { to: 'excel', label: 'Export Excel' },
    can('export') && { to: 'resources', label: 'Localization files' },
    { to: 'history', label: 'History' },
  ].filter(Boolean) as { to: string; label: string }[];
  return (
    <div className="mx-auto max-w-[1200px] p-4 sm:p-6">
      <PageHeader title="Import / Export" description="Move translations between the system, the legacy Excel workbook and app resource files." />
      <nav className="mb-5 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line" aria-label="Import and export sections">
        {tabs.map((t) => (
          <NavLink key={t.to} to={`/import-export/${t.to}`} className={({ isActive }) => cx('h-9 shrink-0 border-b-2 px-3 pt-2 text-[13px]', isActive ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<Navigate to={`/import-export/${tabs[0].to}`} replace />} />
        <Route path="import" element={canImport ? <ImportWizard /> : <PermissionDenied message="Imports require the import capability and access to all languages and platforms." />} />
        <Route path="conflicts" element={canImport ? <Conflicts /> : <PermissionDenied />} />
        <Route path="excel" element={<ExcelExport />} />
        <Route path="resources" element={<ResourceExport />} />
        <Route path="history" element={<HistoryTab />} />
      </Routes>
    </div>
  );
}

// ======================================================================== import wizard
interface SheetAnalysis {
  name: string;
  format: string;
  deprecated: boolean;
  headerRow: number;
  guideText: string;
  codeRow: (string | null)[] | null;
  segmentHeader: string | null;
  rowCount: number;
  orphanRows: number;
  columns: { index: number; header: string; role: string; languageCode: string | null; primary: boolean; filled: number; detectedBy: string | null; unknownLanguage?: boolean }[];
  duplicateKeys: { key: string; rows: number[] }[];
  duplicateKeyCount: number;
  duplicateLanguageColumns: string[];
  blankCells: Record<string, number>;
  suggestedPlatformId: number | null;
  suggestedAction: 'import' | 'skip';
  suggestedNewPlatform: { name: string; slug: string; archived: boolean } | null;
  sample: { row: number; keyword: string; segment: string; values: Record<string, string> }[];
}
interface SheetChoice {
  name: string;
  action: 'import' | 'skip';
  target: string; // platform id or "new"
  createPlatform?: { name: string; slug: string; archived: boolean };
  columnOverrides: Record<string, string>;
}

function ImportWizard() {
  const { languages } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const platforms = useQuery({ queryKey: ['platforms', 'admin', true], queryFn: () => api.get(`/api/platforms?includeArchived=true`) });
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState<{ jobId: number; fileName: string; sheets: SheetAnalysis[] } | null>(null);
  const [choices, setChoices] = useState<SheetChoice[]>([]);
  const [strategy, setStrategy] = useState<ImportStrategy>('skip_existing');
  const [importedStatus, setImportedStatus] = useState<'approved' | 'needs_review' | 'draft'>('approved');
  const [report, setReport] = useState<any>(null);
  const [openSheet, setOpenSheet] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(xlsx|csv|tsv)$/i.test(file.name)) return toast('error', 'Choose an Excel workbook (.xlsx) or a CSV/TSV file');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.upload('/api/import/upload', fd);
      setUpload(r);
      setChoices(
        r.sheets.map((s: SheetAnalysis) => ({
          name: s.name,
          action: s.suggestedAction,
          target: s.suggestedPlatformId ? String(s.suggestedPlatformId) : 'new',
          createPlatform: s.suggestedNewPlatform ?? undefined,
          columnOverrides: {},
        })),
      );
      setStep(2);
    } catch (e) {
      toast('error', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const options = () => ({
    strategy,
    importedStatus,
    sheets: choices.map((c) => ({
      name: c.name,
      action: c.action,
      platformId: c.target !== 'new' ? Number(c.target) : undefined,
      createPlatform: c.target === 'new' ? c.createPlatform : undefined,
      columnOverrides: c.columnOverrides,
    })),
  });

  const dryRun = async () => {
    setBusy(true);
    try {
      setReport(await api.post(`/api/import/jobs/${upload!.jobId}/dry-run`, options()));
      setStep(3);
    } catch (e) {
      toast('error', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!(await confirm({ title: 'Run the import?', body: `Strategy: ${IMPORT_STRATEGY_LABELS[strategy]}. The import runs in a single transaction — it either fully applies or changes nothing.`, confirmLabel: 'Import now' }))) return;
    try {
      await api.post(`/api/import/jobs/${upload!.jobId}/run`, options());
      setRunning(true);
      setStep(4);
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  const job = useQuery({
    queryKey: ['import-job', upload?.jobId],
    queryFn: () => api.get(`/api/import/jobs/${upload!.jobId}`),
    enabled: running,
    refetchInterval: (q) => (['completed', 'failed'].includes(q.state.data?.status) ? false : 800),
  });
  useEffect(() => {
    if (job.data?.status === 'completed' || job.data?.status === 'failed') {
      setRunning(false);
      if (job.data.status === 'completed') {
        setReport(job.data.report);
        qc.invalidateQueries();
      }
    }
  }, [job.data?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const setChoice = (name: string, patch: Partial<SheetChoice>) => setChoices((cs) => cs.map((c) => (c.name === name ? { ...c, ...patch } : c)));
  const langOptions = languages.map((l) => ({ code: l.code, name: l.name }));

  return (
    <div>
      <ol className="mb-5 flex flex-wrap gap-2 text-[13px]" aria-label="Import steps">
        {['Upload', 'Map sheets & columns', 'Dry run', 'Import'].map((s, i) => (
          <li key={s} className={cx('flex items-center gap-2 rounded-full border px-3 py-1', step === i + 1 ? 'border-accent text-fg' : step > i + 1 ? 'border-line text-ok' : 'border-line text-subtle')} aria-current={step === i + 1 ? 'step' : undefined}>
            <span className="font-mono text-[11px]">{i + 1}</span> {s}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <label
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            onFile(e.dataTransfer.files[0]);
          }}
          className="card flex cursor-pointer flex-col items-center gap-3 border-dashed px-6 py-14 text-center hover:border-line-strong"
        >
          {busy ? <Loader2 className="animate-spin text-accent" aria-hidden /> : <Upload className="text-subtle" aria-hidden />}
          <span className="font-medium">{busy ? 'Reading file…' : 'Drop an Excel workbook (.xlsx) or a CSV file (.csv, .tsv) here, or click to choose'}</span>
          <span className="max-w-lg text-[13px] text-muted">
            Every worksheet is inspected: headers, language columns and aliases, duplicate keys and columns, blank cells and legacy rows. Nothing is written until you confirm.
          </span>
          <span className="max-w-lg text-[12px] text-subtle">
            CSV: UTF-8 (or UTF-16 with BOM), comma, semicolon or tab separated. First row: a <code className="font-mono">key</code> column, then one column per language
            (<code className="font-mono">en</code>, <code className="font-mono">fr</code>, <code className="font-mono">Persian</code>…); optional <code className="font-mono">segment</code> and{' '}
            <code className="font-mono">description</code>.
          </span>
          <input
            type="file"
            accept=".xlsx,.csv,.tsv,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            onChange={(e) => onFile(e.target.files?.[0])}
            disabled={busy}
          />
        </label>
      )}

      {step === 2 && upload && (
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-muted">
            <FileSpreadsheet size={14} className="mr-1 inline" aria-hidden /> {upload.fileName} · {upload.sheets.length} worksheets
          </p>
          {upload.sheets.map((s) => {
            const c = choices.find((x) => x.name === s.name)!;
            const langCols = s.columns.filter((col) => col.role === 'language' || col.role === 'unmapped');
            return (
              <section key={s.name} className={cx('card', c.action === 'skip' && 'opacity-60')}>
                <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-[180px] flex-1">
                    <p className="font-medium">
                      {s.name}
                      {s.deprecated && <span className="ml-2 rounded bg-warn/15 px-1.5 text-[11px] text-warn">deprecated</span>}
                      {s.format === 'normalized' && <span className="ml-2 rounded bg-info/15 px-1.5 text-[11px] text-info">normalized</span>}
                    </p>
                    <p className="text-[12px] text-subtle">
                      {s.rowCount} keyword rows · header row {s.headerRow}
                      {s.segmentHeader && ` · segments from “${s.segmentHeader}”`}
                      {s.codeRow && ' · locale-code row'}
                      {s.duplicateKeyCount > 0 && <span className="text-warn"> · {s.duplicateKeyCount} duplicate keys</span>}
                      {s.duplicateLanguageColumns.length > 0 && <span className="text-warn"> · duplicate columns: {s.duplicateLanguageColumns.join(', ')}</span>}
                      {s.orphanRows > 0 && <span> · {s.orphanRows} rows without keyword (preserved)</span>}
                    </p>
                  </div>
                  <Select aria-label={`Action for ${s.name}`} className="w-[120px]" value={c.action} onChange={(e) => setChoice(s.name, { action: e.target.value as 'import' | 'skip' })}>
                    <option value="import">Import</option>
                    <option value="skip">Skip</option>
                  </Select>
                  {s.format === 'legacy' && (
                    <Select aria-label={`Platform for ${s.name}`} className="w-[230px]" value={c.target} onChange={(e) => setChoice(s.name, { target: e.target.value })}>
                      {(platforms.data ?? []).map((p: any) => (
                        <option key={p.id} value={p.id}>
                          → {p.name}
                          {p.isArchived ? ' (archived)' : ''}
                        </option>
                      ))}
                      <option value="new">→ New platform…</option>
                    </Select>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setOpenSheet(openSheet === s.name ? null : s.name)} aria-expanded={openSheet === s.name}>
                    {openSheet === s.name ? 'Hide columns' : 'Columns'}
                  </Button>
                </div>
                {c.target === 'new' && c.action === 'import' && s.format === 'legacy' && (
                  <div className="flex flex-wrap items-end gap-3 border-t border-line px-4 py-3">
                    <Field label="New platform name">
                      <input className="input w-56" value={c.createPlatform?.name ?? ''} onChange={(e) => setChoice(s.name, { createPlatform: { ...c.createPlatform!, name: e.target.value } })} />
                    </Field>
                    <Field label="Slug">
                      <input className="input w-48 font-mono" value={c.createPlatform?.slug ?? ''} onChange={(e) => setChoice(s.name, { createPlatform: { ...c.createPlatform!, slug: e.target.value } })} />
                    </Field>
                    <Checkbox label="Archived" checked={!!c.createPlatform?.archived} onChange={(v) => setChoice(s.name, { createPlatform: { ...c.createPlatform!, archived: v } })} />
                  </div>
                )}
                {s.deprecated && <p className="border-t border-line px-4 py-2 text-[12px] text-muted">Deprecated sheet: imported into an archived platform so history is preserved without appearing in active workspaces. Choose Skip to leave it out.</p>}
                {openSheet === s.name && (
                  <div className="overflow-x-auto border-t border-line">
                    <table className="w-full min-w-[640px] text-[12px]">
                      <thead>
                        <tr className="text-left text-muted">
                          <th className="px-4 py-2 font-medium">#</th>
                          <th className="px-4 py-2 font-medium">Header</th>
                          <th className="px-4 py-2 font-medium">Maps to</th>
                          <th className="px-4 py-2 font-medium">Filled</th>
                          <th className="px-4 py-2 font-medium">Blank</th>
                          <th className="px-4 py-2 font-medium">Note</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.columns
                          .filter((col) => col.role !== 'ignored' || col.header)
                          .map((col) => {
                            const override = c.columnOverrides[col.index];
                            const current = override ?? (col.role === 'language' ? col.languageCode ?? '' : col.role === 'unmapped' ? '' : col.role);
                            return (
                              <tr key={col.index} className="border-t border-line">
                                <td className="px-4 py-1.5 font-mono text-subtle">{col.index + 1}</td>
                                <td className="px-4 py-1.5">{col.header || <span className="italic text-subtle">(blank header)</span>}</td>
                                <td className="px-4 py-1.5">
                                  {langCols.includes(col) ? (
                                    <select
                                      className="input h-7 w-[200px] cursor-pointer py-0 text-[12px]"
                                      aria-label={`Mapping for column ${col.index + 1}`}
                                      value={current === 'ignore' ? 'ignore' : current}
                                      onChange={(e) => setChoice(s.name, { columnOverrides: { ...c.columnOverrides, [col.index]: e.target.value || 'ignore' } })}
                                    >
                                      <option value="ignore">— ignore (preserve raw) —</option>
                                      {langOptions.map((l) => (
                                        <option key={l.code} value={l.code}>
                                          {l.name} ({l.code})
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <span className="text-muted">{col.role}</span>
                                  )}
                                </td>
                                <td className="px-4 py-1.5 tabular-nums">{col.filled}</td>
                                <td className="px-4 py-1.5 tabular-nums">{col.languageCode && col.primary ? s.blankCells[col.languageCode] ?? '' : ''}</td>
                                <td className="px-4 py-1.5 text-subtle">
                                  {col.role === 'language' && !col.primary && 'alternate column (values preserved, differences become conflicts)'}
                                  {col.detectedBy === 'override' && 'mapped from verified content'}
                                  {col.role === 'unmapped' && !override && <span className="text-warn">unrecognised — map it or it is preserved raw</span>}
                                  {col.unknownLanguage && <span className="text-warn">language not configured</span>}
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                    {s.duplicateKeys.length > 0 && (
                      <p className="border-t border-line px-4 py-2 text-[12px] text-muted">
                        Duplicate keys: {s.duplicateKeys.slice(0, 12).map((d) => `${d.key} (rows ${d.rows.join(', ')})`).join('; ')}
                        {s.duplicateKeyCount > 12 && ` … +${s.duplicateKeyCount - 12} more`}
                      </p>
                    )}
                  </div>
                )}
              </section>
            );
          })}
          <section className="card p-4">
            <p className="label mb-3">When a value already exists</p>
            <div className="flex flex-col gap-2">
              {IMPORT_STRATEGIES.map((s) => (
                <label key={s} className="flex cursor-pointer items-start gap-2 text-[14px]">
                  <input type="radio" name="strategy" className="mt-1 accent-[rgb(var(--accent))]" checked={strategy === s} onChange={() => setStrategy(s)} />
                  <span>{IMPORT_STRATEGY_LABELS[s]}</span>
                </label>
              ))}
            </div>
            <div className="mt-4 max-w-xs">
              <Field label="Status for imported translations" hint="Existing workbook values are usually live in production.">
                <Select value={importedStatus} onChange={(e) => setImportedStatus(e.target.value as any)}>
                  <option value="approved">Approved</option>
                  <option value="needs_review">Needs review</option>
                  <option value="draft">Draft</option>
                </Select>
              </Field>
            </div>
          </section>
          <div className="flex gap-2">
            <Button onClick={() => (setStep(1), setUpload(null))}>Start over</Button>
            <Button variant="primary" icon={Play} loading={busy} onClick={dryRun}>
              Run dry run
            </Button>
          </div>
        </div>
      )}

      {(step === 3 || step === 4) && (
        <div className="flex flex-col gap-4">
          {step === 4 && running && (
            <div className="card p-4" role="status">
              <p className="mb-2 flex items-center gap-2 text-[14px]">
                <Loader2 size={15} className="animate-spin text-accent" aria-hidden /> Importing…
              </p>
              <Progress value={job.data?.progress?.done ?? 0} total={job.data?.progress?.total ?? 1} label="Import progress" />
            </div>
          )}
          {step === 4 && job.data?.status === 'failed' && (
            <div role="alert" className="card border-danger/40 p-4 text-danger">
              <AlertTriangle size={15} className="mr-1 inline" aria-hidden /> Import failed and was rolled back: {job.data.error}
            </div>
          )}
          {report && <ImportReport report={report} />}
          <div className="flex gap-2">
            {step === 3 && (
              <>
                <Button onClick={() => setStep(2)}>Back to mapping</Button>
                <Button variant="primary" icon={FileUp} onClick={run}>
                  Import for real
                </Button>
              </>
            )}
            {step === 4 && !running && (
              <>
                <Button onClick={() => (setStep(1), setUpload(null), setReport(null))}>Import another file</Button>
                {report?.summary?.conflicts > 0 && (
                  <NavLink to="/import-export/conflicts" className="inline-flex h-9 items-center rounded border border-line px-3.5 text-[14px] hover:bg-hover">
                    Review {report.summary.conflicts} conflicts
                  </NavLink>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ImportReport({ report }: { report: any }) {
  const s = report.summary;
  const stats: [string, number, string?][] = [
    ['Keys created', s.keysCreated],
    ['Shared with existing key', s.keysShared],
    ['Matched existing', s.keysMatched],
    ['Translations added', s.translationsAdded, 'text-ok'],
    ['Translations updated', s.translationsUpdated, s.translationsUpdated ? 'text-warn' : undefined],
    ['Unchanged', s.translationsUnchanged],
    ['Existing kept (not overwritten)', s.existingKept],
    ['Conflicts to resolve', s.conflicts, s.conflicts ? 'text-warn' : undefined],
    ['Duplicate rows merged', s.duplicateRows],
    ['Blank cells (left empty)', s.blankCells],
    ['Alternate column values preserved', s.alternateValues],
    ['Raw cells preserved', s.preservedLegacyCells],
    ['Excel error cells', s.excelErrors],
    ['New segments', s.newSegments],
  ];
  return (
    <section className="card">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        {report.dryRun ? <AlertTriangle size={16} className="text-info" aria-hidden /> : <CheckCircle2 size={16} className="text-ok" aria-hidden />}
        <h2 className="font-medium">{report.dryRun ? 'Dry run — nothing was written' : 'Import completed'}</h2>
      </div>
      <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4 lg:grid-cols-7">
        {stats.map(([label, n, tone]) => (
          <div key={label} className="bg-surface px-4 py-3">
            <dt className="text-[11px] text-subtle">{label}</dt>
            <dd className={cx('text-[18px] font-semibold tabular-nums', tone)}>{(n ?? 0).toLocaleString()}</dd>
          </div>
        ))}
      </dl>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[12px]">
          <thead>
            <tr className="border-t border-line text-left text-muted">
              {['Sheet', 'Platform', 'Rows', 'Created', 'Shared', 'Matched', 'Added', 'Updated', 'Conflicts', 'Dup rows'].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.sheets.map((r: any) => (
              <tr key={r.sheet} className={cx('border-t border-line', r.skipped && 'text-subtle')}>
                <td className="px-3 py-1.5">{r.sheet}</td>
                <td className="px-3 py-1.5">{r.skipped ? 'skipped' : r.platform}</td>
                {[r.rows, r.keysCreated, r.keysShared, r.keysMatched, r.translationsAdded, r.translationsUpdated, r.conflicts, r.duplicateRows].map((n, i) => (
                  <td key={i} className="px-3 py-1.5 tabular-nums">
                    {n}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.samples?.length > 0 && (
        <details className="border-t border-line px-4 py-3 text-[12px]">
          <summary className="cursor-pointer text-muted">Examples ({report.samples.length})</summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {report.samples.slice(0, 60).map((x: any, i: number) => (
              <li key={i} className="grid grid-cols-[110px_1fr] gap-2">
                <span className="text-subtle">{x.kind.replace('_', ' ')}</span>
                <span>
                  {x.sheet} r{x.row} <span className="font-mono">{x.key}</span> {x.language && <span className="font-mono text-accent">{x.language}</span>}
                  {x.incoming !== undefined && (
                    <>
                      : “{x.current}” → “{x.incoming}”
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// ========================================================================== conflicts
function Conflicts() {
  const toast = useToast();
  const qc = useQueryClient();
  const { languages } = useSession();
  const [kind, setKind] = useState('');
  const [lang, setLang] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['conflicts', kind, lang, page],
    queryFn: () => api.get(`/api/conflicts?status=open&page=${page}${kind ? `&kind=${kind}` : ''}${lang ? `&languageId=${lang}` : ''}`),
  });
  const resolve = async (id: number, resolution: string) => {
    try {
      await api.post(`/api/conflicts/${id}/resolve`, { resolution });
      qc.invalidateQueries({ queryKey: ['conflicts'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select aria-label="Conflict type" className="w-[220px]" value={kind} onChange={(e) => (setKind(e.target.value), setPage(1))}>
          <option value="">All conflict types</option>
          <option value="duplicate_column">Duplicate language column</option>
          <option value="duplicate_row">Duplicate key row</option>
          <option value="value_mismatch">Workbook differs from system</option>
          <option value="source_mismatch">Source text differs</option>
        </Select>
        <Select aria-label="Language" className="w-[200px]" value={lang} onChange={(e) => (setLang(e.target.value), setPage(1))}>
          <option value="">All languages</option>
          {languages.filter((l) => !l.isSource).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        {q.data && <div className="ml-auto"><Pagination page={page} pageSize={100} total={q.data.total} onPage={setPage} /></div>}
      </div>
      {q.isError ? (
        <ErrorState error={q.error} />
      ) : q.isLoading ? (
        <Skeleton className="h-64" />
      ) : !q.data.rows.length ? (
        <EmptyState icon={CheckCircle2} title="No open conflicts">Conflicts from imports appear here until someone decides which value to keep.</EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[900px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="px-3 py-2 font-medium">Key</th>
                <th className="px-3 py-2 font-medium">Where</th>
                <th className="px-3 py-2 font-medium">Current value</th>
                <th className="px-3 py-2 font-medium">Workbook value</th>
                <th className="w-[230px]" />
              </tr>
            </thead>
            <tbody>
              {q.data.rows.map((c: any) => (
                <tr key={c.id} className="border-b border-line align-top last:border-0">
                  <td className="px-3 py-2">
                    <NavLink to={`/workspace?key=${c.keyId}&q=${encodeURIComponent(c.identifier ?? '')}${c.languageId ? `&lang=${c.languageId}` : ''}`} className="font-mono text-[12px] text-accent hover:underline">
                      {c.identifier}
                    </NavLink>
                    <p className="text-[11px] text-subtle">{c.languageCode ?? 'source'} · {c.kind.replace('_', ' ')}</p>
                  </td>
                  <td className="px-3 py-2 text-[12px] text-muted">
                    {c.sheet} r{c.row}
                    <br />“{c.header}”
                  </td>
                  <td className="max-w-[260px] whitespace-pre-wrap px-3 py-2">{c.currentValue || '—'}</td>
                  <td className="max-w-[260px] whitespace-pre-wrap px-3 py-2">{c.incomingValue}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" onClick={() => resolve(c.id, 'kept_current')}>
                        Keep current
                      </Button>
                      <Button size="sm" onClick={() => resolve(c.id, 'used_incoming')}>
                        Use workbook
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => resolve(c.id, 'dismissed')}>
                        Dismiss
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ======================================================================= export shared
function useExportSelection() {
  const { platforms, targetLanguages, can } = useSession();
  const [platformIds, setPlatformIds] = useState<number[]>([]);
  const [languageIds, setLanguageIds] = useState<number[]>([]);
  const [segmentIds, setSegmentIds] = useState<number[]>([]);
  const [includeSource, setIncludeSource] = useState(can('view_source'));
  const segments = useQuery({ queryKey: ['segments'], queryFn: () => api.get('/api/segments'), staleTime: 60_000 });
  const ui = (
    <div className="grid gap-4 md:grid-cols-3">
      <Field label="Platforms" hint="Leave empty for all of your platforms.">
        <MultiSelect label="Platforms" placeholder="All my platforms" options={platforms.map((p) => ({ value: p.id, label: p.name }))} value={platformIds} onChange={setPlatformIds} />
      </Field>
      <Field label="Languages" hint="Leave empty for all of your languages.">
        <MultiSelect label="Languages" placeholder="All my languages" options={targetLanguages.map((l) => ({ value: l.id, label: l.name, hint: l.code }))} value={languageIds} onChange={setLanguageIds} />
      </Field>
      <Field label="Segments" hint="Optional: only keys in these segments.">
        <MultiSelect label="Segments" placeholder="All segments" options={(segments.data ?? []).filter((s: any) => s.keyCount).map((s: any) => ({ value: s.id, label: s.name }))} value={segmentIds} onChange={setSegmentIds} />
      </Field>
      {can('view_source') && <Checkbox label="Include English source" checked={includeSource} onChange={setIncludeSource} />}
    </div>
  );
  return {
    ui,
    selection: { platformIds: platformIds.length ? platformIds : undefined, languageIds: languageIds.length ? languageIds : undefined, segmentIds: segmentIds.length ? segmentIds : undefined, includeSource },
  };
}

function ExcelExport() {
  const toast = useToast();
  const { isAdmin } = useSession();
  const { ui, selection } = useExportSelection();
  const [layout, setLayout] = useState<'legacy' | 'normalized'>('legacy');
  const [includeStatus, setIncludeStatus] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.download('/api/export/excel', { ...selection, layout, includeStatus, includeArchived });
      toast('ok', `Downloaded ${r.fileName}`);
    } catch (e) {
      toast('error', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card flex flex-col gap-5 p-5">
      <Segmented
        label="Layout"
        value={layout}
        onChange={setLayout}
        options={[
          { value: 'legacy', label: 'Legacy workbook (customers)' },
          { value: 'normalized', label: 'Normalized (re-importable)' },
        ]}
      />
      <p className="-mt-2 text-[13px] text-muted">
        {layout === 'legacy'
          ? 'One sheet per platform with the original column names, order, guide and locale-code rows — the format customers already use in Google Drive. Only languages you can access are included.'
          : 'One row per key with Keyword, Platforms, Segments, Description and one column per locale code. Shared keys appear once. Can be edited and imported back.'}
      </p>
      {ui}
      <div className="flex flex-wrap gap-4">
        {layout === 'normalized' && <Checkbox label="Include status columns" checked={includeStatus} onChange={setIncludeStatus} />}
        {isAdmin && <Checkbox label="Include archived platforms" checked={includeArchived} onChange={setIncludeArchived} />}
      </div>
      <div>
        <Button variant="primary" icon={Download} loading={busy} onClick={go}>
          Download .xlsx
        </Button>
      </div>
    </div>
  );
}

function ResourceExport() {
  const toast = useToast();
  const { ui, selection } = useExportSelection();
  const formats = useQuery({ queryKey: ['formats'], queryFn: () => api.get('/api/export/formats'), staleTime: Infinity });
  const [format, setFormat] = useState('json');
  const [nested, setNested] = useState(false);
  const [missing, setMissing] = useState<(typeof MISSING_POLICIES)[number]>('skip');
  const [include, setInclude] = useState<'any' | 'reviewed' | 'approved'>('any');
  const [zip, setZip] = useState(true);
  const [busy, setBusy] = useState(false);
  const fmt = formats.data?.find((f: any) => f.id === format);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.download('/api/export/resources', { ...selection, format, nested, missing, include, zip });
      toast(r.warnings ? 'info' : 'ok', `Downloaded ${r.fileName}${r.warnings ? ` · ${r.warnings} warning(s) in EXPORT-WARNINGS.txt` : ''}`);
    } catch (e) {
      toast('error', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card flex flex-col gap-5 p-5">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {formats.isLoading && Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-[84px]" />)}
        {(formats.data ?? []).map((f: any) => (
          <button
            key={f.id}
            onClick={() => setFormat(f.id)}
            aria-pressed={format === f.id}
            className={cx('flex cursor-pointer flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors', format === f.id ? 'border-accent bg-accent/[0.06]' : 'border-line hover:border-line-strong')}
          >
            <span className="flex items-center gap-1.5 text-[14px] font-medium">
              <Package size={14} aria-hidden /> {f.label}
            </span>
            <span className="text-[12px] text-muted">{f.description}</span>
          </button>
        ))}
      </div>
      {ui}
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Missing translations" hint="English is only used when you choose the fallback.">
          <Select value={missing} onChange={(e) => setMissing(e.target.value as any)}>
            <option value="skip">Leave the key out</option>
            <option value="empty">Write an empty string</option>
            <option value="fallback_source">Fall back to English</option>
          </Select>
        </Field>
        <Field label="Include translations">
          <Select value={include} onChange={(e) => setInclude(e.target.value as any)}>
            <option value="any">Any non-empty (incl. drafts)</option>
            <option value="reviewed">Submitted or approved</option>
            <option value="approved">Approved only</option>
          </Select>
        </Field>
        <div className="flex flex-col justify-end gap-2">
          {fmt?.supportsNested && <Checkbox label='Nested JSON (split keys on ".")' checked={nested} onChange={setNested} />}
          <Checkbox label="Always package as ZIP" checked={zip} onChange={setZip} />
        </div>
      </div>
      <div>
        <Button variant="primary" icon={Download} loading={busy} onClick={go}>
          Export {fmt?.label ?? ''}
        </Button>
      </div>
    </div>
  );
}

function HistoryTab() {
  const { can, isAdmin, me } = useSession();
  const canImport = can('import') && (isAdmin || (me.scope.allLanguages && me.scope.allPlatforms));
  const imports = useQuery({ queryKey: ['import-jobs'], queryFn: () => api.get('/api/import/jobs'), enabled: canImport });
  const exports = useQuery({ queryKey: ['export-jobs'], queryFn: () => api.get('/api/export/jobs'), enabled: can('export') });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {canImport && (
        <section className="card">
          <h2 className="border-b border-line px-4 py-3 font-medium">Imports</h2>
          <ul className="divide-y divide-line text-[13px]">
            {(imports.data ?? []).map((j: any) => (
              <li key={j.id} className="px-4 py-2.5">
                <div className="flex justify-between">
                  <span className="truncate">{j.fileName}</span>
                  <span className={cx('text-[12px]', j.status === 'completed' ? 'text-ok' : j.status === 'failed' ? 'text-danger' : 'text-subtle')}>{j.status.replace('_', ' ')}</span>
                </div>
                <p className="text-[12px] text-subtle">
                  #{j.id} · {j.createdBy} · {relTime(j.createdAt)}
                  {j.summary && ` · ${j.summary.keysCreated} keys, ${j.summary.translationsAdded} added, ${j.summary.translationsUpdated} updated`}
                  {j.openConflicts > 0 && ` · ${j.openConflicts} open conflicts`}
                </p>
              </li>
            ))}
            {imports.isLoading && <li className="p-4"><Skeleton className="h-10" /></li>}
            {imports.data?.length === 0 && <li className="px-4 py-6 text-subtle">No imports yet.</li>}
          </ul>
        </section>
      )}
      {can('export') && (
        <section className="card">
          <h2 className="border-b border-line px-4 py-3 font-medium">Exports</h2>
          <ul className="divide-y divide-line text-[13px]">
            {(exports.data ?? []).map((j: any) => (
              <li key={j.id} className="px-4 py-2.5">
                <div className="flex justify-between">
                  <span className="truncate">{j.fileName}</span>
                  <span className="text-[12px] text-subtle">{j.kind.replace('_', ' ')} · {j.format}</span>
                </div>
                <p className="text-[12px] text-subtle">
                  {j.createdBy} · {relTime(j.createdAt)} · {j.entryCount.toLocaleString()} entries{j.warnings ? ` · ${j.warnings} warnings` : ''}
                </p>
              </li>
            ))}
            {exports.isLoading && <li className="p-4"><Skeleton className="h-10" /></li>}
            {exports.data?.length === 0 && <li className="px-4 py-6 text-subtle">No exports yet.</li>}
          </ul>
        </section>
      )}
    </div>
  );
}
