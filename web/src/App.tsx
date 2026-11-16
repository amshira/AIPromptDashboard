import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Spinner, ToastHost } from './components/ui';
import { get, setUnauthorizedHandler } from './lib/api';
import { Login } from './pages/Login';

const Overview = lazy(() => import('./pages/Overview'));
const Explorer = lazy(() => import('./pages/Explorer'));
const Conversation = lazy(() => import('./pages/Conversation'));
const Reports = lazy(() => import('./pages/Reports'));
const Schedules = lazy(() => import('./pages/Schedules'));
const Settings = lazy(() => import('./pages/Settings'));
const Panels = lazy(() => import('./pages/Panels'));

function FullSpinner() {
  return (
    <div className="h-full grid place-items-center text-ink-3">
      <Spinner size={22} />
    </div>
  );
}

export function App() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const me = useQuery({ queryKey: ['me'], queryFn: () => get<{ authenticated: boolean }>('/api/auth/me'), staleTime: Infinity, retry: false });

  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.setQueryData(['me'], { authenticated: false });
    });
  }, [qc]);

  const authed = me.data?.authenticated === true;
  useEffect(() => {
    if (me.data && !authed && loc.pathname !== '/login') nav(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`, { replace: true });
  }, [me.data, authed, loc.pathname, loc.search, nav]);

  if (me.isLoading) return <FullSpinner />;

  return (
    <ToastHost>
      <Routes>
        <Route path="/login" element={authed ? <Navigate to="/" replace /> : <Login />} />
        <Route
          element={authed ? <Layout /> : <FullSpinner />}
        >
          <Route index element={<Lazy el={<Overview />} />} />
          <Route path="explore" element={<Lazy el={<Explorer />} />} />
          <Route path="sessions/:id" element={<Lazy el={<Conversation />} />} />
          <Route path="reports" element={<Lazy el={<Reports />} />} />
          <Route path="schedules" element={<Lazy el={<Schedules />} />} />
          <Route path="panels" element={<Lazy el={<Panels />} />} />
          <Route path="settings" element={<Lazy el={<Settings />} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </ToastHost>
  );
}

function Lazy({ el }: { el: React.ReactNode }) {
  return <Suspense fallback={<FullSpinner />}>{el}</Suspense>;
}
