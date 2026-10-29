import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Segment } from '../lib/api';
import { useSession } from '../lib/session';
import { Button, EmptyState, ErrorState, Field, Modal, PageHeader, SearchInput, Skeleton, errorMessage, useConfirm, useDebounced, useToast } from '../components/ui';

export default function Segments() {
  const { can, me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const search = useDebounced(q);
  const list = useQuery({ queryKey: ['segments', search], queryFn: () => api.get<Segment[]>(`/api/segments?search=${encodeURIComponent(search)}`) });
  const [edit, setEdit] = useState<Partial<Segment> | null>(null);
  const manage = can('manage_segments');

  const save = async () => {
    if (!edit) return;
    try {
      if (edit.id) await api.patch(`/api/segments/${edit.id}`, { name: edit.name, description: edit.description ?? '' });
      else await api.post('/api/segments', { name: edit.name, description: edit.description ?? '' });
      toast('ok', 'Segment saved');
      setEdit(null);
      qc.invalidateQueries({ queryKey: ['segments'] });
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  const remove = async (s: Segment) => {
    if (!(await confirm({ title: `Delete segment “${s.name}”?`, body: `It is removed from ${s.keyCount} key(s). Keys and translations are not affected.`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/api/segments/${s.id}`);
      toast('ok', 'Segment deleted');
      qc.invalidateQueries({ queryKey: ['segments'] });
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  const canDelete = manage && (me.scope.allPlatforms || me.scope.role === 'super_admin');

  return (
    <div className="mx-auto max-w-[1000px] p-4 sm:p-6">
      <PageHeader
        title="Segments"
        description="Optional groupings (screens, pages, features) a key can belong to — none, one or several."
        actions={
          manage && (
            <Button variant="primary" icon={Plus} onClick={() => setEdit({})}>
              New segment
            </Button>
          )
        }
      />
      <SearchInput value={q} onChange={setQ} placeholder="Search segments" className="mb-4 max-w-sm" />
      {list.isError ? (
        <ErrorState error={list.error} />
      ) : list.isLoading ? (
        <Skeleton className="h-64" />
      ) : !list.data?.length ? (
        <EmptyState icon={Tags} title="No segments">Segments are created on import from Screen/Page/Path columns, or here.</EmptyState>
      ) : (
        <ul className="card divide-y divide-line">
          {list.data.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px]">{s.name}</p>
                {s.description && <p className="truncate text-[12px] text-subtle">{s.description}</p>}
              </div>
              <Link to={`/workspace?segments=${s.id}`} className="flex items-center gap-1 text-[12px] text-muted hover:text-accent">
                {s.keyCount.toLocaleString()} keys <ArrowUpRight size={12} aria-hidden />
              </Link>
              {manage && <Button size="sm" variant="ghost" icon={Pencil} aria-label={`Rename ${s.name}`} onClick={() => setEdit(s)} />}
              {canDelete && <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Delete ${s.name}`} onClick={() => remove(s)} />}
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={!!edit}
        onOpenChange={(o) => !o && setEdit(null)}
        title={edit?.id ? 'Edit segment' : 'New segment'}
        footer={
          <>
            <Button onClick={() => setEdit(null)}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={!edit?.name?.trim()}>
              Save
            </Button>
          </>
        }
      >
        {edit && (
          <div className="flex flex-col gap-4">
            <Field label="Name" htmlFor="s-name">
              <input id="s-name" className="input" value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label="Description" htmlFor="s-desc">
              <input id="s-desc" className="input" value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
