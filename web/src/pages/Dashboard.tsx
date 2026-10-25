import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, relativeDate } from '../api';
import { useAuth } from '../auth';
import { Shell } from '../Shell';
import type { AppInfo, Mailbox, ModuleInfo, User } from '../types';
import { Avatar, Badge, Icon, Spinner } from '../ui';

interface DashboardData {
  user: User;
  apps: AppInfo[];
  modules: ModuleInfo[];
  stats: Record<string, number>;
  mailboxes: Mailbox[];
  events: Array<{
    id: number;
    at: string;
    actor_username: string | null;
    action: string;
    target: string | null;
    result: string;
  }>;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return 'Buenas noches';
  if (hour < 13) return 'Buenos días';
  if (hour < 20) return 'Buenas tardes';
  return 'Buenas noches';
}

export function Dashboard() {
  const { user, modules, can } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<DashboardData>('/api/portal/dashboard')
      .then(setData)
      .catch((loadError: Error) => setError(loadError.message));
  }, []);

  const searchEnabled = modules.some((module) => module.key === 'search') && can('search.use');
  const directoryEnabled = modules.some((module) => module.key === 'directory');
  const mailEnabled = modules.some((module) => module.key === 'mail');

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim().length > 0) navigate(`/search?q=${encodeURIComponent(query.trim())}`);
  };

  const firstName = user?.firstName || user?.displayName.split(' ')[0] || '';

  return (
    <Shell>
      <div className="stack" style={{ gap: 26 }}>
        <div>
          <div className="row" style={{ gap: 6, marginBottom: 6 }}>
            <span className="badge badge-outline">
              <span className="dot" style={{ color: 'var(--ok)' }} />
              {modules.length} módulos activos
            </span>
            {user?.source === 'ldap' ? <span className="badge">Cuenta LDAP</span> : null}
          </div>
          <h1 className="page-title">
            {greeting()}, {firstName}
          </h1>
          <p className="page-sub">
            Todo tu servidor en un mismo sitio: personas, aplicaciones y accesos.
          </p>
        </div>

        {user?.mustChangePassword ? (
          <div className="alert alert-warn row-between wrap">
            <span>Estás usando una contraseña temporal. Cámbiala para proteger tu cuenta.</span>
            <Link to="/profile" className="btn btn-sm">
              Cambiar contraseña
            </Link>
          </div>
        ) : null}

        {searchEnabled ? (
          <form onSubmit={onSearch} className="search-hero">
            <Icon name="search" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Busca personas, aplicaciones o accesos…"
              aria-label="Buscar en el servidor"
            />
            <span className="kbd">Enter</span>
          </form>
        ) : null}

        {error ? <div className="alert alert-error">{error}</div> : null}

        {data && data.stats && user?.isAdmin ? (
          <div className="grid grid-4">
            <div className="stat">
              <div className="stat-label">Personas activas</div>
              <div className="stat-value">{data.stats.users ?? 0}</div>
              <div className="stat-foot">en el directorio</div>
            </div>
            <div className="stat">
              <div className="stat-label">Grupos</div>
              <div className="stat-value">{data.stats.groups ?? 0}</div>
              <div className="stat-foot">equipos y roles</div>
            </div>
            <div className="stat">
              <div className="stat-label">Aplicaciones</div>
              <div className="stat-value">{data.stats.apps ?? 0}</div>
              <div className="stat-foot">publicadas en el portal</div>
            </div>
            <div className="stat">
              <div className="stat-label">Buzones</div>
              <div className="stat-value">{data.stats.mailboxes ?? 0}</div>
              <div className="stat-foot">aprovisionados</div>
            </div>
          </div>
        ) : null}

        <section>
          <div className="row-between" style={{ marginBottom: 14 }}>
            <h2 className="card-title">Aplicaciones</h2>
            <Link to="/apps" className="small muted row" style={{ gap: 4 }}>
              Ver todas <Icon name="arrowRight" size={13} />
            </Link>
          </div>

          {!data ? (
            <Spinner />
          ) : data.apps.length === 0 ? (
            <div className="card">
              <div className="empty">
                <span className="empty-icon">
                  <Icon name="grid" />
                </span>
                <div className="empty-title">Aún no hay aplicaciones publicadas</div>
                <div className="small">
                  {user?.isAdmin
                    ? 'Añade los servicios de tu servidor desde Administración → Aplicaciones.'
                    : 'Cuando el administrador publique servicios, aparecerán aquí.'}
                </div>
              </div>
            </div>
          ) : (
            <div className="app-grid">
              {data.apps.map((app) => (
                <a key={app.id} className="app-card" href={app.url} target="_blank" rel="noreferrer">
                  <span
                    className="app-tile"
                    style={
                      app.color
                        ? { background: `${app.color}14`, color: app.color }
                        : undefined
                    }
                  >
                    <Icon name={app.icon} />
                  </span>
                  <span className="grow">
                    <div className="app-name">{app.name}</div>
                    <div className="app-desc">{app.description ?? app.url}</div>
                  </span>
                  <Icon name="external" size={14} />
                </a>
              ))}
            </div>
          )}
        </section>

        <div className="split">
          <section className="stack" style={{ gap: 14 }}>
            <div className="row-between">
              <h2 className="card-title">Módulos del servidor</h2>
              {user?.isAdmin ? (
                <Link to="/admin/modules" className="small muted row" style={{ gap: 4 }}>
                  Gestionar <Icon name="arrowRight" size={13} />
                </Link>
              ) : null}
            </div>

            <div className="card">
              <div className="list">
                {modules.map((module) => (
                  <ModuleLink key={module.key} module={module} />
                ))}
                {modules.length === 0 ? (
                  <div className="empty">
                    <span className="empty-icon">
                      <Icon name="puzzle" />
                    </span>
                    <div className="empty-title">No hay módulos activos</div>
                  </div>
                ) : null}
              </div>
            </div>

            {mailEnabled && data?.mailboxes.length ? (
              <div className="card">
                <div className="card-head">
                  <span className="card-title">Tu correo</span>
                  <Badge tone="ok">Activo</Badge>
                </div>
                <div className="list">
                  {data.mailboxes.map((mailbox) => (
                    <div key={mailbox.address} className="list-item">
                      <span className="result-icon">
                        <Icon name="mail" />
                      </span>
                      <span className="list-main">
                        <div className="list-title">{mailbox.address}</div>
                        <div className="list-sub">
                          {(mailbox.quota_mb ?? 0).toLocaleString('es-ES')} MB de cuota
                        </div>
                      </span>
                      <Badge tone={mailbox.status === 'active' ? 'ok' : 'warn'}>
                        {mailbox.status === 'active' ? 'Activo' : 'Suspendido'}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          <section className="stack" style={{ gap: 14 }}>
            <h2 className="card-title">Tu cuenta</h2>
            <div className="card">
              <div className="card-body stack" style={{ gap: 14 }}>
                <div className="row">
                  <Avatar name={user?.displayName ?? 'RedLBA'} src={user?.avatarUrl} size="md" />
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>{user?.displayName}</div>
                    <div className="small muted">{user?.title ?? 'Sin cargo definido'}</div>
                  </div>
                </div>
                <hr className="divider" />
                <div className="stack" style={{ gap: 9 }}>
                  <Row label="Usuario" value={user?.username ?? '—'} />
                  <Row label="Correo" value={user?.email ?? '—'} />
                  <Row
                    label="Roles"
                    value={user?.roles.length ? user.roles.join(', ') : '—'}
                  />
                  <Row
                    label="Último acceso"
                    value={relativeDate(user?.lastLoginAt)}
                  />
                </div>
                <Link to="/profile" className="btn btn-block">
                  Ver mi perfil
                </Link>
              </div>
            </div>

            {user?.isAdmin && data?.events?.length ? (
              <>
                <div className="row-between">
                  <h2 className="card-title">Actividad reciente</h2>
                  <Link to="/admin/audit" className="small muted row" style={{ gap: 4 }}>
                    Auditoría <Icon name="arrowRight" size={13} />
                  </Link>
                </div>
                <div className="card">
                  <div className="list">
                    {data.events.slice(0, 5).map((event) => (
                      <div key={event.id} className="list-item">
                        <span className="result-icon">
                          <Icon name={event.result === 'fail' ? 'alert' : 'activity'} />
                        </span>
                        <span className="list-main">
                          <div className="list-title mono">{event.action}</div>
                          <div className="list-sub">
                            {event.actor_username ?? 'sistema'} · {relativeDate(event.at)}
                          </div>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : null}

            {directoryEnabled ? (
              <Link to="/directory" className="card" style={{ padding: 18 }}>
                <div className="row">
                  <span className="module-icon">
                    <Icon name="users" />
                  </span>
                  <span className="grow">
                    <div className="list-title">Directorio de personas</div>
                    <div className="list-sub">Encuentra a cualquiera del servidor</div>
                  </span>
                  <Icon name="arrowRight" size={15} />
                </div>
              </Link>
            ) : null}
          </section>
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row-between">
      <span className="small muted">{label}</span>
      <span className="small truncate" style={{ maxWidth: '65%', textAlign: 'right' }}>
        {value}
      </span>
    </div>
  );
}

function ModuleLink({ module }: { module: ModuleInfo }) {
  const external = module.url.startsWith('http');
  const content = (
    <>
      <span className="module-icon">
        <Icon name={module.icon} />
      </span>
      <span className="list-main">
        <div className="list-title">{module.name}</div>
        <div className="list-sub">{module.description}</div>
      </span>
      {module.hostname ? <span className="badge badge-outline">{module.hostname}</span> : null}
      <Icon name="arrowRight" size={15} />
    </>
  );

  return external ? (
    <a className="list-item" href={module.url}>
      {content}
    </a>
  ) : (
    <Link className="list-item" to={module.path}>
      {content}
    </Link>
  );
}
