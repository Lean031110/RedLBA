import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, relativeDate } from '../../api';
import { Shell } from '../../Shell';
import type { AuditEvent, LdapHealth, ModuleInfo } from '../../types';
import { Badge, Icon, Spinner, Toggle, useToast } from '../../ui';

interface OverviewData {
  stats: Record<string, number>;
  ldap: LdapHealth;
  events: AuditEvent[];
  modules: ModuleInfo[];
  config: {
    version: string;
    domain: string;
    baseUrl: string;
    authMode: string;
    mailDriver: string;
    mailDomain: string;
    cookieDomain: string | null;
  };
}

export function AdminOverview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const load = () => {
    api
      .get<OverviewData>('/api/admin/overview')
      .then(setData)
      .catch((loadError: Error) => setError(loadError.message));
  };

  useEffect(load, []);

  const toggleModule = async (module: ModuleInfo, enabled: boolean) => {
    try {
      await api.patch(`/api/admin/modules/${module.key}`, { enabled });
      toast(`${module.name}: ${enabled ? 'activado' : 'desactivado'}`, 'ok');
      load();
    } catch (toggleError) {
      toast((toggleError as Error).message, 'error');
    }
  };

  return (
    <Shell section="admin" title="Resumen" subtitle="Estado general de RedLBA y del servidor." wide>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {!data ? (
        <Spinner />
      ) : (
        <div className="stack" style={{ gap: 22 }}>
          <div className="grid grid-4">
            <div className="stat">
              <div className="stat-label">Personas</div>
              <div className="stat-value">{data.stats.users}</div>
              <div className="stat-foot">
                <Link to="/admin/users">Gestionar →</Link>
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Grupos</div>
              <div className="stat-value">{data.stats.groups}</div>
              <div className="stat-foot">
                <Link to="/admin/groups">Ver grupos →</Link>
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Módulos activos</div>
              <div className="stat-value">{data.stats.modules}</div>
              <div className="stat-foot">
                <Link to="/admin/modules">Configurar →</Link>
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Sesiones abiertas</div>
              <div className="stat-value">{data.stats.sessions}</div>
              <div className="stat-foot">{data.stats.events} eventos registrados</div>
            </div>
          </div>

          <div className="split">
            <div className="stack">
              <div className="card">
                <div className="card-head">
                  <span className="card-title">Módulos</span>
                  <Link to="/admin/modules" className="small muted">
                    Todos
                  </Link>
                </div>
                <div>
                  {data.modules.map((module) => (
                    <div key={module.key} className="module-row">
                      <span className="module-icon">
                        <Icon name={module.icon} />
                      </span>
                      <span className="module-meta">
                        <div className="module-name">{module.name}</div>
                        <div className="module-desc">
                          {module.hostname ? module.hostname : module.path}
                        </div>
                      </span>
                      <Toggle
                        checked={module.enabled}
                        onChange={(value) => toggleModule(module, value)}
                        label={`Activar ${module.name}`}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <span className="card-title">Actividad reciente</span>
                  <Link to="/admin/audit" className="small muted">
                    Auditoría
                  </Link>
                </div>
                <div className="list">
                  {data.events.slice(0, 8).map((event) => (
                    <div className="list-item" key={event.id}>
                      <span className="result-icon">
                        <Icon name={event.result === 'fail' ? 'alert' : 'activity'} />
                      </span>
                      <span className="list-main">
                        <div className="list-title mono">{event.action}</div>
                        <div className="list-sub">
                          {event.actor_username ?? 'sistema'}
                          {event.target ? ` · ${event.target}` : ''} · {relativeDate(event.at)}
                        </div>
                      </span>
                      <Badge tone={event.result === 'fail' ? 'danger' : 'ok'}>
                        {event.result === 'fail' ? 'fallo' : 'ok'}
                      </Badge>
                    </div>
                  ))}
                  {data.events.length === 0 ? (
                    <div className="empty">
                      <div className="empty-title">Sin actividad todavía</div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="stack">
              <div className="card">
                <div className="card-head">
                  <span className="card-title">Directorio</span>
                  <Badge tone={data.ldap.configured ? (data.ldap.ok ? 'ok' : 'danger') : 'warn'}>
                    {data.ldap.configured ? (data.ldap.ok ? 'Conectado' : 'Sin conexión') : 'Sin configurar'}
                  </Badge>
                </div>
                <div className="card-body stack" style={{ gap: 10 }}>
                  <div className="row-between">
                    <span className="small muted">Modo de autenticación</span>
                    <span className="small mono">{data.config.authMode}</span>
                  </div>
                  <div className="row-between">
                    <span className="small muted">Latencia</span>
                    <span className="small">{data.ldap.latencyMs} ms</span>
                  </div>
                  {data.ldap.error ? (
                    <div className="alert alert-warn small">{data.ldap.error}</div>
                  ) : null}
                  <Link to="/admin/settings" className="btn btn-sm btn-block">
                    <Icon name="settings" /> Ajustes de LDAP
                  </Link>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <span className="card-title">Instalación</span>
                  <span className="badge badge-outline">v{data.config.version}</span>
                </div>
                <div className="card-body stack" style={{ gap: 10 }}>
                  <Row label="Dominio" value={data.config.domain} />
                  <Row label="URL pública" value={data.config.baseUrl} />
                  <Row label="Cookie" value={data.config.cookieDomain ?? 'solo host actual'} />
                  <Row label="Correo" value={`${data.config.mailDriver} · ${data.config.mailDomain}`} />
                </div>
              </div>

              <div className="card">
                <div className="card-body stack">
                  <div className="row">
                    <span className="module-icon">
                      <Icon name="shield" />
                    </span>
                    <div className="grow">
                      <div className="list-title">SSO para tus servicios</div>
                      <div className="list-sub">
                        Caddy + forward_auth valida la sesión en cualquier sitio del servidor.
                      </div>
                    </div>
                  </div>
                  <Link to="/admin/modules" className="btn btn-sm btn-block">
                    Ver configuración de proxy
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row-between">
      <span className="small muted">{label}</span>
      <span className="small truncate mono" style={{ maxWidth: '62%', textAlign: 'right' }}>
        {value}
      </span>
    </div>
  );
}
