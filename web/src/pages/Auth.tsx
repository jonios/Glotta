import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { BrandLogo } from '../components/Brand';
import { Button, Field } from '../components/ui';

function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="grid min-h-full place-items-center px-4 py-10">
      <div className="w-full max-w-[380px]">
        <BrandLogo size={48} className="mb-7" />
        <div className="card p-6">
          <h1 className="text-[18px] font-semibold">{title}</h1>
          <p className="mb-5 mt-1 text-[13px] text-muted">{subtitle}</p>
          {children}
        </div>
      </div>
    </main>
  );
}

export function LoginPage() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/login', { email, password });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err: any) {
      setError(err.status === 429 ? 'Too many attempts. Wait a minute and try again.' : err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard title="Sign in" subtitle="Translation management for every platform.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Email" htmlFor="email">
          <input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password">
          <input id="password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && (
          <p role="alert" className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}
        <Button variant="primary" type="submit" loading={busy} disabled={!email || !password}>
          Sign in
        </Button>
        <p className="text-[12px] text-subtle">No account? Ask your administrator for an invitation link.</p>
      </form>
    </AuthCard>
  );
}

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const nav = useNavigate();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ['invite', token], queryFn: () => api.get(`/api/auth/invite-info?token=${encodeURIComponent(token)}`), enabled: token.length > 10, retry: false });
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) return setError('Passwords do not match');
    setBusy(true);
    try {
      await api.post('/api/auth/accept-invite', { token, password: pw });
      await qc.invalidateQueries({ queryKey: ['me'] });
      nav('/', { replace: true });
    } catch (err: any) {
      setError(err.details?.[0]?.message ?? err.message);
    } finally {
      setBusy(false);
    }
  };
  if (!token || info.isError) {
    return (
      <AuthCard title="Invitation not valid" subtitle="The link is invalid or has expired.">
        <p className="text-[13px] text-muted">Ask your administrator to send a new invitation link.</p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Set your password" subtitle={info.data ? `Welcome, ${info.data.name} (${info.data.email})` : 'Loading invitation…'}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="New password" htmlFor="pw" hint="At least 10 characters">
          <input id="pw" className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <Field label="Confirm password" htmlFor="pw2">
          <input id="pw2" className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </Field>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        <Button variant="primary" type="submit" loading={busy} disabled={pw.length < 10}>
          Activate account
        </Button>
      </form>
    </AuthCard>
  );
}
