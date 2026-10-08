import { AdminPage } from './admin/AdminPage';
import { DashboardPage } from './dashboard/DashboardPage';
import { FunnelPage } from './funnel/FunnelPage';

/** Three pages, no router dependency: internal pages are plain links with a full page load. */
export function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/admin') return <AdminPage />;
  if (path === '/dashboard') return <DashboardPage />;
  return <FunnelPage />;
}
