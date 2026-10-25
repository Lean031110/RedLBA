import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Shell } from '../Shell';
import type { AppInfo } from '../types';
import { EmptyState, Icon, Spinner } from '../ui';

export function AppsPage() {
  const { can } = useAuth();
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ apps: AppInfo[] }>('/api/apps')
      .then((response) => setApps(response.apps))
      .catch((loadError: Error) => setError(loadError.message));
  }, []);

  return (
    <Shell
      title="Aplicaciones"
      subtitle="Los servicios de tu servidor, con la misma cuenta y sesión."
      actions={
        can('apps.manage') ? (
          <Link to="/admin/apps" className="btn btn-sm">
            <Icon name="plus" /> Gestionar catálogo
          </Link>
        ) : null
      }
      wide
    >
      {error ? <div className="alert alert-error">{error}</div> : null}
      {!apps ? (
        <Spinner />
      ) : apps.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="grid"
            title="Sin aplicaciones publicadas"
            hint="Añade los servicios del servidor desde el panel de administración."
          />
        </div>
      ) : (
        <div className="app-grid">
          {apps.map((app) => (
            <a key={app.id} className="app-card" href={app.url} target="_blank" rel="noreferrer">
              <span
                className="app-tile"
                style={app.color ? { background: `${app.color}14`, color: app.color } : undefined}
              >
                <Icon name={app.icon} />
              </span>
              <span className="grow">
                <div className="app-name">{app.name}</div>
                <div className="app-desc">{app.description ?? app.url}</div>
                <div className="small faint truncate" style={{ marginTop: 6 }}>
                  {app.url.replace(/^https?:\/\//, '')}
                </div>
              </span>
              <Icon name="external" size={14} />
            </a>
          ))}
        </div>
      )}
    </Shell>
  );
}
