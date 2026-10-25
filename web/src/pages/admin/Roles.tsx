import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Shell } from '../../Shell';
import type { Binding, Group, PermissionInfo, Role, User } from '../../types';
import { Badge, Icon, Modal, Spinner, useToast } from '../../ui';

interface RolesResponse {
  roles: Role[];
  permissions: PermissionInfo[];
  bindings: Binding[];
}

export function AdminRoles() {
  const { can } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<RolesResponse | null>(null);
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);
  const [bindingOpen, setBindingOpen] = useState(false);

  const load = useCallback(() => {
    api
      .get<RolesResponse>('/api/admin/roles')
      .then(setData)
      .catch((loadError: Error) => toast((loadError as Error).message, 'error'));
  }, [toast]);

  useEffect(load, [load]);

  const removeBinding = async (binding: Binding) => {
    try {
      await api.del(`/api/admin/roles/bindings/${binding.id}`);
      toast('Asignación eliminada', 'ok');
      load();
    } catch (removeError) {
      toast((removeError as Error).message, 'error');
    }
  };

  return (
    <Shell
      section="admin"
      title="Roles y permisos"
      subtitle="Qué puede hacer cada persona. Los grupos LDAP heredan estos roles."
      wide
      actions={
        can('roles.write') ? (
          <>
            <button type="button" className="btn btn-sm" onClick={() => setBindingOpen(true)}>
              <Icon name="layers" /> Vincular grupo
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Nuevo rol
            </button>
          </>
        ) : null
      }
    >
      {!data ? (
        <Spinner />
      ) : (
        <div className="stack" style={{ gap: 22 }}>
          <div className="grid grid-2">
            {data.roles.map((role) => (
              <div className="card" key={role.id}>
                <div className="card-head">
                  <div>
                    <div className="card-title row" style={{ gap: 8 }}>
                      {role.name}
                      {role.isSystem ? <Badge tone="outline">Sistema</Badge> : <Badge>Personalizado</Badge>}
                    </div>
                    <div className="tiny muted mono">{role.key}</div>
                  </div>
                  {can('roles.write') && !role.isSystem ? (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(role)}>
                      <Icon name="edit" /> Editar
                    </button>
                  ) : null}
                </div>
                <div className="card-body stack" style={{ gap: 12 }}>
                  <p className="small muted">{role.description}</p>
                  <div className="row wrap" style={{ gap: 5 }}>
                    {role.permissions.includes('*') ? (
                      <Badge tone="accent">Todos los permisos</Badge>
                    ) : (
                      role.permissions.slice(0, 6).map((permission) => (
                        <span className="chip tiny mono" key={permission}>
                          {permission}
                        </span>
                      ))
                    )}
                    {role.permissions.length > 6 ? (
                      <span className="chip tiny">+{role.permissions.length - 6}</span>
                    ) : null}
                  </div>
                  <div className="small faint">
                    {role.usage.users} usuarios directos · {role.usage.rules} grupos vinculados
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Asignaciones</span>
              <span className="badge">{data.bindings.length}</span>
            </div>
            {data.bindings.length === 0 ? (
              <div className="card-body small muted">Todavía no hay roles asignados.</div>
            ) : (
              <div className="table-wrap" style={{ border: 0, boxShadow: 'none' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Tipo</th>
                      <th>Destinatario</th>
                      <th>Rol</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.bindings.map((binding) => (
                      <tr key={binding.id}>
                        <td>
                          <Badge tone="outline">
                            {binding.subject_type === 'group' ? 'Grupo' : 'Persona'}
                          </Badge>
                        </td>
                        <td className="mono small">{binding.subject_value}</td>
                        <td className="small">{binding.role_name}</td>
                        <td style={{ textAlign: 'right' }}>
                          {can('roles.write') ? (
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              onClick={() => removeBinding(binding)}
                            >
                              <Icon name="x" />
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Matriz de permisos</span>
              <span className="small faint">Los roles de sistema se actualizan con RedLBA</span>
            </div>
            <div className="table-wrap" style={{ border: 0, boxShadow: 'none' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Permiso</th>
                    {data.roles.map((role) => (
                      <th key={role.id}>{role.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.permissions.map((permission) => (
                    <tr key={permission.key}>
                      <td>
                        <div className="small mono">{permission.key}</div>
                        <div className="tiny muted">{permission.description}</div>
                      </td>
                      {data.roles.map((role) => (
                        <td key={role.id} style={{ textAlign: 'center' }}>
                          {role.permissions.includes('*') || role.permissions.includes(permission.key) ? (
                            <span style={{ color: 'var(--ok)' }}>
                              <Icon name="check" size={15} />
                            </span>
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {creating ? (
        <RoleModal
          permissions={data?.permissions ?? []}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            load();
          }}
        />
      ) : null}

      {editing ? (
        <RoleModal
          role={editing}
          permissions={data?.permissions ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      ) : null}

      {bindingOpen ? (
        <BindingModal
          roles={data?.roles ?? []}
          onClose={() => setBindingOpen(false)}
          onSaved={() => {
            setBindingOpen(false);
            load();
          }}
        />
      ) : null}
    </Shell>
  );
}

function RoleModal({
  role,
  permissions,
  onClose,
  onSaved,
}: {
  role?: Role;
  permissions: PermissionInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [key, setKey] = useState(role?.key ?? '');
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<string[]>(role?.permissions ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = [...new Set(permissions.map((permission) => permission.group))];

  const toggle = (permission: string) => {
    setSelected((current) =>
      current.includes(permission)
        ? current.filter((item) => item !== permission)
        : [...current, permission],
    );
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (role) {
        await api.patch(`/api/admin/roles/${role.id}`, { name, description, permissions: selected });
      } else {
        await api.post('/api/admin/roles', { key, name, description, permissions: selected });
      }
      toast(role ? 'Rol actualizado' : 'Rol creado', 'ok');
      onSaved();
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={role ? `Editar ${role.name}` : 'Nuevo rol'}
      subtitle="Marca los permisos que concede este rol."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form="role-form" className="btn btn-primary" disabled={busy}>
            Guardar
          </button>
        </>
      }
    >
      <form id="role-form" onSubmit={onSubmit} className="stack">
        {!role ? (
          <div className="field">
            <label className="label">Clave</label>
            <input
              className="input"
              value={key}
              onChange={(event) => setKey(event.target.value.toLowerCase())}
              placeholder="editor"
              pattern="[a-z][a-z0-9-]{1,38}"
              required
            />
          </div>
        ) : null}
        <div className="field">
          <label className="label">Nombre</label>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} required />
        </div>
        <div className="field">
          <label className="label">Descripción</label>
          <input
            className="input"
            value={description ?? ''}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div className="stack" style={{ gap: 12 }}>
          {groups.map((group) => (
            <div key={group}>
              <div className="tiny muted" style={{ marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {group}
              </div>
              <div className="stack" style={{ gap: 6 }}>
                {permissions
                  .filter((permission) => permission.group === group)
                  .map((permission) => (
                    <label key={permission.key} className="checkbox">
                      <input
                        type="checkbox"
                        checked={selected.includes(permission.key)}
                        onChange={() => toggle(permission.key)}
                      />
                      <span>
                        <span className="mono small">{permission.key}</span>
                        <span className="tiny muted" style={{ display: 'block' }}>
                          {permission.description}
                        </span>
                      </span>
                    </label>
                  ))}
              </div>
            </div>
          ))}
        </div>

        {error ? <div className="alert alert-error">{error}</div> : null}
      </form>
    </Modal>
  );
}

function BindingModal({
  roles,
  onClose,
  onSaved,
}: {
  roles: Role[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');
  const [subjectType, setSubjectType] = useState<'group' | 'user'>('group');
  const [subjectValue, setSubjectValue] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ groups: Group[] }>('/api/admin/groups').then((response) => setGroups(response.groups)).catch(() => undefined);
    api.get<{ users: User[] }>('/api/admin/users?limit=100').then((response) => setUsers(response.users)).catch(() => undefined);
  }, []);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post(`/api/admin/roles/${roleId}/bindings`, { subjectType, subjectValue });
      toast('Rol asignado', 'ok');
      onSaved();
    } catch (saveError) {
      setError((saveError as Error).message);
    }
  };

  return (
    <Modal
      title="Asignar rol"
      subtitle="Vincula un rol a un grupo del directorio o a una persona."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form="binding-form" className="btn btn-primary">
            Asignar
          </button>
        </>
      }
    >
      <form id="binding-form" onSubmit={onSubmit} className="stack">
        <div className="field">
          <label className="label">Rol</label>
          <select className="select" value={roleId} onChange={(event) => setRoleId(event.target.value)}>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="label">Tipo de destinatario</label>
          <select
            className="select"
            value={subjectType}
            onChange={(event) => {
              setSubjectType(event.target.value as 'group' | 'user');
              setSubjectValue('');
            }}
          >
            <option value="group">Grupo (recomendado)</option>
            <option value="user">Persona</option>
          </select>
        </div>
        <div className="field">
          <label className="label">{subjectType === 'group' ? 'Grupo' : 'Persona'}</label>
          <select
            className="select"
            value={subjectValue}
            onChange={(event) => setSubjectValue(event.target.value)}
            required
          >
            <option value="">Selecciona…</option>
            {subjectType === 'group'
              ? groups.map((group) => (
                  <option key={group.id} value={group.name}>
                    {group.name}
                  </option>
                ))
              : users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.displayName} ({user.username})
                  </option>
                ))}
          </select>
        </div>
        {error ? <div className="alert alert-error">{error}</div> : null}
      </form>
    </Modal>
  );
}
