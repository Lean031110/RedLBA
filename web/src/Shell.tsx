import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import { Icon, Avatar } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  permission?: string;
  end?: boolean;
}

const PORTAL_NAV: NavItem[] = [
  { to: '/', label: 'Inicio', icon: 'home', end: true },
  { to: '/search', label: 'Buscador', icon: 'search' },
  { to: '/directory', label: 'Directorio', icon: 'users' },
  { to: '/apps', label: 'Aplicaciones', icon: 'grid' },
  { to: '/mail', label: 'Correo', icon: 'mail' },
  { to: '/notices', label: 'Tablón', icon: 'megaphone' },
  { to: '/files', label: 'Archivos', icon: 'file' },
];

const ADMIN_NAV: NavItem[] = [
  { to: '/admin', label: 'Resumen', icon: 'activity', end: true },
  { to: '/admin/users', label: 'Personas', icon: 'users', permission: 'users.read' },
  { to: '/admin/groups', label: 'Grupos', icon: 'layers', permission: 'groups.read' },
  { to: '/admin/roles', label: 'Roles y permisos', icon: 'shield', permission: 'roles.read' },
  { to: '/admin/modules', label: 'Módulos', icon: 'puzzle', permission: 'modules.read' },
  { to: '/admin/apps', label: 'Aplicaciones', icon: 'grid', permission: 'apps.manage' },
  { to: '/admin/mail', label: 'Correo', icon: 'mail', permission: 'mail.read' },
  { to: '/admin/audit', label: 'Auditoría', icon: 'activity', permission: 'audit.read' },
  { to: '/admin/settings', label: 'Ajustes', icon: 'settings', permission: 'settings.read' },
];

export function Shell({
  title,
  subtitle,
  actions,
  children,
  section = 'portal',
  wide = false,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  section?: 'portal' | 'admin';
  wide?: boolean;
}) {
  const { user, modules, can, logout, boot } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = section === 'admin';

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [location.pathname]);

  const moduleKeys = new Set(modules.map((module) => module.key));
  const portalNav = PORTAL_NAV.filter((item) => {
    if (item.to === '/search') return moduleKeys.has('search') && can('search.use');
    if (item.to === '/directory') return moduleKeys.has('directory') && can('users.read');
    if (item.to === '/apps') return can('apps.read');
    if (item.to === '/mail') return moduleKeys.has('mail');
    if (item.to === '/notices') return moduleKeys.has('notices');
    if (item.to === '/files') return moduleKeys.has('files');
    return true;
  });

  const adminNav = ADMIN_NAV.filter((item) => !item.permission || can(item.permission));

  const items = isAdmin ? adminNav : portalNav;
  const brandHref = isAdmin ? '/admin' : '/';

  const onLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link to={brandHref} className="brand">
          <span className="brand-mark">R</span>
          <span>
            <span className="brand-name">{boot?.site.name ?? 'RedLBA'}</span>
            <div className="brand-sub">{isAdmin ? 'Administración' : boot?.site.domain ?? ''}</div>
          </span>
        </Link>

        <nav className="nav">
          {isAdmin ? (
            <>
              <Link to="/" className="nav-item">
                <Icon name="arrowRight" />
                Volver al portal
              </Link>
              <div className="nav-section">Administración</div>
            </>
          ) : (
            <div className="nav-section">Espacio de trabajo</div>
          )}

          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <Icon name={item.icon} />
              {item.label}
            </NavLink>
          ))}

          {!isAdmin && user?.isAdmin ? (
            <>
              <div className="nav-section">Sistema</div>
              <Link to="/admin" className="nav-item">
                <Icon name="shield" />
                Administración
              </Link>
            </>
          ) : null}
        </nav>

        <div className="sidebar-foot">
          <Link to="/profile" className="userchip">
            <Avatar name={user?.displayName ?? 'RedLBA'} src={user?.avatarUrl} size="sm" />
            <span className="userchip-meta">
              <div className="userchip-name">{user?.displayName}</div>
              <div className="userchip-role">{user?.title ?? 'Mi cuenta'}</div>
            </span>
            <Icon name="chevronRight" size={14} />
          </Link>
          <button type="button" className="nav-item" onClick={onLogout}>
            <Icon name="logout" />
            Cerrar sesión
          </button>
        </div>
      </aside>

      <div className="main">
        <nav className="mobile-nav">
          {(isAdmin ? adminNav : portalNav).slice(0, 6).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <header className="topbar">
          <div className="topbar-context">
            <span>{isAdmin ? 'Administración' : 'Portal'}</span>
            <Icon name="chevronRight" size={13} />
            <span className="topbar-title">{title ?? (isAdmin ? 'Panel' : 'Inicio')}</span>
          </div>
          <div className="topbar-actions">
            {actions}
            <Link to={isAdmin ? '/' : '/admin'} className="icon-btn" title={isAdmin ? 'Ir al portal' : 'Administración'}>
              <Icon name={isAdmin ? 'home' : 'settings'} />
            </Link>
          </div>
        </header>

        <main className={`content ${wide ? 'content-wide' : ''}`}>
          {title || subtitle ? (
            <div className="page-head" style={{ marginBottom: 22 }}>
              <div>
                {title ? <h1 className="page-title">{title}</h1> : null}
                {subtitle ? <p className="page-sub">{subtitle}</p> : null}
              </div>
            </div>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head" style={{ marginBottom: 20 }}>
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="row wrap">{actions}</div> : null}
    </div>
  );
}
