import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { useState } from 'react';
import { api, qs } from '../lib/api';
import { EmptyState, ErrorState, PageHeader, Pagination, SearchInput, Select, Skeleton, useDebounced } from '../components/ui';

const ACTION_GROUPS = [
  ['', 'All actions'],
  ['translation.', 'Translations'],
  ['key.', 'Keys, segments & platforms'],
  ['import.', 'Imports'],
  ['export.', 'Exports'],
  ['conflict.', 'Conflict resolutions'],
  ['user.', 'Users & permissions'],
  ['language.', 'Languages'],
  ['platform.', 'Platforms'],
  ['segment.', 'Segments'],
  ['settings.', 'Settings'],
  ['auth.', 'Sign-ins'],
];

function short(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

export default function Activity() {
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const search = useDebounced(q, 300);
  const [page, setPage] = useState(1);
  const params = { action, search, page, pageSize: 50 };
  const res = useQuery({ queryKey: ['audit', params], queryFn: () => api.get(`/api/audit${qs(params)}`), placeholderData: keepPreviousData });
  return (
    <div className="mx-auto max-w-[1200px] p-4 sm:p-6">
      <PageHeader
        title="Translation Activity"
        description={res.data?.scoped === 'own' ? 'Your own recent actions.' : res.data?.scoped === 'scope' ? 'Changes within your languages and platforms.' : 'Complete audit log.'}
        actions={
          <>
            <Select aria-label="Action type" className="w-[220px]" value={action} onChange={(e) => (setAction(e.target.value), setPage(1))}>
              {ACTION_GROUPS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            <SearchInput value={q} onChange={(v) => (setQ(v), setPage(1))} placeholder="Search values or resource id" className="w-[240px]" />
          </>
        }
      />
      {res.isError ? (
        <ErrorState error={res.error} />
      ) : res.isLoading ? (
        <Skeleton className="h-96" />
      ) : !res.data.rows.length ? (
        <EmptyState icon={ScrollText} title="No activity matches" />
      ) : (
        <>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[860px] text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-muted">
                  <th className="px-4 py-2.5 font-medium">When</th>
                  <th className="px-4 py-2.5 font-medium">Who</th>
                  <th className="px-4 py-2.5 font-medium">Action</th>
                  <th className="px-4 py-2.5 font-medium">Resource</th>
                  <th className="px-4 py-2.5 font-medium">Change</th>
                </tr>
              </thead>
              <tbody>
                {res.data.rows.map((a: any) => (
                  <tr key={a.id} className="border-b border-line align-top last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 text-muted">{new Date(a.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-2">{a.actor ?? 'system'}</td>
                    <td className="px-4 py-2">
                      <span className="font-mono text-[12px]">{a.action}</span>
                      {a.languageCode && <span className="ml-1.5 font-mono text-[11px] text-accent">{a.languageCode}</span>}
                    </td>
                    <td className="px-4 py-2 text-muted">
                      {a.resourceType} {a.resourceId && `#${a.resourceId}`}
                      {a.jobRef && <span className="block text-[11px] text-subtle">{a.jobRef}</span>}
                    </td>
                    <td className="max-w-[420px] px-4 py-2 text-[12px]">
                      {a.before !== null && a.before !== undefined && <p className="break-words text-danger/80 line-through decoration-danger/40">{short(a.before)}</p>}
                      {a.after !== null && a.after !== undefined && <p className="break-words text-muted">{short(a.after)}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex justify-end">
            <Pagination page={page} pageSize={50} total={res.data.total} onPage={setPage} />
          </div>
        </>
      )}
    </div>
  );
}
