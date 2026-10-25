import { useEffect, useState, type FormEvent } from 'react';
import { api, formatDate, relativeDate } from '../api';
import { useAuth } from '../auth';
import { Shell } from '../Shell';
import type { SessionInfo, User } from '../types';
import { Avatar, Badge, Icon, Spinner, useToast } from '../ui';

interface ProfileResponse {
  user: User;
  groups: string[];
  sessions: SessionInfo[];
}

export function Profile() {
  const { reload, user: sessionUser } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    displayName: '',
    title: '',
    department: '',
    phone: '',
    bio: '',
    avatarUrl: '',
    profileVisibility: 'organization',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [password, setPassword] = useState({ current: '', next: '', repeat: '' });
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const load = () => {
    api
      .get<ProfileResponse>('/api/profile')
      .then((response) => {
        setData(response);
        setForm({
          firstName: response.user.firstName ?? '',
          lastName: response.user.lastName ?? '',
          displayName: response.user.displayName ?? '',
          title: response.user.title ?? '',
          department: response.user.department ?? '',
          phone: response.user.phone ?? '',
          bio: response.user.bio ?? '',
          avatarUrl: response.user.avatarUrl ?? '',
          profileVisibility: response.user.profileVisibility,
        });
      })
      .catch((loadError: Error) => setError(loadError.message));
  };

  useEffect(load, []);

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.patch('/api/profile', form);
      toast('Perfil actualizado', 'ok');
      await reload();
      load();
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onChangePassword = async (event: FormEvent) => {
    event.preventDefault();
    setPasswordError(null);
    if (password.next !== password.repeat) {
      setPasswordError('Las contraseñas nuevas no coinciden.');
      return;
    }
    setPasswordBusy(true);
    try {
      await api.post('/api/auth/password', {
        currentPassword: password.current,
        newPassword: password.next,
      });
      setPassword({ current: '', next: '', repeat: '' });
      toast('Contraseña actualizada. Las demás sesiones se cerraron.', 'ok');
      if (sessionUser) await reload();
    } catch (changeError) {
      setPasswordError((changeError as Error).message);
    } finally {
      setPasswordBusy(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await api.del(`/api/sessions/${id}`);
      toast('Sesión cerrada', 'ok');
      load();
    } catch (revokeError) {
      toast((revokeError as Error).message, 'error');
    }
  };

  if (!data) {
    return (
      <Shell title="Mi perfil">
        {error ? <div className="alert alert-error">{error}</div> : <Spinner />}
      </Shell>
    );
  }

  return (
    <Shell title="Mi perfil" subtitle="Tus datos en el directorio del servidor.">
      <div className="split">
        <div className="stack">
          <form className="card" onSubmit={onSave}>
            <div className="card-head">
              <span className="card-title">Datos personales</span>
              <span className="badge badge-outline">
                {data.user.source === 'ldap' ? 'Sincronizado con LDAP' : 'Cuenta local'}
              </span>
            </div>
            <div className="card-body stack">
              <div className="row" style={{ gap: 16 }}>
                <Avatar
                  name={form.displayName || data.user.displayName}
                  src={form.avatarUrl || null}
                  size="lg"
                />
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{form.displayName || data.user.displayName}</div>
                  <div className="small muted">{data.user.email ?? 'Sin correo'}</div>
                  <div className="small faint mono" style={{ marginTop: 4 }}>
                    {data.user.username}
                  </div>
                </div>
              </div>

              <div className="form-grid">
                <div className="field">
                  <label className="label">Nombre</label>
                  <input
                    className="input"
                    value={form.firstName}
                    onChange={(event) => setForm({ ...form, firstName: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="label">Apellidos</label>
                  <input
                    className="input"
                    value={form.lastName}
                    onChange={(event) => setForm({ ...form, lastName: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="label">Nombre visible</label>
                  <input
                    className="input"
                    value={form.displayName}
                    onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="label">Cargo</label>
                  <input
                    className="input"
                    value={form.title}
                    onChange={(event) => setForm({ ...form, title: event.target.value })}
                    placeholder="Administradora de sistemas"
                  />
                </div>
                <div className="field">
                  <label className="label">Departamento</label>
                  <input
                    className="input"
                    value={form.department}
                    onChange={(event) => setForm({ ...form, department: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="label">Teléfono</label>
                  <input
                    className="input"
                    value={form.phone}
                    onChange={(event) => setForm({ ...form, phone: event.target.value })}
                  />
                </div>
                <div className="field span-2">
                  <label className="label">URL del avatar</label>
                  <input
                    className="input"
                    value={form.avatarUrl}
                    onChange={(event) => setForm({ ...form, avatarUrl: event.target.value })}
                    placeholder="https://…"
                  />
                  <span className="hint">Se usa una imagen externa; no se suben ficheros.</span>
                </div>
                <div className="field span-2">
                  <label className="label">Sobre mí</label>
                  <textarea
                    className="textarea"
                    value={form.bio}
                    onChange={(event) => setForm({ ...form, bio: event.target.value })}
                    placeholder="Una línea sobre tu trabajo"
                  />
                </div>
                <div className="field span-2">
                  <label className="label">Visibilidad del perfil</label>
                  <select
                    className="select"
                    value={form.profileVisibility}
                    onChange={(event) => setForm({ ...form, profileVisibility: event.target.value })}
                  >
                    <option value="public">Público: nombre, cargo y correo</option>
                    <option value="organization">Organización: añade departamento y teléfono</option>
                    <option value="private">Privado: solo nombre y correo</option>
                  </select>
                </div>
              </div>

              {error ? <div className="alert alert-error">{error}</div> : null}

              <div className="row-between">
                <span className="small faint">
                  Los cambios se propagan al directorio si tu cuenta es LDAP.
                </span>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Guardando…' : 'Guardar cambios'}
                </button>
              </div>
            </div>
          </form>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <span className="card-title">Cuenta</span>
              <Badge tone="ok">Activa</Badge>
            </div>
            <div className="card-body stack" style={{ gap: 10 }}>
              <div className="row-between">
                <span className="small muted">Usuario</span>
                <span className="small mono">{data.user.username}</span>
              </div>
              <div className="row-between">
                <span className="small muted">Correo</span>
                <span className="small">{data.user.email ?? '—'}</span>
              </div>
              <div className="row-between">
                <span className="small muted">Roles</span>
                <span className="small">{data.user.roles.join(', ') || '—'}</span>
              </div>
              <div className="row-between">
                <span className="small muted">Grupos</span>
                <span className="small truncate" style={{ maxWidth: '60%' }}>
                  {data.groups.join(', ') || '—'}
                </span>
              </div>
              <div className="row-between">
                <span className="small muted">Alta</span>
                <span className="small">{formatDate(data.user.createdAt)}</span>
              </div>
              <div className="row-between">
                <span className="small muted">Último acceso</span>
                <span className="small">{relativeDate(data.user.lastLoginAt)}</span>
              </div>
            </div>
          </div>

          <form className="card" onSubmit={onChangePassword}>
            <div className="card-head">
              <span className="card-title">Contraseña</span>
              <Icon name="lock" size={16} />
            </div>
            <div className="card-body stack">
              <div className="field">
                <label className="label">Contraseña actual</label>
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={password.current}
                  onChange={(event) => setPassword({ ...password, current: event.target.value })}
                  required
                />
              </div>
              <div className="field">
                <label className="label">Nueva contraseña</label>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={password.next}
                  onChange={(event) => setPassword({ ...password, next: event.target.value })}
                  required
                />
                <span className="hint">Mínimo 10 caracteres, con letras y números o símbolos.</span>
              </div>
              <div className="field">
                <label className="label">Repite la nueva contraseña</label>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={password.repeat}
                  onChange={(event) => setPassword({ ...password, repeat: event.target.value })}
                  required
                />
              </div>
              {passwordError ? <div className="alert alert-error">{passwordError}</div> : null}
              <button type="submit" className="btn btn-block" disabled={passwordBusy}>
                {passwordBusy ? 'Actualizando…' : 'Cambiar contraseña'}
              </button>
              <span className="small faint">
                Se cerrarán las demás sesiones abiertas. Tu sesión actual se mantiene.
              </span>
            </div>
          </form>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Sesiones activas</span>
              <span className="badge">{data.sessions.length}</span>
            </div>
            <div className="list">
              {data.sessions.map((session) => (
                <div className="list-item" key={session.id}>
                  <span className="result-icon">
                    <Icon name="server" />
                  </span>
                  <span className="list-main">
                    <div className="list-title">{session.ip ?? 'IP desconocida'}</div>
                    <div className="list-sub">
                      Inicio {relativeDate(session.createdAt)} · caduca{' '}
                      {formatDate(session.expiresAt, true)}
                    </div>
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => revoke(session.id)}
                  >
                    Cerrar
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}
