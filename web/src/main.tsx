import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles.css';
import { SessionProvider, useMe, readPref } from './lib/session';
import { ConfirmProvider, ToastProvider } from './components/ui';
import { AppShell } from './components/AppShell';
import { LoginPage, AcceptInvitePage } from './pages/Auth';

const Overview = lazy(() => import('./pages/Overview'));
const Workspace = lazy(() => import('./pages/Workspace'));
const Review = lazy(() => import('./pages/Review'));
const Platforms = lazy(() => import('./pages/Platforms'));
const Languages = lazy(() => import('./pages/Languages'));
const Segments = lazy(() => import('./pages/Segments'));
const Users = lazy(() => import('./pages/Users'));
const ImportExport = lazy(() => import('./pages/ImportExport'));
const Activity = lazy(() => import('./pages/Activity'));
const Settings = lazy(() => import('./pages/Settings'));
const ApiAccess = lazy(() => import('./pages/ApiAccess'));
const AiTranslation = lazy(() => import('./pages/AiTranslation'));

document.documentElement.dataset.theme = readPref('theme', 'dark');

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (n, e: any) => n < 1 && ![401, 403, 404].includes(e?.status), refetchOnWindowFocus: false } },
});

function Gate() {
  const me = useMe();
  const loc = useLocation();
  if (me.isLoading) return <div className="grid h-full place-items-center text-muted">Loading…</div>;
  if (loc.pathname === '/accept-invite') return <AcceptInvitePage />;
  if (!me.data) return <LoginPage />;
  return (
    <SessionProvider me={me.data}>
      <AppShell>
        <Suspense fallback={<div className="p-8 text-muted">Loading…</div>}>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/workspace" element={<Workspace />} />
            <Route path="/review" element={<Review />} />
            <Route path="/platforms" element={<Platforms />} />
            <Route path="/languages" element={<Languages />} />
            <Route path="/segments" element={<Segments />} />
            <Route path="/users" element={<Users />} />
            <Route path="/import-export/*" element={<ImportExport />} />
            <Route path="/api-access/*" element={<ApiAccess />} />
            <Route path="/ai-translation/*" element={<AiTranslation />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </AppShell>
    </SessionProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <ConfirmProvider>
            <Gate />
          </ConfirmProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
