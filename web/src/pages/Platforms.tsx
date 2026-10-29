import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Platform } from '../lib/api';
import { useSession } from '../lib/session';
import { Button, Checkbox, ErrorState, Field, Modal, PageHeader, pct, Progress, Select, Skeleton, errorMessage, useConfirm, useToast } from '../components/ui';

const KINDS = ['ios', 'android', 'web', 'document', 'other'];

export default function Platforms() {
  const { can, refresh } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [showArchived, setShowArchived] = useState(false);
  const list = useQuery({ queryKey: ['platforms', 'admin', showArchived], queryFn: () => api.get<Platform[]>(`/api/platforms?includeArchived=${showArchived}`) });
  const [edit, setEdit] = useState<Partial<Platform> | null>(null);
  const manage = can('manage_platforms');

  const save = async () => {
    if (!edit) return;
    try {
      const body = { name: edit.name, slug: edit.slug, description: edit.description ?? '', kind: edit.kind ?? 'other', sortOrder: edit.sortOrder ?? 100 };
      if (edit.id) await api.patch(`/api/platforms/${edit.id}`, body);
      else await api.post('/api/platforms', body);
      toast('ok', 'Platform saved');
      setEdit(null);
      qc.invalidateQueries({ queryKey: ['platforms'] });
      refresh();
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  const toggleArchive = async (p: Platform) => {
    if (!p.isArchived && !(await confirm({ title: `Archive ${p.name}?`, body: 'The platform disappears from workspaces and exports. Its keys and translations are kept, and keys shared with other platforms remain editable there.', confirmLabel: 'Archive', danger: true }))) return;
    try {
      await api.patch(`/api/platforms/${p.id}`, { isArchived: !p.isArchived });
      toast('ok', p.isArchived ? 'Restored' : 'Archived');
      qc.invalidateQueries({ queryKey: ['platforms'] });
      refresh();
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };

  return (
    <div className="mx-auto max-w-[1200px] p-4 sm:p-6">
      <PageHeader
        title="Platforms"
        description="Each platform is an app or document that uses translations. Keys can be shared across platforms."
        actions={
          <>
            {manage && <Checkbox label="Show archived" checked={showArchived} onChange={setShowArchived} />}
            {manage && (
              <Button variant="primary" icon={Plus} onClick={() => setEdit({ kind: 'other', sortOrder: 200 })}>
                New platform
              </Button>
            )}
          </>
        }
      />
      {list.isError ? (
        <ErrorState error={list.error} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.isLoading && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-36" />)}
          {list.data?.map((p) => {
            const slots = p.keyCount * p.languageCount;
            return (
              <article key={p.id} className={`card flex flex-col gap-3 p-4 ${p.isArchived ? 'opacity-60' : ''}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link to={`/workspace?platform=${p.id}`} className="font-medium hover:text-accent">
                      {p.name}
                    </Link>
                    <p className="font-mono text-[11px] text-subtle">
                      {p.slug} · {p.kind}
                      {p.isArchived && ' · archived'}
                    </p>
                  </div>
                  {manage && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" icon={Pencil} aria-label={`Edit ${p.name}`} onClick={() => setEdit(p)} />
                      <Button size="sm" variant="ghost" icon={p.isArchived ? ArchiveRestore : Archive} aria-label={p.isArchived ? `Restore ${p.name}` : `Archive ${p.name}`} onClick={() => toggleArchive(p)} />
                    </div>
                  )}
                </div>
                {p.description && <p className="line-clamp-2 text-[13px] text-muted">{p.description}</p>}
                <div className="mt-auto">
                  <div className="mb-1 flex justify-between text-[12px] text-muted">
                    <span>{p.keyCount.toLocaleString()} keys</span>
                    <span>
                      {pct(p.translated, slots)} translated · {pct(p.approved, slots)} approved
                    </span>
                  </div>
                  <Progress value={p.translated} total={slots} label={`${p.name} progress`} />
                </div>
                {p.hasLegacyLayout && <p className="text-[11px] text-subtle">Legacy worksheet layout stored for Excel exports</p>}
              </article>
            );
          })}
        </div>
      )}
      <Modal
        open={!!edit}
        onOpenChange={(o) => !o && setEdit(null)}
        title={edit?.id ? `Edit ${edit.name}` : 'New platform'}
        footer={
          <>
            <Button onClick={() => setEdit(null)}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={!edit?.name || !edit?.slug}>
              Save
            </Button>
          </>
        }
      >
        {edit && (
          <div className="flex flex-col gap-4">
            <Field label="Name" htmlFor="p-name">
              <input id="p-name" className="input" value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value, slug: edit.id ? edit.slug : e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') })} />
            </Field>
            <Field label="Slug" htmlFor="p-slug" hint="Short technical name used for platform-specific keys and in export folder names.">
              <input id="p-slug" className="input font-mono" value={edit.slug ?? ''} onChange={(e) => setEdit({ ...edit, slug: e.target.value })} />
            </Field>
            <Field label="Type" htmlFor="p-kind" hint="Determines the default export format suggestion.">
              <Select id="p-kind" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
                {KINDS.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </Select>
            </Field>
            <Field label="Description" htmlFor="p-desc">
              <textarea id="p-desc" className="input h-auto min-h-[70px] py-2" value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </Field>
            <Field label="Sort order" htmlFor="p-sort">
              <input id="p-sort" className="input w-28" inputMode="numeric" value={edit.sortOrder ?? 100} onChange={(e) => setEdit({ ...edit, sortOrder: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
