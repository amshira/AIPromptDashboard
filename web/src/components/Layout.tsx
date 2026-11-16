import { useQueryClient } from '@tanstack/react-query';
import { BarChart3, CalendarClock, KeySquare, LayoutDashboard, LogOut, Menu, MessagesSquare, Moon, Settings, Sun, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { LangSwitch, useI18n } from '../lib/i18n';
import { cx } from './ui';

function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('pd-theme', theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))] as const;
}

export function Layout() {
  const { t } = useI18n();
  const [theme, toggle] = useTheme();
  const NAV = [
    { to: '/', l: t('نمای کلی', 'Overview'), icon: LayoutDashboard, end: true },
    { to: '/explore', l: t('گفتگوها', 'Conversations'), icon: MessagesSquare },
    { to: '/reports', l: t('گزارش روزانه', 'Daily report'), icon: BarChart3 },
    { to: '/panels', l: t('پنل‌ها و دسترسی', 'Panels and access'), icon: KeySquare },
    { to: '/schedules', l: t('زمان‌بندی', 'Schedules'), icon: CalendarClock },
    { to: '/settings', l: t('تنظیمات', 'Settings'), icon: Settings },
  ];
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const qc = useQueryClient();
  useEffect(() => setOpen(false), [loc.pathname]);

  const logout = async () => {
    await api('POST', '/api/auth/logout').catch(() => undefined);
    qc.clear();
    qc.setQueryData(['me'], { authenticated: false });
  };

  const nav = (
    <nav className="flex flex-col gap-0.5" aria-label={t('منوی اصلی', 'Main menu')}>
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          className={({ isActive }) =>
            cx(
              'flex items-center gap-2.5 h-10 px-3 rounded-[10px] text-[13.5px] no-underline transition-colors',
              isActive || (n.to === '/explore' && loc.pathname.startsWith('/sessions')) ? 'bg-accent-soft text-accent font-semibold' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
            )
          }
        >
          <n.icon size={17} strokeWidth={1.9} />
          {n.l}
        </NavLink>
      ))}
    </nav>
  );

  const footer = (
    <div className="flex items-center gap-1 border-t border-line pt-3">
      <button className="btn btn-ghost btn-sm grow justify-start" onClick={logout}>
        <LogOut size={15} /> {t('خروج', 'Log out')}
      </button>
      <LangSwitch />
      <button className="btn btn-ghost btn-icon btn-sm" onClick={toggle} aria-label={theme === 'dark' ? t('تم روشن', 'Light theme') : t('تم تیره', 'Dark theme')} title={theme === 'dark' ? t('تم روشن', 'Light theme') : t('تم تیره', 'Dark theme')}>
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    </div>
  );

  const brand = (
    <div className="flex items-center gap-2.5 px-2 mb-5">
      <img src="/favicon.svg" alt="" className="size-8" />
      <div className="leading-tight">
        <div className="font-extrabold text-[15px]">{t('داشبورد پرامپت', 'Prompt Dashboard')}</div>
        <div className="text-[11.5px] text-ink-3">9router</div>
      </div>
    </div>
  );

  return (
    <div className="min-h-full lg:grid lg:grid-cols-[232px_1fr]">
      {/* desktop sidebar */}
      <aside className="hidden lg:flex flex-col sticky top-0 h-screen border-e border-line bg-surface px-3 py-4">
        {brand}
        <div className="grow">{nav}</div>
        {footer}
      </aside>

      {/* mobile top bar + drawer */}
      <header className="lg:hidden sticky top-0 z-30 flex items-center justify-between h-14 px-3 bg-surface/90 backdrop-blur border-b border-line">
        <button className="btn btn-ghost btn-icon" onClick={() => setOpen(true)} aria-label={t('باز کردن منو', 'Open menu')}>
          <Menu size={20} />
        </button>
        <div className="font-extrabold text-[15px]">{t('داشبورد پرامپت', 'Prompt Dashboard')}</div>
        <button className="btn btn-ghost btn-icon" onClick={toggle} aria-label={t('تغییر تم', 'Toggle theme')}>
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </header>
      {open && (
        <div className="lg:hidden fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={t('منو', 'Menu')}>
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute top-0 bottom-0 start-0 w-[260px] bg-surface border-e border-line flex flex-col px-3 py-4 shadow-xl">
            <div className="flex items-start justify-between">
              {brand}
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setOpen(false)} aria-label={t('بستن منو', 'Close menu')}>
                <X size={18} />
              </button>
            </div>
            <div className="grow">{nav}</div>
            {footer}
          </aside>
        </div>
      )}

      <main className="min-w-0 px-4 sm:px-6 lg:px-8 py-5 lg:py-7 max-w-[1440px] w-full mx-auto">
        <Outlet />
      </main>
    </div>
  );
}
