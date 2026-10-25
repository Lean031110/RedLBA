import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Shell } from '../../Shell';
import type { LdapHealth } from '../../types';
import { Badge, Icon, Spinner, useToast } from '../../ui';

interface SettingsResponse {
  settings: {
    siteName: string;
    siteTagline: string;
    supportEmail: string;
    passwordMinLength: number;
    mailMaxPerUser: number;
    registrationEnabled: boolean;
  };
  env: {
    domain: string;
    baseUrl: string;
    version: string;
    authMode: string;
    cookieDomain: string | null;
    ldap: {
      configured: boolean;
      url: string;
      bindDn: string;
      baseDn: string;
      usersBase: string;
      groupsBase: string;
      userAttr: string;
      healthy: boolean;
      latencyMs: number;
      error?: string;
    };
    mail: {
      driver: string;
      domain: string;
      defaultQuotaMb: number;
      aliasesEnabled: boolean;
    };
  };
}

export function AdminSettings() {
  const { can } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<SettingsResponse['settings'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [ldap, setLdap] = useState<LdapHealth | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(() => {
    api
      .get<SettingsResponse>('/api/admin/settings')
      .then((response) => {
        setData(response);
        setForm(response.settings);
      })
      .catch((loadError: Error) => toast((loadError as Error).message, 'error'));
  }, [toast]);

  useEffect(load, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    try {
      await api.patch('/api/admin/settings', form);
      toast('Ajustes guardados', 'ok');
    } catch (saveError) {
      toast((saveError as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const testLdap = async () => {
    try {
      const health = await api.post<LdapHealth>('/api/admin/settings/ldap/test');
      setLdap(health);
      toast(health.ok ? `LDAP correcto (${health.latencyMs} ms)` : 'LDAP sin conexión', health.ok ? 'ok' : 'error');
    } catch (testError) {
      toast((testError as Error).message, 'error');
    }
  };

  const syncLdap = async () => {
    setSyncing(true);
    try {
      const result = await api.post<{ users: number; groups: number; orphaned: number }>(
        '/api/admin/settings/ldap/sync',
      );
      toast(`Sincronizado: ${result.users} usuarios, ${result.groups} grupos`, 'ok');
      load();
    } catch (syncError) {
      toast((syncError as Error).message, 'error');
    } finally {
      setSyncing(false);
    }
  };

  if (!data || !form) {
    return (
      <Shell section="admin" title="Ajustes">
        <Spinner />
      </Shell>
    );
  }

  const ldapState = ldap ?? {
    ok: data.env.ldap.healthy,
    configured: data.env.ldap.configured,
    latencyMs: data.env.ldap.latencyMs,
    error: data.env.ldap.error,
  };

  return (
    <Shell
      section="admin"
      title="Ajustes"
      subtitle="Identidad del portal, directorio y correo. Los secretos viven en el entorno, no aquí."
      wide
    >
      <div className="split">
        <form className="card" onSubmit={save}>
          <div className="card-head">
            <span className="card-title">Portal</span>
            <Badge tone="outline">v{data.env.version}</Badge>
          </div>
          <div className="card-body stack">
            <div className="form-grid">
              <div className="field">
                <label className="label">Nombre del portal</label>
                <input
                  className="input"
                  value={form.siteName}
                  onChange={(event) => setForm({ ...form, siteName: event.target.value })}
                />
              </div>
              <div className="field">
                <label className="label">Correo de soporte</label>
                <input
                  className="input"
                  value={form.supportEmail}
                  onChange={(event) => setForm({ ...form, supportEmail: event.target.value })}
                />
              </div>
              <div className="field span-2">
                <label className="label">Lema</label>
                <input
                  className="input"
                  value={form.siteTagline}
                  onChange={(event) => setForm({ ...form, siteTagline: event.target.value })}
                />
              </div>
              <div className="field">
                <label className="label">Longitud mínima de contraseña</label>
                <input
                  className="input"
                  type="number"
                  min={8}
                  max={64}
                  value={form.passwordMinLength}
                  onChange={(event) =>
                    setForm({ ...form, passwordMinLength: Number(event.target.value) })
                  }
                />
              </div>
              <div className="field">
                <label className="label">Buzones por persona</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={form.mailMaxPerUser}
                  onChange={(event) => setForm({ ...form, mailMaxPerUser: Number(event.target.value) })}
                />
                <span className="hint">0 = sin límite</span>
              </div>
            </div>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.registrationEnabled}
                onChange={(event) =>
                  setForm({ ...form, registrationEnabled: event.target.checked })
                }
              />
              Permitir autorregistro de cuentas (no recomendado en servidores públicos)
            </label>

            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="submit" className="btn btn-primary" disabled={busy || !can('settings.write')}>
                {busy ? 'Guardando…' : 'Guardar ajustes'}
              </button>
            </div>
            {!can('settings.write') ? (
              <div className="alert small">
                Necesitas el permiso <span className="inline-code">settings.write</span> para guardar.
              </div>
            ) : null}
          </div>
        </form>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <span className="card-title">Directorio LDAP</span>
              <Badge tone={ldapState.configured ? (ldapState.ok ? 'ok' : 'danger') : 'warn'}>
                {ldapState.configured ? (ldapState.ok ? 'Conectado' : 'Sin conexión') : 'Sin configurar'}
              </Badge>
            </div>
            <div className="card-body stack" style={{ gap: 10 }}>
              <Row label="URL" value={data.env.ldap.url || '—'} mono />
              <Row label="Bind DN" value={data.env.ldap.bindDn || '—'} mono />
              <Row label="Base" value={data.env.ldap.baseDn} mono />
              <Row label="Usuarios" value={data.env.ldap.usersBase} mono />
              <Row label="Grupos" value={data.env.ldap.groupsBase} mono />
              <Row label="Atributo de login" value={data.env.ldap.userAttr} mono />
              <Row label="Modo" value={data.env.authMode} />
              {ldapState.error ? <div className="alert alert-warn small">{ldapState.error}</div> : null}
              <div className="row">
                <button type="button" className="btn btn-sm" onClick={testLdap}>
                  <Icon name="refresh" /> Probar conexión
                </button>
                {can('users.write') ? (
                  <button type="button" className="btn btn-sm" onClick={syncLdap} disabled={syncing}>
                    {syncing ? 'Sincronizando…' : 'Importar usuarios'}
                  </button>
                ) : null}
              </div>
              <p className="hint">
                La configuración se define en <span className="inline-code">.env</span> y se aplica al
                reiniciar. Aquí solo se comprueba y se sincroniza.
              </p>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Servidor</span>
            </div>
            <div className="card-body stack" style={{ gap: 10 }}>
              <Row label="Dominio" value={data.env.domain} />
              <Row label="URL pública" value={data.env.baseUrl} />
              <Row label="Cookie" value={data.env.cookieDomain ?? 'solo host actual'} mono />
              <Row label="Correo" value={`${data.env.mail.driver} · ${data.env.mail.domain}`} />
              <Row label="Cuota por defecto" value={`${data.env.mail.defaultQuotaMb} MB`} />
              <Row label="Alias" value={data.env.mail.aliasesEnabled ? 'activados' : 'desactivados'} />
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Buenas prácticas</span>
              <Icon name="shield" size={16} />
            </div>
            <div className="card-body small muted stack" style={{ gap: 8 }}>
              <p>Publica solo 80/443 y deja RedLBA y LDAP en la red interna.</p>
              <p>Fuerza HTTPS: la cookie de sesión se marca Secure automáticamente.</p>
              <p>Activa el modo LDAP puro cuando el directorio esté estable.</p>
              <p>Rota SECRET_KEY y LDAP_BIND_PASSWORD al menos una vez al año.</p>
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="row-between">
      <span className="small muted">{label}</span>
      <span
        className={`small truncate ${mono ? 'mono' : ''}`}
        style={{ maxWidth: '62%', textAlign: 'right' }}
      >
        {value}
      </span>
    </div>
  );
}
