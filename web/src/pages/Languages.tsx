import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Language } from '../lib/api';
import { useSession } from '../lib/session';
import { canUseApiAccess } from '../../../shared/domain';
import { AutoTranslateDialog } from '../components/AutoTranslateDialog';
import { Button, Checkbox, ErrorState, Field, LanguageBadge, Modal, PageHeader, pct, Progress, Select, Skeleton, errorMessage, useToast } from '../components/ui';

interface Draft {
  id?: number;
  code: string;
  name: string;
  nativeName: string;
  direction: 'ltr' | 'rtl';
  isActive: boolean;
  sortOrder: number;
  aliases: string;
}

export default function Languages() {
  const { can, refresh, me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const manage = can('manage_languages');
  const canAi = canUseApiAccess(me.scope.role) && can('edit_translations');
  const [showArchived, setShowArchived] = useState(false);
  const list = useQuery({ queryKey: ['languages', 'admin', showArchived], queryFn: () => api.get<Language[]>(`/api/languages?includeArchived=${showArchived}`) });
  const [edit, setEdit] = useState<Draft | null>(null);
  const [autoAfterCreate, setAutoAfterCreate] = useState(true);
  const [aiTarget, setAiTarget] = useState<number | null>(null);

  const save = async () => {
    if (!edit) return;
    const aliases = edit.aliases.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    try {
      const body = { name: edit.name, nativeName: edit.nativeName, direction: edit.direction, isActive: edit.isActive, sortOrder: edit.sortOrder, aliases };
      let createdId: number | null = null;
      if (edit.id) await api.patch(`/api/languages/${edit.id}`, body);
      else createdId = (await api.post('/api/languages', { ...body, code: edit.code })).id;
      toast('ok', 'Language saved');
      setEdit(null);
      qc.invalidateQueries({ queryKey: ['languages'] });
      await refresh();
      // New language: offer Auto Translate straight away (preview first, nothing starts without confirmation).
      if (createdId && canAi && autoAfterCreate) setAiTarget(createdId);
    } catch (e: any) {
      toast('error', e.details?.[0]?.message ?? errorMessage(e));
    }
  };

  return (
    <div className="mx-auto max-w-[1200px] p-4 sm:p-6">
      <PageHeader
        title="Languages"
        description="Locales, writing direction and the legacy workbook labels that map to each language."
        actions={
          manage && (
            <>
              <Checkbox label="Show archived" checked={showArchived} onChange={setShowArchived} />
              <Button variant="primary" icon={Plus} onClick={() => setEdit({ code: '', name: '', nativeName: '', direction: 'ltr', isActive: true, sortOrder: 500, aliases: '' })}>
                Add language
              </Button>
            </>
          )
        }
      />
      {list.isError ? (
        <ErrorState error={list.error} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="px-4 py-2.5 font-medium">Language</th>
                <th className="px-4 py-2.5 font-medium">Native</th>
                <th className="px-4 py-2.5 font-medium">Legacy aliases</th>
                <th className="w-[220px] px-4 py-2.5 font-medium">Completion</th>
                {(manage || canAi) && <th className="w-24" />}
              </tr>
            </thead>
            <tbody>
              {list.isLoading &&
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={5} className="px-4 py-3">
                      <Skeleton className="h-4" />
                    </td>
                  </tr>
                ))}
              {list.data?.map((l) => (
                <tr key={l.id} className={`border-b border-line last:border-0 ${l.isActive ? '' : 'opacity-50'}`}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <LanguageBadge code={l.code} rtl={l.direction === 'rtl'} />
                      <span>{l.name}</span>
                      {l.isSource && <span className="rounded bg-accent/15 px-1.5 text-[11px] text-accent">source</span>}
                      {!l.isActive && <span className="text-[11px] text-subtle">archived</span>}
                    </div>
                    {l.note && <p className="mt-1 max-w-[420px] text-[12px] text-subtle">{l.note}</p>}
                  </td>
                  <td className="px-4 py-2.5" dir={l.direction}>
                    {l.nativeName}
                  </td>
                  <td className="px-4 py-2.5 text-[12px] text-muted">
                    {l.aliases
                      .filter((a) => a.alias !== l.code.toLowerCase())
                      .map((a) => a.alias)
                      .join(', ') || '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    {l.isSource ? (
                      <span className="text-[12px] text-subtle">{l.totalKeys.toLocaleString()} keys</span>
                    ) : (
                      <Link to={`/workspace?lang=${l.id}&statuses=missing`} className="flex flex-col gap-1 hover:text-accent">
                        <span className="flex justify-between text-[12px] text-muted">
                          <span>{pct(l.translated, l.totalKeys)} translated</span>
                          <span>{l.needsReview ? `${l.needsReview} to review` : `${pct(l.approved, l.totalKeys)} approved`}</span>
                        </span>
                        <Progress value={l.translated} total={l.totalKeys} label={`${l.name} completion`} />
                      </Link>
                    )}
                  </td>
                  {(manage || canAi) && (
                    <td className="whitespace-nowrap px-2 text-right">
                      {canAi && !l.isSource && l.isActive && (
                        <Button size="sm" variant="ghost" icon={Sparkles} aria-label={`Auto translate ${l.name}`} title="Auto translate" onClick={() => setAiTarget(l.id)} />
                      )}
                      {manage && <Button
                        size="sm"
                        variant="ghost"
                        icon={Pencil}
                        aria-label={`Edit ${l.name}`}
                        onClick={() =>
                          setEdit({ id: l.id, code: l.code, name: l.name, nativeName: l.nativeName, direction: l.direction, isActive: l.isActive, sortOrder: l.sortOrder, aliases: l.aliases.map((a) => a.alias).filter((a) => a !== l.code.toLowerCase()).join(', ') })
                        }
                      />}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal
        open={!!edit}
        onOpenChange={(o) => !o && setEdit(null)}
        title={edit?.id ? `Edit ${edit.name}` : 'Add language'}
        footer={
          <>
            <Button onClick={() => setEdit(null)}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={!edit?.code || !edit?.name}>
              Save
            </Button>
          </>
        }
      >
        {edit && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Locale code" htmlFor="l-code" hint="BCP-47, e.g. it, pt-BR, zh-Hant. Cannot change later.">
              <input id="l-code" className="input font-mono" disabled={!!edit.id} value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.trim() })} />
            </Field>
            <Field label="Direction" htmlFor="l-dir">
              <Select id="l-dir" value={edit.direction} onChange={(e) => setEdit({ ...edit, direction: e.target.value as 'ltr' | 'rtl' })}>
                <option value="ltr">Left to right</option>
                <option value="rtl">Right to left</option>
              </Select>
            </Field>
            <Field label="Display name" htmlFor="l-name">
              <input id="l-name" className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label="Native name" htmlFor="l-native">
              <input id="l-native" className="input" value={edit.nativeName} onChange={(e) => setEdit({ ...edit, nativeName: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Alternative codes and legacy labels" htmlFor="l-alias" hint="Comma separated. Workbook columns with these headers import into this language. A label can belong to only one language.">
                <textarea id="l-alias" className="input h-auto min-h-[64px] py-2" value={edit.aliases} onChange={(e) => setEdit({ ...edit, aliases: e.target.value })} />
              </Field>
            </div>
            <Checkbox label="Active" checked={edit.isActive} onChange={(v) => setEdit({ ...edit, isActive: v })} />
            {!edit.id && canAi && <Checkbox label="Auto translate after saving (you review the preview first)" checked={autoAfterCreate} onChange={setAutoAfterCreate} />}
          </div>
        )}
      </Modal>
      {aiTarget && <AutoTranslateDialog open onOpenChange={(o) => !o && setAiTarget(null)} targetLanguageId={aiTarget} onStarted={(id) => navigate(`/ai-translation/jobs/${id}`)} />}
    </div>
  );
}
