import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Numbers from './pages/Numbers';
import Contacts from './pages/Contacts';
import Campaigns from './pages/Campaigns';
import CampaignEditor from './pages/CampaignEditor';
import CampaignDetail from './pages/CampaignDetail';
import Settings from './pages/Settings';
import Activity from './pages/Activity';
import OneClick from './pages/OneClick';
import { PrivacyProvider } from './components/phone';

const NAV = [
  { to: '/', label: 'Dashboard', icon: '◧' },
  { to: '/notify', label: 'Special notifications', icon: '⚡' },
  { to: '/campaigns', label: 'Campaigns', icon: '✉' },
  { to: '/contacts', label: 'Contacts', icon: '☰' },
  { to: '/numbers', label: 'Numbers', icon: '☏' },
  { to: '/activity', label: 'Activity', icon: '⟲' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export default function App() {
  const loc = useLocation();
  const nav = useNavigate();
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    if (loc.pathname === '/login') { setUser(null); return; }
    api.get<{ username: string }>('/auth/me').then((u) => setUser(u.username)).catch(() => setUser(null));
  }, [loc.pathname === '/login']);
  useEffect(() => setMenu(false), [loc.pathname]);

  if (loc.pathname === '/login') return <Login onLogin={(u) => { setUser(u); nav('/'); }} />;
  if (user === undefined) return <div className="grid h-full place-items-center text-sm text-slate-500">Loading…</div>;
  if (user === null) return <Navigate to="/login" replace />;

  const logout = async () => { await api.post('/auth/logout'); nav('/login'); };

  return (
    <div className="flex h-full">
      <aside className={`fixed inset-y-0 left-0 z-40 w-60 shrink-0 border-r border-slate-200 bg-white transition-transform md:static md:translate-x-0 ${menu ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-14 items-center gap-2 border-b border-slate-100 px-4">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <div>
            <div className="text-sm font-semibold leading-tight">GCM Notified</div>
            <div className="text-[11px] text-slate-500">WhatsApp messaging</div>
          </div>
        </div>
        <nav className="space-y-0.5 p-2">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}
              className={({ isActive }) => `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-brand-50 font-medium text-brand-800' : 'text-slate-600 hover:bg-slate-50'}`}>
              <span className="w-4 text-center opacity-70" aria-hidden>{n.icon}</span>{n.label}
            </NavLink>
          ))}
        </nav>
        <div className="absolute inset-x-0 bottom-0 border-t border-slate-100 p-3 text-xs text-slate-500">
          Signed in as <b className="text-slate-700">{user}</b>
          <button className="ml-2 text-brand-700 hover:underline" onClick={logout}>Log out</button>
        </div>
      </aside>
      {menu && <div className="fixed inset-0 z-30 bg-slate-900/30 md:hidden" onClick={() => setMenu(false)} />}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center border-b border-slate-200 bg-white px-4 md:hidden">
          <button className="btn-ghost px-2" onClick={() => setMenu(true)} aria-label="Open menu">☰</button>
          <span className="ml-2 text-sm font-semibold">GCM Notified</span>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
          <div className="mx-auto max-w-6xl">
            <PrivacyProvider>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/notify" element={<OneClick />} />
              <Route path="/campaigns" element={<Campaigns />} />
              <Route path="/campaigns/:id/edit" element={<CampaignEditor />} />
              <Route path="/campaigns/:id" element={<CampaignDetail />} />
              <Route path="/contacts" element={<Contacts />} />
              <Route path="/numbers" element={<Numbers />} />
              <Route path="/activity" element={<Activity />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </PrivacyProvider>
          </div>
        </main>
      </div>
    </div>
  );
}
