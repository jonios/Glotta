import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Bell,
  BookOpen,
  CheckCheck,
  ChevronsLeft,
  ChevronsRight,
  FileStack,
  Globe2,
  KeyRound,
  LayoutGrid,
  LogOut,
  Menu,
  Moon,
  Settings,
  Sparkles,
  Sun,
  Tags,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { readPref, useSession, writePref } from '../lib/session';
import { canUseApiAccess, ROLE_LABELS, type Capability, type Role } from '../../../shared/domain';
import { cx, IconButton, SearchInput } from './ui';
import { BrandLogo } from './Brand';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  visible: (can: (c: Capability) => boolean, role: Role) => boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutGrid, visible: (can) => can('view') },
  { to: '/workspace', label: 'Translation Workspace', icon: BookOpen, visible: (can) => can('view') },
  { to: '/review', label: 'Review', icon: CheckCheck, visible: (can) => can('review') || can('approve') },
  { to: '/platforms', label: 'Platforms', icon: FileStack, visible: (can) => can('view') },
  { to: '/languages', label: 'Languages', icon: Globe2, visible: (can) => can('view') },
  { to: '/segments', label: 'Segments', icon: Tags, visible: (can) => can('view') },
  { to: '/users', label: 'Users & Permissions', icon: Users, visible: (_can, role) => role === 'super_admin' },
  { to: '/ai-translation', label: 'AI Translation', icon: Sparkles, visible: (can, role) => canUseApiAccess(role) && can('edit_translations') },
  { to: '/import-export', label: 'Import / Export', icon: FileStack, visible: (can) => can('import') || can('export') },
  { to: '/api-access', label: 'API Access', icon: KeyRound, visible: (_can, role) => canUseApiAccess(role) },
  { to: '/activity', label: 'Translation Activity', icon: Activity, visible: () => true },
  { to: '/settings', label: 'Settings', icon: Settings, visible: () => true },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { me, can } = useSession();
  const [collapsed, setCollapsed] = useState(() => readPref('sidebar-collapsed', false));
  const [mobileOpen, setMobileOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setMobileOpen(false), [loc.pathname]);
  const items = NAV.filter((n) => n.visible(can, me.scope.role));

  const nav = (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 px-2 py-3">
      {items.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/'}
          title={collapsed ? n.label : undefined}
          className={({ isActive }) =>
            cx(
              'flex h-9 items-center gap-2.5 rounded px-2.5 text-[14px] transition-colors duration-fast',
              isActive ? 'bg-hover text-fg shadow-[inset_2px_0_0_rgb(var(--accent))]' : 'text-muted hover:bg-hover/60 hover:text-fg',
            )
          }
        >
          <n.icon size={17} aria-hidden className="shrink-0" />
          <span className={cx('truncate', collapsed && 'lg:sr-only')}>{n.label}</span>
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="flex h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-raised focus:px-3 focus:py-2">
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className={cx('hidden shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-base lg:flex', collapsed ? 'w-[60px]' : 'w-[232px]')}>
        <Brand collapsed={collapsed} />
        {nav}
        <div className="border-t border-line p-2">
          <IconButton
            icon={collapsed ? ChevronsRight : ChevronsLeft}
            label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => {
              setCollapsed(!collapsed);
              writePref('sidebar-collapsed', !collapsed);
            }}
          />
        </div>
      </aside>
      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="anim-slide absolute inset-y-0 left-0 flex w-[260px] flex-col border-r border-line bg-surface">
            <div className="flex items-center justify-between pr-2">
              <Brand collapsed={false} />
              <IconButton icon={X} label="Close menu" onClick={() => setMobileOpen(false)} />
            </div>
            {nav}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setMobileOpen(true)} userName={me.user.name} />
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={cx('flex h-16 items-center', collapsed ? 'justify-center px-2' : 'px-4')}>
      <BrandLogo size={collapsed ? 32 : 36} showName={!collapsed} />
    </div>
  );
}

function TopBar({ onMenu, userName }: { onMenu: () => void; userName: string }) {
  const { me, platforms, targetLanguages } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const onWorkspace = loc.pathname === '/workspace';
  const platform = params.get('platform') ?? String(readPref('platform', ''));
  const lang = params.get('lang') ?? String(readPref('lang', ''));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const goWorkspace = (patch: Record<string, string>) => {
    const sp = new URLSearchParams(onWorkspace ? params : undefined);
    if (!onWorkspace) {
      if (platform) sp.set('platform', platform);
      if (lang) sp.set('lang', lang);
    }
    for (const [k, v] of Object.entries(patch)) v ? sp.set(k, v) : sp.delete(k);
    sp.delete('page');
    nav(`/workspace?${sp.toString()}`);
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-bg/80 px-3 backdrop-blur sm:px-4">
      <IconButton icon={Menu} label="Open menu" className="lg:hidden" onClick={onMenu} />
      <form
        className="min-w-0 flex-1 sm:max-w-[420px]"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          goWorkspace({ q });
        }}
      >
        <SearchInput inputRef={searchRef} value={q} onChange={setQ} placeholder="Search keys, source, translations… (Ctrl K)" />
      </form>
      <div className="ml-auto flex items-center gap-1.5">
        <select
          aria-label="Platform"
          className="input hidden h-8 w-auto max-w-[170px] cursor-pointer py-0 text-[13px] md:block"
          value={platform}
          onChange={(e) => {
            writePref('platform', e.target.value);
            goWorkspace({ platform: e.target.value });
          }}
        >
          <option value="">All my platforms</option>
          {platforms.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Target language"
          className="input hidden h-8 w-auto max-w-[170px] cursor-pointer py-0 text-[13px] md:block"
          value={lang}
          onChange={(e) => {
            writePref('lang', e.target.value);
            goWorkspace({ lang: e.target.value });
          }}
        >
          {targetLanguages.length > 1 && <option value="">Choose language</option>}
          {targetLanguages.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.code})
            </option>
          ))}
        </select>
        <Notifications />
        <ThemeToggle />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="ml-1 flex h-8 cursor-pointer items-center gap-2 rounded px-1.5 hover:bg-hover" aria-label="Account menu">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-raised text-[12px] font-semibold text-accent ring-1 ring-line">
                {userName.slice(0, 1).toUpperCase()}
              </span>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={6} className="anim-fade z-50 min-w-[220px] rounded-lg border border-line bg-raised p-1.5 shadow-pop">
              <div className="px-2 py-1.5">
                <div className="truncate text-[14px] font-medium">{userName}</div>
                <div className="truncate text-[12px] text-subtle">{me.user.email}</div>
                <div className="mt-1 text-[12px] text-muted">{ROLE_LABELS[me.user.role]}</div>
              </div>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <MenuItem icon={Settings} onSelect={() => nav('/settings')}>
                Account & settings
              </MenuItem>
              <SignOut />
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}

function MenuItem({ icon: Icon, children, onSelect }: { icon: LucideIcon; children: ReactNode; onSelect: () => void }) {
  return (
    <DropdownMenu.Item onSelect={onSelect} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] text-muted outline-none data-[highlighted]:bg-hover data-[highlighted]:text-fg">
      <Icon size={15} aria-hidden /> {children}
    </DropdownMenu.Item>
  );
}

function SignOut() {
  const qc = useQueryClient();
  return (
    <MenuItem
      icon={LogOut}
      onSelect={async () => {
        await api.post('/api/auth/logout');
        qc.clear();
        window.location.href = '/';
      }}
    >
      Sign out
    </MenuItem>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<string>(() => document.documentElement.dataset.theme ?? 'dark');
  return (
    <IconButton
      icon={theme === 'dark' ? Sun : Moon}
      label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => {
        const next = theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        writePref('theme', next);
        setTheme(next);
      }}
    />
  );
}

/** Work waiting for the user, derived from scoped dashboard counts. */
function Notifications() {
  const { can } = useSession();
  const nav = useNavigate();
  const d = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get('/api/dashboard'), staleTime: 30_000, refetchInterval: 60_000 });
  const t = d.data?.totals;
  const items = t
    ? [
        can('approve') || can('review') ? { n: t.needsReview, label: 'translations waiting for review', to: '/review' } : null,
        can('edit_translations') ? { n: t.inProgress, label: 'translations returned for changes', to: '/workspace?statuses=in_progress' } : null,
        { n: t.openConflicts, label: 'open import conflicts', to: can('import') ? '/import-export/conflicts' : '/workspace?flags=conflicts' },
      ].filter((x): x is { n: number; label: string; to: string } => !!x && x.n > 0)
    : [];
  const total = items.reduce((a, i) => a + i.n, 0);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="relative grid h-8 w-8 cursor-pointer place-items-center rounded text-muted hover:bg-hover hover:text-fg" aria-label={`Notifications${total ? `, ${total} items` : ''}`}>
          <Bell size={16} aria-hidden />
          {total > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent ring-2 ring-bg" />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="anim-fade z-50 w-[300px] rounded-lg border border-line bg-raised p-2 shadow-pop">
          <div className="label px-2 py-1">Needs your attention</div>
          {items.length === 0 ? (
            <p className="px-2 py-4 text-[13px] text-muted">You're all caught up.</p>
          ) : (
            items.map((i) => (
              <Popover.Close asChild key={i.label}>
                <button onClick={() => nav(i.to)} className="flex w-full cursor-pointer items-center gap-3 rounded px-2 py-2 text-left text-[13px] hover:bg-hover">
                  <span className="min-w-[44px] rounded bg-hover px-1.5 text-center font-mono text-[12px] tabular-nums text-fg">{i.n.toLocaleString()}</span>
                  <span className="text-muted">{i.label}</span>
                </button>
              </Popover.Close>
            ))
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
