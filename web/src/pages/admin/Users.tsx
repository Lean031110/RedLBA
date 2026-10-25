import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, formatDate, relativeDate } from '../../api';
import { useAuth } from '../../auth';
import { Shell } from '../../Shell';
import type { Mailbox, Role, SessionInfo, User } from '../../types';
import { Avatar, Badge, EmptyState, Icon, Modal, Spinner, useToast } from '../../ui';

interface UsersResponse {
  users: User[];
  total: number;
  availableGroups: string[];
}

interface UserDetailResponse {
  user: User;
  sessions: SessionInfo[];
  mailboxes: Mailbox[];
  roleBindings: Array<{ id: string; role_id: string; key: string; name: string }>;
}

export function AdminUsers() {
  const { can } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<UsersResponse | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    if (status) params.set('status', status);
    api
      .get<UsersResponse>(`/api/admin/users?${params.toString()}`)
      .then((response) => {
        setData(response);
        setError(null);
      })
      .catch((loadError: Error) => setError(loadError.message));
  }, [query, status]);

  useEffect(() => {
    const timeout = setTimeout(load, 180);
    return () => clearTimeout(timeout);
  }, [load]);

  useEffect(() => {
    if (!can('roles.read')) return;
    api
      .get<{ roles: Role[] }>('/api/admin/roles')
      .then((response) => setRoles(response.roles))
      .catch(() => undefined);
  }, [can]);

  return (
    <Shell
      section="admin"
      title="Personas"
      subtitle="Cuentas del servidor, sus grupos y sus permisos."
      wide
      actions={
        can('users.write') ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Nueva persona
          </button>
        ) : null
      }
    >
      <div className="stack">
        <div className="row wrap" style={{ gap: 10 }}>
          <div className="search-hero" style={{ flex: 1, minWidth: 240, boxShadow: 'none' }}>
            <Icon name="search" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por nombre, usuario o correo…"
              aria-label="Buscar personas"
              style={{ padding: '11px 0' }}
            />
          </div>
          <select className="select" value={status} onChange={(event) => setStatus(event.target.value)} style={{ width: 180 }}>
            <option value="">Todos los estados</option>
            <option value="active">Activas</option>
            <option value="disabled">Desactivadas</option>
            <option value="orphaned">Huérfanas</option>
          </select>
          <button type="button" className="btn" onClick={load}>
            <Icon name="refresh" /> Actualizar
          </button>
        </div>

        {error ? <div className="alert alert-error">{error}</div> : null}

        {!data ? (
          <Spinner />
        ) : data.users.length === 0 ? (
          <div className="card">
            <EmptyState
              icon="users"
              title="Sin resultados"
              hint="Crea una persona o ajusta los filtros."
            />
          </div>
        ) : (
          <>
            <div className="small faint">
              {data.total} {data.total === 1 ? 'persona' : 'personas'}
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Persona</th>
                    <th>Usuario</th>
                    <th>Grupos</th>
                    <th>Roles</th>
                    <th>Estado</th>
                    <th>Acceso</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((user) => (
                    <tr key={user.id} onClick={() => setDetailId(user.id)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div className="row">
                          <Avatar name={user.displayName} src={user.avatarUrl} size="sm" />
                          <div>
                            <div style={{ fontWeight: 550 }}>{user.displayName}</div>
                            <div className="tiny muted">{user.email ?? 'sin correo'}</div>
                          </div>
                        </div>
                      </td>
                      <td className="mono">{user.username}</td>
                      <td className="small muted truncate" style={{ maxWidth: 180 }}>
                        {user.groups?.join(', ') || '—'}
                      </td>
                      <td className="small">{user.roles.join(', ') || '—'}</td>
                      <td>
                        <Badge
                          tone={
                            user.status === 'active' ? 'ok' : user.status === 'disabled' ? 'danger' : 'warn'
                          }
                        >
                          {user.status === 'active' ? 'Activa' : user.status === 'disabled' ? 'Desactivada' : 'Huérfana'}
                        </Badge>
                      </td>
                      <td className="small muted">{relativeDate(user.lastLoginAt)}</td>
                      <td>
                        <Icon name="chevronRight" size={15} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {creating ? (
        <CreateUserModal
          groups={data?.availableGroups ?? []}
          roles={roles}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
            toast('Persona creada', 'ok');
          }}
        />
      ) : null}

      {detailId ? (
        <UserDetailModal
          userId={detailId}
          groups={data?.availableGroups ?? []}
          roles={roles}
          onClose={() => setDetailId(null)}
          onChanged={load}
        />
      ) : null}
    </Shell>
  );
}

/* ----------------------------------------------------------------- create */

function CreateUserModal({
  groups,
  roles,
  onClose,
  onCreated,
}: {
  groups: string[];
  roles: Role[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    username: '',
    email: '',
    title: '',
    department: '',
    phone: '',
    source: 'ldap',
    groups: [] as string[],
    roles: ['user'] as string[],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ tempPassword?: string; warnings: string[] } | null>(null);

  const toggle = (key: 'groups' | 'roles', value: string) => {
    setForm((current) => ({
      ...current,
      [key]: current[key].includes(value)
        ? current[key].filter((item) => item !== value)
        : [...current[key], value],
    }));
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await api.post<{ tempPassword?: string; warnings: string[] }>(
        '/api/admin/users',
        {
          ...form,
          email: form.email || undefined,
          username: form.username.toLowerCase().trim(),
        },
      );
      setResult(response);
    } catch (createError) {
      setError((createError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Nueva persona"
      subtitle="Se crea en LDAP si está disponible; si no, como cuenta local."
      onClose={result ? onCreated : onClose}
      footer={
        result ? (
          <button type="button" className="btn btn-primary" onClick={onCreated}>
            Cerrar
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" form="create-user" className="btn btn-primary" disabled={busy}>
              {busy ? 'Creando…' : 'Crear persona'}
            </button>
          </>
        )
      }
    >
      {result ? (
        <div className="stack">
          <div className="alert alert-ok">La cuenta se creó correctamente.</div>
          {result.tempPassword ? (
            <>
              <div className="small muted">
                Contraseña temporal (se muestra una sola vez, entrégala por un canal seguro):
              </div>
              <div className="row">
                <code className="inline-code" style={{ fontSize: 14, padding: '8px 12px', flex: 1 }}>
                  {result.tempPassword}
                </code>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(result.tempPassword ?? '');
                  }}
                >
                  <Icon name="copy" /> Copiar
                </button>
              </div>
              <div className="hint">
                El usuario deberá cambiarla en su primer acceso desde Mi perfil.
              </div>
            </>
          ) : null}
          {result.warnings.map((warning) => (
            <div className="alert alert-warn small" key={warning}>
              {warning}
            </div>
          ))}
        </div>
      ) : (
        <form id="create-user" onSubmit={onSubmit} className="stack">
          <div className="form-grid">
            <div className="field">
              <label className="label">Nombre</label>
              <input
                className="input"
                value={form.firstName}
                onChange={(event) => setForm({ ...form, firstName: event.target.value })}
                required
              />
            </div>
            <div className="field">
              <label className="label">Apellidos</label>
              <input
                className="input"
                value={form.lastName}
                onChange={(event) => setForm({ ...form, lastName: event.target.value })}
                required
              />
            </div>
            <div className="field">
              <label className="label">Usuario</label>
              <input
                className="input"
                value={form.username}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
                placeholder="ana.ruiz"
                pattern="[a-z0-9][a-z0-9._-]{2,31}"
                required
              />
              <span className="hint">Minúsculas, sin espacios. Será su login.</span>
            </div>
            <div className="field">
              <label className="label">Correo</label>
              <input
                className="input"
                type="email"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                placeholder="(se genera automáticamente)"
              />
            </div>
            <div className="field">
              <label className="label">Cargo</label>
              <input
                className="input"
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
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
            <div className="field span-2">
              <label className="label">Origen de la cuenta</label>
              <select
                className="select"
                value={form.source}
                onChange={(event) => setForm({ ...form, source: event.target.value })}
              >
                <option value="ldap">LDAP (recomendado)</option>
                <option value="local">Solo RedLBA</option>
              </select>
            </div>
          </div>

          {groups.length ? (
            <div className="field">
              <label className="label">Grupos</label>
              <div className="row wrap" style={{ gap: 6 }}>
                {groups.map((group) => (
                  <button
                    key={group}
                    type="button"
                    className={`chip ${form.groups.includes(group) ? 'badge-accent' : ''}`}
                    onClick={() => toggle('groups', group)}
                  >
                    {form.groups.includes(group) ? <Icon name="check" size={12} /> : null}
                    {group}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="field">
            <label className="label">Roles</label>
            <div className="row wrap" style={{ gap: 6 }}>
              {roles
                .filter((role) => !role.isSystem || role.key !== 'owner')
                .map((role) => (
                  <button
                    key={role.key}
                    type="button"
                    className={`chip ${form.roles.includes(role.key) ? 'badge-accent' : ''}`}
                    onClick={() => toggle('roles', role.key)}
                  >
                    {form.roles.includes(role.key) ? <Icon name="check" size={12} /> : null}
                    {role.name}
                  </button>
                ))}
            </div>
          </div>

          {error ? <div className="alert alert-error">{error}</div> : null}
        </form>
      )}
    </Modal>
  );
}

/* ----------------------------------------------------------------- detail */

function UserDetailModal({
  userId,
  groups,
  roles,
  onClose,
  onChanged,
}: {
  userId: string;
  groups: string[];
  roles: Role[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { can, user: me } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<UserDetailResponse | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    title: '',
    department: '',
    phone: '',
  });
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<UserDetailResponse>(`/api/admin/users/${userId}`)
      .then((response) => {
        setData(response);
        setForm({
          firstName: response.user.firstName ?? '',
          lastName: response.user.lastName ?? '',
          email: response.user.email ?? '',
          title: response.user.title ?? '',
          department: response.user.department ?? '',
          phone: response.user.phone ?? '',
        });
      })
      .catch((loadError: Error) => toast((loadError as Error).message, 'error'));
  }, [userId, toast]);

  useEffect(load, [load]);

  const saveProfile = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/admin/users/${userId}`, form);
      toast('Datos actualizados', 'ok');
      setEditing(false);
      load();
      onChanged();
    } catch (saveError) {
      toast((saveError as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveRoles = async (roleKeys: string[]) => {
    try {
      await api.post(`/api/admin/users/${userId}/roles`, { roles: roleKeys });
      toast('Roles actualizados', 'ok');
      load();
      onChanged();
    } catch (saveError) {
      toast((saveError as Error).message, 'error');
    }
  };

  const saveGroups = async (next: string[]) => {
    try {
      await api.post(`/api/admin/users/${userId}/groups`, { groups: next });
      toast('Grupos actualizados', 'ok');
      load();
      onChanged();
    } catch (saveError) {
      toast((saveError as Error).message, 'error');
    }
  };

  const resetPassword = async () => {
    try {
      const response = await api.post<{ tempPassword?: string }>(
        `/api/admin/users/${userId}/password`,
        {},
      );
      setTempPassword(response.tempPassword ?? null);
      toast('Contraseña restablecida', 'ok');
    } catch (resetError) {
      toast((resetError as Error).message, 'error');
    }
  };

  const toggleStatus = async () => {
    if (!data) return;
    try {
      const path = data.user.status === 'active' ? 'disable' : 'enable';
      await api.post(`/api/admin/users/${userId}/${path}`);
      toast('Estado actualizado', 'ok');
      load();
      onChanged();
    } catch (statusError) {
      toast((statusError as Error).message, 'error');
    }
  };

  const remove = async () => {
    try {
      await api.del(`/api/admin/users/${userId}`);
      toast('Persona eliminada', 'ok');
      onClose();
      onChanged();
    } catch (removeError) {
      toast((removeError as Error).message, 'error');
    }
  };

  const user = data?.user;
  const roleKeys = data?.roleBindings.map((binding) => binding.key) ?? [];

  return (
    <Modal
      title={user?.displayName ?? 'Persona'}
      subtitle={user ? `@${user.username} · ${user.source === 'ldap' ? 'LDAP' : 'local'}` : undefined}
      onClose={onClose}
      footer={
        <>
          {can('users.password') ? (
            <button type="button" className="btn" onClick={resetPassword}>
              <Icon name="key" /> Restablecer contraseña
            </button>
          ) : null}
          {can('users.delete') && user?.id !== me?.id ? (
            <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
              <Icon name="trash" /> Eliminar
            </button>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Cerrar
          </button>
        </>
      }
    >
      {!data || !user ? (
        <Spinner />
      ) : (
        <div className="stack">
          <div className="row" style={{ gap: 14 }}>
            <Avatar name={user.displayName} src={user.avatarUrl} size="md" />
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{user.displayName}</div>
              <div className="small muted">{user.email ?? 'sin correo'}</div>
              <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                <Badge tone={user.status === 'active' ? 'ok' : 'danger'}>
                  {user.status === 'active' ? 'Activa' : user.status === 'disabled' ? 'Desactivada' : 'Huérfana'}
                </Badge>
                <Badge tone="outline">Alta {formatDate(user.createdAt)}</Badge>
                <Badge tone="outline">Último acceso {relativeDate(user.lastLoginAt)}</Badge>
              </div>
            </div>
          </div>

          {tempPassword ? (
            <div className="alert alert-warn stack" style={{ gap: 8 }}>
              <span>Contraseña temporal (se muestra una sola vez):</span>
              <div className="row">
                <code className="inline-code" style={{ flex: 1, fontSize: 14 }}>
                  {tempPassword}
                </code>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void navigator.clipboard?.writeText(tempPassword)}
                >
                  <Icon name="copy" /> Copiar
                </button>
              </div>
            </div>
          ) : null}

          <div className="card">
            <div className="card-head">
              <span className="card-title">Datos</span>
              {can('users.write') && !editing ? (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}>
                  <Icon name="edit" /> Editar
                </button>
              ) : null}
            </div>
            <div className="card-body">
              {editing ? (
                <div className="stack">
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
                      <label className="label">Correo</label>
                      <input
                        className="input"
                        value={form.email}
                        onChange={(event) => setForm({ ...form, email: event.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label className="label">Cargo</label>
                      <input
                        className="input"
                        value={form.title}
                        onChange={(event) => setForm({ ...form, title: event.target.value })}
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
                  </div>
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>
                      Cancelar
                    </button>
                    <button type="button" className="btn btn-sm btn-primary" onClick={saveProfile} disabled={busy}>
                      Guardar
                    </button>
                  </div>
                </div>
              ) : (
                <dl className="kv">
                  <dt>Usuario</dt>
                  <dd className="mono">{user.username}</dd>
                  <dt>Correo</dt>
                  <dd>{user.email ?? '—'}</dd>
                  <dt>Cargo</dt>
                  <dd>{user.title ?? '—'}</dd>
                  <dt>Departamento</dt>
                  <dd>{user.department ?? '—'}</dd>
                  <dt>Teléfono</dt>
                  <dd>{user.phone ?? '—'}</dd>
                </dl>
              )}
            </div>
          </div>

          {can('roles.write') ? (
            <div className="card">
              <div className="card-head">
                <span className="card-title">Roles directos</span>
                <span className="small faint">Se suman a los de sus grupos</span>
              </div>
              <div className="card-body row wrap" style={{ gap: 6 }}>
                {roles.map((role) => {
                  const active = roleKeys.includes(role.key);
                  return (
                    <button
                      key={role.key}
                      type="button"
                      className={`chip ${active ? 'badge-accent' : ''}`}
                      onClick={() =>
                        saveRoles(
                          active ? roleKeys.filter((key) => key !== role.key) : [...roleKeys, role.key],
                        )
                      }
                    >
                      {active ? <Icon name="check" size={12} /> : null}
                      {role.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {can('groups.write') ? (
            <div className="card">
              <div className="card-head">
                <span className="card-title">Grupos</span>
                <span className="small faint">{groups.length} disponibles</span>
              </div>
              <div className="card-body row wrap" style={{ gap: 6 }}>
                {(groups.length ? groups : user.groups ?? []).map((group) => {
                  const active = (user.groups ?? []).includes(group);
                  return (
                    <button
                      key={group}
                      type="button"
                      className={`chip ${active ? 'badge-accent' : ''}`}
                      onClick={() =>
                        saveGroups(
                          active
                            ? (user.groups ?? []).filter((name) => name !== group)
                            : [...(user.groups ?? []), group],
                        )
                      }
                    >
                      {active ? <Icon name="check" size={12} /> : null}
                      {group}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="card">
            <div className="card-head">
              <span className="card-title">Buzones</span>
              <span className="small faint">{data.mailboxes.length}</span>
            </div>
            {data.mailboxes.length ? (
              <div className="list">
                {data.mailboxes.map((mailbox) => (
                  <div className="list-item" key={mailbox.address}>
                    <span className="result-icon">
                      <Icon name="mail" />
                    </span>
                    <span className="list-main">
                      <div className="list-title">{mailbox.address}</div>
                      <div className="list-sub">{(mailbox.quota_mb ?? 0).toLocaleString('es-ES')} MB</div>
                    </span>
                    <Badge tone={mailbox.status === 'active' ? 'ok' : 'warn'}>{mailbox.status}</Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="card-body small muted">Sin buzones asignados.</div>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Sesiones</span>
              <span className="small faint">{data.sessions.length}</span>
            </div>
            {data.sessions.length ? (
              <div className="list">
                {data.sessions.map((session) => (
                  <div className="list-item" key={session.id}>
                    <span className="result-icon">
                      <Icon name="server" />
                    </span>
                    <span className="list-main">
                      <div className="list-title">{session.ip ?? 'IP desconocida'}</div>
                      <div className="list-sub">
                        {relativeDate(session.lastSeenAt)} · caduca {formatDate(session.expiresAt, true)}
                      </div>
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={async () => {
                        await api.del(`/api/admin/sessions/${session.id}`).catch(() => undefined);
                        load();
                      }}
                    >
                      Cerrar
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="card-body small muted">Sin sesiones abiertas.</div>
            )}
          </div>

          {can('users.write') ? (
            <div className="row-between">
              <span className="small muted">
                {user.status === 'active' ? 'La cuenta puede iniciar sesión.' : 'La cuenta está bloqueada.'}
              </span>
              <button
                type="button"
                className={`btn btn-sm ${user.status === 'active' ? 'btn-danger' : ''}`}
                onClick={toggleStatus}
                disabled={user.id === me?.id}
              >
                {user.status === 'active' ? 'Desactivar cuenta' : 'Reactivar cuenta'}
              </button>
            </div>
          ) : null}
        </div>
      )}

      {confirmDelete ? (
        <Modal
          title="Eliminar persona"
          subtitle="Esta acción borra la cuenta y, si es LDAP, también su entrada en el directorio."
          onClose={() => setConfirmDelete(false)}
          size="center"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                Cancelar
              </button>
              <button type="button" className="btn btn-danger" onClick={remove}>
                Eliminar definitivamente
              </button>
            </>
          }
        >
          <div className="alert alert-warn">
            Se cerrarán sus sesiones y se perderán sus asignaciones. No se puede deshacer.
          </div>
        </Modal>
      ) : null}
    </Modal>
  );
}
