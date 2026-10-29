import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, History, KeyRound, Pencil, Power, UserPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { CAPABILITY_LABELS, ROLE_DEFAULT_CAPABILITIES, ROLE_LABELS, ROLES, type Capability, type Role } from '../../../shared/domain';
import {
  Button,
  Checkbox,
  cx,
  ErrorState,
  Field,
  LanguageBadge,
  Modal,
  MultiSelect,
  PageHeader,
  PermissionDenied,
  PlatformBadge,
  SearchInput,
  Segmented,
  Select,
  Skeleton,
  errorMessage,
  relTime,
  useConfirm,
  useToast,
} from '../components/ui';

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  allLanguages: boolean;
  allPlatforms: boolean;
  lastLoginAt: string | null;
  invitePending: boolean;
  capabilities: Capability[];
  languageIds: number[];
  platformIds: number[];
}

interface Draft {
  id?: number;
  email: string;
  name: string;
  role: Role;
  capabilities: Capability[];
  allLanguages: boolean;
  languageIds: number[];
  allPlatforms: boolean;
  platformIds: number[];
}

const CAP_GROUPS: { label: string; caps: Capability[] }[] = [
  { label: 'Content', caps: ['view', 'view_source', 'edit_translations', 'edit_source'] },
  { label: 'Workflow', caps: ['review', 'approve'] },
  { label: 'Structure', caps: ['manage_keys', 'manage_segments', 'manage_platforms', 'manage_languages'] },
  { label: 'Data', caps: ['import', 'export'] },
  { label: 'Administration', caps: ['manage_users', 'view_audit', 'manage_settings'] },
];
const SENSITIVE: Capability[] = ['manage_users', 'manage_settings', 'import', 'edit_source', 'manage_platforms', 'manage_languages'];

export default function Users() {
  const { can, me, languages, platforms, isAdmin } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserRow[]>('/api/users'), enabled: isAdmin });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [invite, setInvite] = useState<{ url: string; name: string } | null>(null);
  const [activityFor, setActivityFor] = useState<UserRow | null>(null);
  const allPlatforms = useQuery({ queryKey: ['platforms', 'admin', true], queryFn: () => api.get(`/api/platforms?includeArchived=true`) });
  const platformList = (allPlatforms.data ?? platforms) as { id: number; name: string; isArchived?: boolean }[];
  const targetLangs = languages.filter((l) => !l.isSource);
  // User management (including invitations) is reserved for Super Admins.
  if (!isAdmin) return <PermissionDenied />;

  const filtered = (users.data ?? []).filter((u) => !q || `${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase()));
  const langCode = (id: number) => languages.find((l) => l.id === id);
  const platName = (id: number) => platformList.find((p) => p.id === id)?.name ?? `#${id}`;

  const save = async () => {
    if (!draft) return;
    const escalates = draft.capabilities.some((c) => SENSITIVE.includes(c)) || draft.role === 'super_admin';
    if (escalates && !(await confirm({ title: 'Grant sensitive permissions?', body: `${draft.name || draft.email} will be able to: ${draft.role === 'super_admin' ? 'do everything (Super Admin)' : draft.capabilities.filter((c) => SENSITIVE.includes(c)).map((c) => CAPABILITY_LABELS[c]).join(', ')}.`, confirmLabel: 'Grant' }))) return;
    try {
      const body = { name: draft.name, role: draft.role, capabilities: draft.capabilities, allLanguages: draft.allLanguages, languageIds: draft.languageIds, allPlatforms: draft.allPlatforms, platformIds: draft.platformIds };
      if (draft.id) {
        await api.patch(`/api/users/${draft.id}`, body);
        toast('ok', 'Permissions updated');
      } else {
        const r = await api.post('/api/users', { ...body, email: draft.email });
        setInvite({ url: r.inviteUrl, name: draft.name });
      }
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e: any) {
      toast('error', e.details?.[0] ? `${e.details[0].path}: ${e.details[0].message}` : errorMessage(e));
    }
  };
  const setActive = async (u: UserRow, isActive: boolean) => {
    if (!isActive && !(await confirm({ title: `Deactivate ${u.name}?`, body: 'They are signed out immediately and cannot sign in until reactivated. Their history is kept.', confirmLabel: 'Deactivate', danger: true }))) return;
    try {
      await api.post(`/api/users/${u.id}/status`, { isActive });
      toast('ok', isActive ? 'Activated' : 'Deactivated');
      qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  const resetAccess = async (u: UserRow) => {
    if (!(await confirm({ title: `Reset access for ${u.name}?`, body: 'Their password is removed and all sessions end. You get a new link they use to set a password.', confirmLabel: 'Reset', danger: true }))) return;
    try {
      const r = await api.post(`/api/users/${u.id}/reset-access`);
      setInvite({ url: r.inviteUrl, name: u.name });
      qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };

  return (
    <div className="mx-auto max-w-[1200px] p-4 sm:p-6">
      <PageHeader
        title="Users & Permissions"
        description="Access is the combination of languages × platforms × capabilities, enforced on the server."
        actions={
          <Button
            variant="primary"
            icon={UserPlus}
            onClick={() => setDraft({ email: '', name: '', role: 'translator', capabilities: ROLE_DEFAULT_CAPABILITIES.translator, allLanguages: false, languageIds: [], allPlatforms: false, platformIds: [] })}
          >
            Invite user
          </Button>
        }
      />
      <SearchInput value={q} onChange={setQ} placeholder="Search users" className="mb-4 max-w-sm" />
      {users.isError ? (
        <ErrorState error={users.error} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[900px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="px-4 py-2.5 font-medium">User</th>
                <th className="px-4 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 font-medium">Languages</th>
                <th className="px-4 py-2.5 font-medium">Platforms</th>
                <th className="px-4 py-2.5 font-medium">Last sign-in</th>
                <th className="w-40" />
              </tr>
            </thead>
            <tbody>
              {users.isLoading && (
                <tr>
                  <td colSpan={6} className="p-4">
                    <Skeleton className="h-24" />
                  </td>
                </tr>
              )}
              {filtered.map((u) => (
                <tr key={u.id} className={cx('border-b border-line align-top last:border-0', !u.isActive && 'opacity-50')}>
                  <td className="px-4 py-3">
                    <p className="font-medium">{u.name}</p>
                    <p className="text-[12px] text-subtle">{u.email}</p>
                    {!u.isActive && <p className="text-[11px] text-danger">deactivated</p>}
                    {u.invitePending && u.isActive && <p className="text-[11px] text-warn">invitation pending</p>}
                  </td>
                  <td className="px-4 py-3">
                    {ROLE_LABELS[u.role]}
                    <p className="text-[11px] text-subtle">{u.role === 'super_admin' ? 'all capabilities' : `${u.capabilities.length} capabilities`}</p>
                  </td>
                  <td className="px-4 py-3">
                    {u.allLanguages ? (
                      <span className="text-muted">All languages</span>
                    ) : (
                      <div className="flex max-w-[220px] flex-wrap gap-1">
                        {u.languageIds.map((id) => {
                          const l = langCode(id);
                          return l ? <LanguageBadge key={id} code={l.code} /> : null;
                        })}
                        {!u.languageIds.length && <span className="text-danger">none</span>}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {u.allPlatforms ? (
                      <span className="text-muted">All platforms</span>
                    ) : (
                      <div className="flex max-w-[260px] flex-wrap gap-1">
                        {u.platformIds.map((id) => (
                          <PlatformBadge key={id} name={platName(id)} />
                        ))}
                        {!u.platformIds.length && <span className="text-danger">none</span>}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted">{relTime(u.lastLoginAt)}</td>
                  <td className="px-2 py-2">
                    <div className="flex justify-end gap-0.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Pencil}
                        aria-label={`Edit permissions of ${u.name}`}
                        onClick={() => setDraft({ id: u.id, email: u.email, name: u.name, role: u.role, capabilities: u.capabilities, allLanguages: u.allLanguages, languageIds: u.languageIds, allPlatforms: u.allPlatforms, platformIds: u.platformIds })}
                      />
                      <Button size="sm" variant="ghost" icon={History} aria-label={`Activity of ${u.name}`} onClick={() => setActivityFor(u)} />
                      {u.id !== me.user.id && <Button size="sm" variant="ghost" icon={KeyRound} aria-label={`Reset access for ${u.name}`} onClick={() => resetAccess(u)} />}
                      {u.id !== me.user.id && <Button size="sm" variant="ghost" icon={Power} aria-label={u.isActive ? `Deactivate ${u.name}` : `Activate ${u.name}`} onClick={() => setActive(u, !u.isActive)} />}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {draft && (
        <PermissionEditor
          draft={draft}
          setDraft={setDraft}
          onSave={save}
          languages={targetLangs.map((l) => ({ value: l.id, label: l.name, hint: l.code }))}
          platforms={platformList.map((p) => ({ value: p.id, label: p.name, group: p.isArchived ? 'Archived' : 'Active' }))}
        />
      )}

      <Modal open={!!invite} onOpenChange={(o) => !o && setInvite(null)} title="Share the invitation link" description={`Send this link to ${invite?.name} through a secure channel. It works once and expires in 7 days.`} footer={<Button onClick={() => setInvite(null)}>Done</Button>}>
        <div className="flex gap-2">
          <input readOnly className="input font-mono text-[12px]" value={invite?.url ?? ''} onFocus={(e) => e.target.select()} aria-label="Invitation link" />
          <Button icon={Copy} onClick={() => navigator.clipboard.writeText(invite?.url ?? '').then(() => toast('ok', 'Link copied'))}>
            Copy
          </Button>
        </div>
        <p className="mt-3 text-[12px] text-subtle">Email delivery is not configured, so links are shown here instead of being sent automatically.</p>
      </Modal>

      <ActivityModal user={activityFor} onClose={() => setActivityFor(null)} />
    </div>
  );
}

function PermissionEditor({
  draft,
  setDraft,
  onSave,
  languages,
  platforms,
}: {
  draft: Draft;
  setDraft: (d: Draft | null) => void;
  onSave: () => void;
  languages: { value: number; label: string; hint: string }[];
  platforms: { value: number; label: string; group: string }[];
}) {
  const { can, isAdmin } = useSession();
  const set = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  const toggle = (c: Capability) => set({ capabilities: draft.capabilities.includes(c) ? draft.capabilities.filter((x) => x !== c) : [...draft.capabilities, c] });
  const isSuper = draft.role === 'super_admin';
  const summary = useMemo(() => {
    const langs = isSuper || draft.allLanguages ? 'all languages' : draft.languageIds.map((id) => languages.find((l) => l.value === id)?.label).filter(Boolean).join(', ') || 'no languages';
    const plats = isSuper || draft.allPlatforms ? 'all platforms' : draft.platformIds.map((id) => platforms.find((p) => p.value === id)?.label).filter(Boolean).join(', ') || 'no platforms';
    const caps = isSuper ? 'everything' : draft.capabilities.map((c) => CAPABILITY_LABELS[c].toLowerCase()).join(', ') || 'nothing';
    return { langs, plats, caps };
  }, [draft, languages, platforms, isSuper]);
  const invalid = !draft.name.trim() || (!draft.id && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.email)) || (!isSuper && ((!draft.allLanguages && !draft.languageIds.length) || (!draft.allPlatforms && !draft.platformIds.length)));

  return (
    <Modal
      open
      wide
      onOpenChange={(o) => !o && setDraft(null)}
      title={draft.id ? `Permissions · ${draft.name}` : 'Invite user'}
      footer={
        <>
          <Button onClick={() => setDraft(null)}>Cancel</Button>
          <Button variant="primary" onClick={onSave} disabled={invalid}>
            {draft.id ? 'Save permissions' : 'Create invitation'}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="Name" htmlFor="u-name">
          <input id="u-name" className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Email" htmlFor="u-email">
          <input id="u-email" className="input" type="email" disabled={!!draft.id} value={draft.email} onChange={(e) => set({ email: e.target.value })} />
        </Field>
        <Field label="Role" htmlFor="u-role" hint="Choosing a role pre-selects its typical capabilities; adjust below.">
          <Select id="u-role" value={draft.role} onChange={(e) => {
            const role = e.target.value as Role;
            set({ role, capabilities: ROLE_DEFAULT_CAPABILITIES[role].filter((c) => isAdmin || can(c)) });
          }}>
            {ROLES.filter((r) => isAdmin || r !== 'super_admin').map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        </Field>
        <div />
        {!isSuper && (
          <>
            <div className="flex flex-col gap-2">
              <span className="text-[13px] font-medium text-muted">Languages</span>
              <Segmented label="Language access" value={draft.allLanguages ? 'all' : 'some'} onChange={(v) => set({ allLanguages: v === 'all' })} options={[{ value: 'some', label: 'Selected' }, { value: 'all', label: 'All languages' }]} />
              {!draft.allLanguages && <MultiSelect label="Languages" placeholder="Choose languages" options={languages} value={draft.languageIds} onChange={(v) => set({ languageIds: v })} />}
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-[13px] font-medium text-muted">Platforms</span>
              <Segmented label="Platform access" value={draft.allPlatforms ? 'all' : 'some'} onChange={(v) => set({ allPlatforms: v === 'all' })} options={[{ value: 'some', label: 'Selected' }, { value: 'all', label: 'All platforms' }]} />
              {!draft.allPlatforms && <MultiSelect label="Platforms" placeholder="Choose platforms" options={platforms} value={draft.platformIds} onChange={(v) => set({ platformIds: v })} />}
            </div>
            <div className="md:col-span-2">
              <span className="text-[13px] font-medium text-muted">Capabilities</span>
              <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {CAP_GROUPS.map((g) => (
                  <fieldset key={g.label} className="flex flex-col gap-1.5">
                    <legend className="label mb-1">{g.label}</legend>
                    {g.caps.map((c) => (
                      <Checkbox key={c} label={CAPABILITY_LABELS[c]} checked={draft.capabilities.includes(c)} disabled={!isAdmin && !can(c)} onChange={() => toggle(c)} />
                    ))}
                  </fieldset>
                ))}
              </div>
            </div>
          </>
        )}
        <div className="rounded-lg border border-line bg-bg p-3 text-[13px] md:col-span-2" aria-live="polite">
          <p className="label mb-1.5">Effective access</p>
          <p className="text-muted">
            <span className="text-fg">{draft.name || 'This user'}</span> can <span className="text-fg">{summary.caps}</span> for <span className="text-fg">{summary.langs}</span> on <span className="text-fg">{summary.plats}</span>.
            {!isSuper && !draft.capabilities.includes('view_source') && ' They will not see English source strings.'}
          </p>
        </div>
      </div>
    </Modal>
  );
}

function ActivityModal({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['user-activity', user?.id], queryFn: () => api.get(`/api/users/${user!.id}/activity`), enabled: !!user });
  return (
    <Modal open={!!user} onOpenChange={(o) => !o && onClose()} title={`Recent activity · ${user?.name ?? ''}`}>
      {q.isLoading ? (
        <Skeleton className="h-32" />
      ) : !q.data?.length ? (
        <p className="text-[13px] text-muted">No activity recorded.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line text-[13px]">
          {q.data.map((a: any) => (
            <li key={a.id} className="flex justify-between gap-3 py-1.5">
              <span>
                {a.action} <span className="text-subtle">{a.resourceType} {a.resourceId}</span>
              </span>
              <span className="shrink-0 text-subtle">{relTime(a.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
