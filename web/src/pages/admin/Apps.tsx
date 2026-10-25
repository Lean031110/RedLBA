import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { Shell } from '../../Shell';
import type { AppInfo } from '../../types';
import { Badge, EmptyState, Icon, Modal, Spinner, Toggle, useToast } from '../../ui';

const ICON_OPTIONS = ['grid', 'mail', 'folder', 'code', 'globe', 'server', 'search', 'users', 'activity'];

export function AdminApps() {
  const toast = useToast();
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [editing, setEditing] = useState<AppInfo | 'new' | null>(null);

  const load = useCallback(() => {
    api
      .get<{ apps: AppInfo[] }>('/api/admin/apps')
      .then((response) => setApps(response.apps))
      .catch((loadError: Error) => toast((loadError as Error).message, 'error'));
  }, [toast]);

  useEffect(load, [load]);

  const toggle = async (app: AppInfo, enabled: boolean) => {
    try {
      await api.patch(`/api/m/apps/${app.id}`, { enabled });
      load();
    } catch (toggleError) {
      toast((toggleError as Error).message, 'error');
    }
  };

  return (
    <Shell
      section="admin"
      title="Aplicaciones"
      subtitle="Los servicios del servidor que aparecen en el portal."
      wide
      actions={
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
          <Icon name="plus" /> Nueva aplicación
        </button>
      }
    >
      {!apps ? (
        <Spinner />
      ) : apps.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="grid"
            title="Catálogo vacío"
            hint="Añade la URL de tu nube, tu correo web, tu Git…"
          />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Aplicación</th>
                <th>URL</th>
                <th>Permiso</th>
                <th>Visible</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => (
                <tr key={app.id}>
                  <td>
                    <div className="row">
                      <span
                        className="app-tile"
                        style={{ width: 30, height: 30, background: app.color ? `${app.color}18` : undefined }}
                      >
                        <Icon name={app.icon} size={15} />
                      </span>
                      <div>
                        <div style={{ fontWeight: 550 }}>{app.name}</div>
                        <div className="tiny muted">{app.description ?? '—'}</div>
                      </div>
                    </div>
                  </td>
                  <td className="small mono truncate" style={{ maxWidth: 240 }}>
                    {app.url}
                  </td>
                  <td className="small">{app.permission ?? '—'}</td>
                  <td>
                    <Toggle
                      checked={app.enabled}
                      onChange={(value) => toggle(app, value)}
                      label={`Publicar ${app.name}`}
                    />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(app)}>
                      <Icon name="edit" /> Editar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing ? (
        <AppModal
          app={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      ) : null}
    </Shell>
  );
}

function AppModal({
  app,
  onClose,
  onSaved,
}: {
  app?: AppInfo;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: app?.name ?? '',
    url: app?.url ?? '',
    description: app?.description ?? '',
    icon: app?.icon ?? 'grid',
    color: app?.color ?? '#d92b3a',
    permission: app?.permission ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (app) {
        await api.patch(`/api/m/apps/${app.id}`, form);
      } else {
        await api.post('/api/m/apps', form);
      }
      toast(app ? 'Aplicación actualizada' : 'Aplicación creada', 'ok');
      onSaved();
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!app) return;
    try {
      await api.del(`/api/m/apps/${app.id}`);
      toast('Aplicación eliminada', 'ok');
      onSaved();
    } catch (removeError) {
      toast((removeError as Error).message, 'error');
    }
  };

  return (
    <Modal
      title={app ? `Editar ${app.name}` : 'Nueva aplicación'}
      onClose={onClose}
      footer={
        <>
          {app ? (
            <button type="button" className="btn btn-danger" onClick={remove}>
              <Icon name="trash" /> Eliminar
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" onClick={onSubmit} disabled={busy}>
            Guardar
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <div className="field">
            <label className="label">Nombre</label>
            <input
              className="input"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              required
            />
          </div>
          <div className="field">
            <label className="label">Icono</label>
            <select
              className="select"
              value={form.icon}
              onChange={(event) => setForm({ ...form, icon: event.target.value })}
            >
              {ICON_OPTIONS.map((icon) => (
                <option key={icon} value={icon}>
                  {icon}
                </option>
              ))}
            </select>
          </div>
          <div className="field span-2">
            <label className="label">URL</label>
            <input
              className="input"
              value={form.url}
              onChange={(event) => setForm({ ...form, url: event.target.value })}
              placeholder="https://nube.tudominio.tld"
              required
            />
          </div>
          <div className="field span-2">
            <label className="label">Descripción</label>
            <input
              className="input"
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </div>
          <div className="field">
            <label className="label">Color</label>
            <input
              className="input"
              type="color"
              value={form.color}
              onChange={(event) => setForm({ ...form, color: event.target.value })}
            />
          </div>
          <div className="field">
            <label className="label">Permiso necesario</label>
            <select
              className="select"
              value={form.permission}
              onChange={(event) => setForm({ ...form, permission: event.target.value })}
            >
              <option value="">Todos los usuarios</option>
              <option value="apps.read">apps.read</option>
              <option value="users.read">users.read</option>
              <option value="mail.read">mail.read</option>
              <option value="admin.access">admin.access</option>
            </select>
          </div>
        </div>
        {error ? <div className="alert alert-error">{error}</div> : null}
        <div className="alert small">
          <Badge tone="outline">Consejo</Badge> Protege la app con <span className="inline-code">forward_auth</span>{' '}
          en Caddy para que use la sesión de RedLBA.
        </div>
      </div>
    </Modal>
  );
}
