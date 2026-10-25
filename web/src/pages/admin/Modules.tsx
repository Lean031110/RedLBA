import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Shell } from '../../Shell';
import type { ModuleInfo } from '../../types';
import { Badge, Icon, Modal, Spinner, Toggle, useToast } from '../../ui';

interface ModulesResponse {
  modules: ModuleInfo[];
  domain: string;
  allowedDomains: string[];
  proxySnippet: string;
}

export function AdminModules() {
  const { can } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<ModulesResponse | null>(null);
  const [editing, setEditing] = useState<ModuleInfo | null>(null);
  const [proxyOpen, setProxyOpen] = useState(false);

  const load = useCallback(() => {
    api
      .get<ModulesResponse>('/api/admin/modules')
      .then(setData)
      .catch((loadError: Error) => toast((loadError as Error).message, 'error'));
  }, [toast]);

  useEffect(load, [load]);

  const toggle = async (module: ModuleInfo, enabled: boolean) => {
    try {
      await api.patch(`/api/admin/modules/${module.key}`, { enabled });
      toast(`${module.name} ${enabled ? 'activado' : 'desactivado'}`, 'ok');
      load();
    } catch (toggleError) {
      toast((toggleError as Error).message, 'error');
    }
  };

  const sync = async () => {
    try {
      await api.post('/api/admin/modules/sync');
      toast('Módulos sincronizados', 'ok');
      load();
    } catch (syncError) {
      toast((syncError as Error).message, 'error');
    }
  };

  return (
    <Shell
      section="admin"
      title="Módulos"
      subtitle="Activa funciones y asígnales su propio dominio. Los cambios se aplican al instante."
      wide
      actions={
        can('modules.manage') ? (
          <>
            <button type="button" className="btn btn-sm" onClick={() => setProxyOpen(true)}>
              <Icon name="globe" /> Configuración de proxy
            </button>
            <button type="button" className="btn btn-sm" onClick={sync}>
              <Icon name="refresh" /> Sincronizar
            </button>
          </>
        ) : null
      }
    >
      {!data ? (
        <Spinner />
      ) : (
        <div className="stack">
          <div className="alert">
            Un módulo con dominio propio se sirve en ese host (por ejemplo{' '}
            <span className="mono">buscar.{data.domain}</span>) y comparte la sesión del portal. Deja
            el dominio vacío para publicarlo bajo la ruta indicada.
          </div>

          <div className="card">
            <div className="list">
              {data.modules.map((module) => (
                <div className="module-row" key={module.key}>
                  <span className="module-icon">
                    <Icon name={module.icon} />
                  </span>
                  <span className="module-meta">
                    <div className="module-name row" style={{ gap: 8 }}>
                      {module.name}
                      {module.adminOnly ? <Badge tone="outline">Solo admin</Badge> : null}
                      {module.enabled ? <Badge tone="ok">Activo</Badge> : <Badge>Inactivo</Badge>}
                    </div>
                    <div className="module-desc">
                      {module.description ?? 'Sin descripción'}
                    </div>
                    <div className="small faint mono" style={{ marginTop: 4 }}>
                      {module.hostname ? `https://${module.hostname}${module.path}` : module.path}
                    </div>
                  </span>
                  {can('modules.manage') ? (
                    <>
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(module)}>
                        <Icon name="edit" /> Editar
                      </button>
                      <Toggle
                        checked={module.enabled}
                        onChange={(value) => toggle(module, value)}
                        label={`Activar ${module.name}`}
                      />
                    </>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Dominios permitidos</span>
              <Badge tone="outline">{data.allowedDomains.join(', ')}</Badge>
            </div>
            <div className="card-body small muted">
              Define <span className="inline-code">ALLOWED_MODULE_DOMAINS</span> en el entorno para
              publicar módulos en dominios externos al principal. Cada módulo necesita además su
              bloque en Caddy.
            </div>
          </div>
        </div>
      )}

      {editing ? (
        <ModuleModal
          module={editing}
          allowedDomains={data?.allowedDomains ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      ) : null}

      {proxyOpen && data ? (
        <Modal
          title="Proxy inverso"
          subtitle="Caddy delante de RedLBA con TLS y sesión compartida."
          size="wide"
          onClose={() => setProxyOpen(false)}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void navigator.clipboard?.writeText(data.proxySnippet);
                  toast('Copiado', 'ok');
                }}
              >
                <Icon name="copy" /> Copiar
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setProxyOpen(false)}>
                Cerrar
              </button>
            </>
          }
        >
          <div className="stack">
            <pre className="code">{data.proxySnippet}</pre>
            <p className="small muted">
              Pega los bloques de los módulos que tengan dominio propio y recarga Caddy
              (<span className="inline-code">caddy reload</span>). El bloque del portal está en{' '}
              <span className="inline-code">deploy/Caddyfile</span>.
            </p>
            <div className="alert small">
              Para proteger otro servicio con el SSO de RedLBA:
              <pre className="code" style={{ marginTop: 8 }}>
{`forward_auth redlba:8080 {
    uri /api/gateway/auth
    copy_headers X-RedLBA-User X-RedLBA-Email X-RedLBA-Roles
}`}
              </pre>
            </div>
          </div>
        </Modal>
      ) : null}
    </Shell>
  );
}

function ModuleModal({
  module,
  allowedDomains,
  onClose,
  onSaved,
}: {
  module: ModuleInfo;
  allowedDomains: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: module.name,
    description: module.description ?? '',
    hostname: module.hostname ?? '',
    path: module.path,
    sort: module.sort,
    adminOnly: module.adminOnly,
    settings: JSON.stringify(module.settings ?? {}, null, 2),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      let settings: unknown = {};
      try {
        settings = JSON.parse(form.settings || '{}');
      } catch {
        throw new Error('El JSON de ajustes no es válido.');
      }
      await api.patch(`/api/admin/modules/${module.key}`, {
        name: form.name,
        description: form.description,
        hostname: form.hostname.trim().toLowerCase(),
        path: form.path,
        sort: form.sort,
        adminOnly: form.adminOnly,
        settings,
      });
      toast('Módulo actualizado', 'ok');
      onSaved();
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Editar ${module.name}`}
      subtitle="El dominio debe pertenecer al servidor o a los dominios permitidos."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" onClick={onSubmit} disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar'}
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
            />
          </div>
          <div className="field">
            <label className="label">Ruta en el portal</label>
            <input
              className="input"
              value={form.path}
              onChange={(event) => setForm({ ...form, path: event.target.value })}
              placeholder="/buscar"
            />
          </div>
          <div className="field span-2">
            <label className="label">Dominio propio (opcional)</label>
            <input
              className="input"
              value={form.hostname}
              onChange={(event) => setForm({ ...form, hostname: event.target.value })}
              placeholder="buscar.tudominio.tld"
            />
            <span className="hint">
              Debe terminar en uno de: {allowedDomains.join(', ')}. Vacío = se sirve en la ruta.
            </span>
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
            <label className="label">Orden</label>
            <input
              className="input"
              type="number"
              value={form.sort}
              onChange={(event) => setForm({ ...form, sort: Number(event.target.value) })}
            />
          </div>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.adminOnly}
                onChange={(event) => setForm({ ...form, adminOnly: event.target.checked })}
              />
              Solo para administradores
            </label>
          </div>
        </div>

        <div className="field">
          <label className="label">Ajustes del módulo (JSON)</label>
          <textarea
            className="textarea mono"
            style={{ minHeight: 120 }}
            value={form.settings}
            onChange={(event) => setForm({ ...form, settings: event.target.value })}
          />
          <span className="hint">
            Ejemplo del buscador: <span className="inline-code">{'{"minChars": 2}'}</span>
          </span>
        </div>

        {error ? <div className="alert alert-error">{error}</div> : null}
      </div>
    </Modal>
  );
}
