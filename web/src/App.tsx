import { useEffect, type ReactNode } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { SearchPage } from './pages/Search';
import { Directory, PersonPage } from './pages/Directory';
import { AppsPage } from './pages/Apps';
import { MailPage } from './pages/Mail';
import { NoticesPage } from './pages/Notices';
import { FilesPage } from './pages/Files';
import { Profile } from './pages/Profile';
import { AdminOverview } from './pages/admin/Overview';
import { AdminUsers } from './pages/admin/Users';
import { AdminGroups } from './pages/admin/Groups';
import { AdminRoles } from './pages/admin/Roles';
import { AdminModules } from './pages/admin/Modules';
import { AdminApps } from './pages/admin/Apps';
import { AdminMail } from './pages/admin/Mail';
import { AdminAudit } from './pages/admin/Audit';
import { AdminSettings } from './pages/admin/Settings';
import { ToastProvider } from './ui';

function Splash() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg)',
        gap: 12,
      }}
    >
      <div style={{ display: 'grid', justifyItems: 'center', gap: 14 }}>
        <span className="brand-mark" style={{ width: 44, height: 44, fontSize: 22, borderRadius: 13 }}>
          R
        </span>
        <div className="small faint">Cargando RedLBA…</div>
      </div>
    </div>
  );
}

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <Splash />;
  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }
  return <>{children}</>;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user?.isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Si el portal se sirve en el dominio de un módulo, abre ese módulo.
 *  En admin.<dominio> abre el panel. */
function Landing() {
  const { currentModule, modules, adminHost, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (location.pathname !== '/') return;
    if (adminHost && user?.isAdmin) {
      navigate('/admin', { replace: true });
      return;
    }
    if (!currentModule) return;
    const module = modules.find((item) => item.key === currentModule);
    if (module) navigate(module.path, { replace: true });
  }, [currentModule, modules, adminHost, user, navigate, location.pathname]);

  return <Dashboard />;
}

function NotFound() {
  return (
    <div className="shell">
      <div className="main">
        <div className="content">
          <div className="card">
            <div className="empty" style={{ padding: 60 }}>
              <div className="empty-title">Esta página no existe</div>
              <a className="btn" href="/">
                Volver al inicio
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TitleSync() {
  const { boot } = useAuth();
  useEffect(() => {
    if (boot?.site.name) document.title = boot.site.name;
  }, [boot?.site.name]);
  return null;
}

function Router() {
  return (
    <BrowserRouter>
      <TitleSync />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <Protected>
              <Landing />
            </Protected>
          }
        />
        <Route
          path="/search"
          element={
            <Protected>
              <SearchPage />
            </Protected>
          }
        />
        <Route
          path="/directory"
          element={
            <Protected>
              <Directory />
            </Protected>
          }
        />
        <Route
          path="/directory/:username"
          element={
            <Protected>
              <PersonPage />
            </Protected>
          }
        />
        <Route
          path="/apps"
          element={
            <Protected>
              <AppsPage />
            </Protected>
          }
        />
        <Route
          path="/mail"
          element={
            <Protected>
              <MailPage />
            </Protected>
          }
        />
        <Route
          path="/notices"
          element={
            <Protected>
              <NoticesPage />
            </Protected>
          }
        />
        <Route
          path="/files"
          element={
            <Protected>
              <FilesPage />
            </Protected>
          }
        />
        <Route
          path="/profile"
          element={
            <Protected>
              <Profile />
            </Protected>
          }
        />
        <Route
          path="/admin"
          element={
            <Protected>
              <AdminOnly>
                <AdminOverview />
              </AdminOnly>
            </Protected>
          }
        />
        <Route
          path="/admin/users"
          element={
            <Protected>
              <AdminOnly>
                <AdminUsers />
              </AdminOnly>
            </Protected>
          }
        />
        <Route
          path="/admin/groups"
          element={
            <Protected>
              <AdminOnly>
                <AdminGroups />
              </AdminOnly>
            </Protected>
          }
        />
        <Route
          path="/admin/roles"
          element={
            <Protected>
              <AdminOnly>
                <AdminRoles />
              </AdminOnly>
            </Protected>
          }
        />
        <Route
          path="/admin/modules"
          element={
            <Protected>
              <AdminOnly>
                <AdminModules />
              </AdminOnly>
            </Protected>
          }
        />
        <Route
          path="/admin/apps"
          element={
            <Protected>
              <AdminOnly>
                <AdminApps />
              </AdminOnly>
            </Protected>
          }
        />
        <Route
          path="/admin/mail"
          element={
            <Protected>
              <AdminOnly>
                <AdminMail />
              </AdminOnly>
            </Protected>
          }
        />
        <Route
          path="/admin/audit"
          element={
            <Protected>
              <AdminOnly>
                <AdminAudit />
              </AdminOnly>
            </Protected>
          }
        />
        <Route
          path="/admin/settings"
          element={
            <Protected>
              <AdminOnly>
                <AdminSettings />
              </AdminOnly>
            </Protected>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Router />
      </AuthProvider>
    </ToastProvider>
  );
}
