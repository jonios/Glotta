import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setCsrf, type Language, type Platform } from './api';
import type { Capability, Role } from '../../../shared/domain';

export interface Me {
  user: { id: number; email: string; name: string; role: Role };
  scope: {
    role: Role;
    capabilities: Capability[];
    allLanguages: boolean;
    languageIds: number[];
    allPlatforms: boolean;
    platformIds: number[];
  };
  csrfToken: string;
}

interface SessionValue {
  me: Me;
  can: (c: Capability) => boolean;
  isAdmin: boolean;
  languages: Language[]; // languages visible to the user (incl. source when permitted)
  targetLanguages: Language[];
  sourceLanguage: Language | undefined;
  platforms: Platform[]; // active platforms in scope
  refresh: () => void;
}

const Ctx = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside provider');
  return v;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const me = await api.get<Me>('/api/auth/me');
      setCsrf(me.csrfToken);
      return me;
    },
    retry: false,
    staleTime: 60_000,
  });
}

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const qc = useQueryClient();
  const languages = useQuery({ queryKey: ['languages'], queryFn: () => api.get<Language[]>('/api/languages'), staleTime: 30_000 });
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => api.get<Platform[]>('/api/platforms'), staleTime: 30_000 });
  useEffect(() => {
    const onUnauth = () => qc.invalidateQueries({ queryKey: ['me'] });
    window.addEventListener('tms:unauthenticated', onUnauth);
    return () => window.removeEventListener('tms:unauthenticated', onUnauth);
  }, [qc]);
  const isAdmin = me.scope.role === 'super_admin';
  const caps = new Set(me.scope.capabilities);
  const langs = languages.data ?? [];
  const value: SessionValue = {
    me,
    isAdmin,
    can: (c) => isAdmin || caps.has(c),
    languages: langs,
    targetLanguages: langs.filter((l) => !l.isSource),
    sourceLanguage: langs.find((l) => l.isSource),
    platforms: platforms.data ?? [],
    refresh: () => {
      qc.invalidateQueries({ queryKey: ['languages'] });
      qc.invalidateQueries({ queryKey: ['platforms'] });
    },
  };
  if (languages.isLoading || platforms.isLoading) {
    return (
      <div className="grid h-full place-items-center text-muted" role="status">
        Loading workspace…
      </div>
    );
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Persisted per-browser preference (falls back silently when storage is unavailable). */
export function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`tms:${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
export function writePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`tms:${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}
