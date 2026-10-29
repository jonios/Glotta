import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { ROLE_LABELS } from '../../../shared/domain';
import { extractPlaceholders, type PlaceholderRule } from '../../../shared/placeholders';
import { Button, Checkbox, Field, IconButton, PageHeader, Select, Skeleton, errorMessage, useToast } from '../components/ui';

export default function Settings() {
  const { can } = useSession();
  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-5 p-4 sm:p-6">
      <PageHeader title="Settings" />
      <Account />
      {can('manage_settings') ? <OrgSettings /> : <Guidelines />}
    </div>
  );
}

function Account() {
  const { me, languages, platforms } = useSession();
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/auth/change-password', { currentPassword: cur, newPassword: next });
      toast('ok', 'Password changed. Other sessions were signed out.');
      setCur('');
      setNext('');
    } catch (err: any) {
      toast('error', err.details?.[0]?.message ?? errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const s = me.scope;
  return (
    <section className="card p-5">
      <h2 className="mb-4 font-medium">Your account</h2>
      <dl className="mb-5 grid grid-cols-[140px_1fr] gap-y-2 text-[13px]">
        <dt className="text-subtle">Name</dt>
        <dd>{me.user.name}</dd>
        <dt className="text-subtle">Email</dt>
        <dd>{me.user.email}</dd>
        <dt className="text-subtle">Role</dt>
        <dd>{ROLE_LABELS[me.user.role]}</dd>
        <dt className="text-subtle">Languages</dt>
        <dd>{s.allLanguages ? 'All' : languages.filter((l) => s.languageIds.includes(l.id)).map((l) => l.name).join(', ') || 'None'}</dd>
        <dt className="text-subtle">Platforms</dt>
        <dd>{s.allPlatforms ? 'All' : platforms.map((p) => p.name).join(', ') || 'None'}</dd>
        <dt className="text-subtle">Capabilities</dt>
        <dd className="text-muted">{s.capabilities.join(', ').replace(/_/g, ' ')}</dd>
      </dl>
      <form onSubmit={submit} className="grid max-w-xl gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Current password" htmlFor="cur">
          <input id="cur" type="password" className="input" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        </Field>
        <Field label="New password" htmlFor="new">
          <input id="new" type="password" className="input" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Button type="submit" loading={busy} disabled={!cur || next.length < 10}>
          Change password
        </Button>
      </form>
    </section>
  );
}

function Guidelines() {
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get('/api/settings') });
  if (!q.data?.translator_guidelines) return null;
  return (
    <section className="card p-5">
      <h2 className="mb-3 font-medium">Translation guidelines</h2>
      <p className="whitespace-pre-wrap text-[13px] text-muted">{q.data.translator_guidelines}</p>
    </section>
  );
}

function OrgSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get('/api/settings') });
  const [rules, setRules] = useState<PlaceholderRule[]>([]);
  const [guidelines, setGuidelines] = useState('');
  const [importStatus, setImportStatus] = useState('approved');
  const [sample, setSample] = useState('Hello {{name}}, you have %d new %@ items in {city}');
  useEffect(() => {
    if (!q.data) return;
    setRules(q.data.placeholder_rules);
    setGuidelines(q.data.translator_guidelines);
    setImportStatus(q.data.default_import_status);
  }, [q.data]);
  if (q.isLoading) return <Skeleton className="h-64" />;
  let preview: string[] = [];
  let invalid = '';
  try {
    rules.forEach((r) => new RegExp(r.pattern));
    preview = extractPlaceholders(sample, rules);
  } catch {
    invalid = 'One of the patterns is not a valid regular expression.';
  }
  const save = async () => {
    try {
      await api.put('/api/settings', { placeholder_rules: rules, translator_guidelines: guidelines, default_import_status: importStatus });
      toast('ok', 'Settings saved');
      qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  const upd = (i: number, p: Partial<PlaceholderRule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <>
      <section className="card p-5">
        <h2 className="font-medium">Placeholder validation</h2>
        <p className="mb-4 mt-1 text-[13px] text-muted">Placeholders found in the source must appear in translations. Mismatches are shown as warnings; saving is never blocked.</p>
        <div className="flex flex-col gap-2">
          {rules.map((r, i) => (
            <div key={i} className="grid grid-cols-[auto_150px_1fr_auto] items-center gap-2">
              <Checkbox label={<span className="sr-only">Enable {r.label}</span>} checked={r.enabled} onChange={(v) => upd(i, { enabled: v })} />
              <input className="input h-8" aria-label="Rule label" value={r.label} onChange={(e) => upd(i, { label: e.target.value })} />
              <input className="input h-8 font-mono text-[12px]" aria-label="Regular expression" value={r.pattern} onChange={(e) => upd(i, { pattern: e.target.value })} />
              <IconButton icon={Trash2} label={`Remove rule ${r.label}`} onClick={() => setRules(rules.filter((_, j) => j !== i))} />
            </div>
          ))}
        </div>
        <Button size="sm" variant="ghost" icon={Plus} className="mt-2" onClick={() => setRules([...rules, { id: `custom${Date.now()}`, label: 'Custom', pattern: '', enabled: true }])}>
          Add rule
        </Button>
        <div className="mt-4 rounded border border-line bg-bg p-3">
          <Field label="Test string" htmlFor="sample">
            <input id="sample" className="input" value={sample} onChange={(e) => setSample(e.target.value)} />
          </Field>
          <p className="mt-2 text-[12px] text-muted">{invalid || `Detected: ${preview.join('  ') || 'none'}`}</p>
        </div>
      </section>
      <section className="card p-5">
        <h2 className="mb-3 font-medium">Translator guidelines</h2>
        <textarea className="input h-auto min-h-[180px] py-2 text-[13px]" aria-label="Translator guidelines" value={guidelines} onChange={(e) => setGuidelines(e.target.value)} />
        <div className="mt-4 max-w-xs">
          <Field label="Default status for imported values">
            <Select value={importStatus} onChange={(e) => setImportStatus(e.target.value)}>
              <option value="approved">Approved</option>
              <option value="needs_review">Needs review</option>
              <option value="draft">Draft</option>
            </Select>
          </Field>
        </div>
      </section>
      <div>
        <Button variant="primary" onClick={save} disabled={!!invalid}>
          Save settings
        </Button>
      </div>
    </>
  );
}
