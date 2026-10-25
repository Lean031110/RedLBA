import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Shell } from '../../Shell';
import type { Group, User } from '../../types';
import { Avatar, Badge, EmptyState, Icon, Modal, Spinner, useToast } from '../../ui';

export function AdminGroups() {
  const { can } = useAuth();
  const toast = useToast();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Group | null>(null);

  const load = useCallback(() => {
    api
      .get<{ groups: Group[] }>('/api/admin/groups')
      .then((response) => {
        setGroups(response.groups);
        setSelected((current) =>
          current ? response.groups.find((group) => group.id === current.id) ?? null : null,
        );
      })
      .catch((loadError: Error) => toast((loadError as Error).message, 'error'));
  }, [toast]);

  useEffect(load, [load]);

  return (
    <Shell
      section="admin"
      title="Grupos"
      subtitle="Equipos del directorio. Los grupos pueden heredar roles automáticamente."
      wide
      actions={
        can('groups.write') ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Nuevo grupo
          </button>
        ) : null
      }
    >
      {!groups ? (
        <Spinner />
      ) : groups.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="layers"
            title="Sin grupos"
            hint="Crea un grupo o sincroniza el directorio LDAP."
          />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Grupo</th>
                <th>Origen</th>
                <th>Miembros</th>
                <th>Roles vinculados</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.id} onClick={() => setSelected(group)} style={{ cursor: 'pointer' }}>
                  <td>
                    <div style={{ fontWeight: 550 }}>{group.name}</div>
                    <div className="tiny muted">{group.description ?? 'Sin descripción'}</div>
                  </td>
                  <td>
                    <Badge tone={group.source === 'ldap' ? 'accent' : 'outline'}>
                      {group.source === 'ldap' ? 'LDAP' : 'Local'}
                    </Badge>
                  </td>
                  <td className="small">{group.members.length}</td>
                  <td className="small">
                    {group.roles.length ? group.roles.map((role) => role.name).join(', ') : '—'}
                  </td>
                  <td>
                    <Icon name="chevronRight" size={15} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <CreateGroup
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      ) : null}

      {selected ? (
        <GroupDetail
          group={selected}
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      ) : null}
    </Shell>
  );
}

function CreateGroup({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/admin/groups', { name, description });
      toast('Grupo creado', 'ok');
      onCreated();
    } catch (createError) {
      setError((createError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Nuevo grupo"
      subtitle="Los grupos locales sirven para organizar y heredar roles."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form="create-group" className="btn btn-primary" disabled={busy}>
            Crear grupo
          </button>
        </>
      }
    >
      <form id="create-group" onSubmit={onSubmit} className="stack">
        <div className="field">
          <label className="label">Nombre</label>
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="equipo-sistemas"
            required
          />
          <span className="hint">Sin espacios. Se usa como identificador en LDAP.</span>
        </div>
        <div className="field">
          <label className="label">Descripción</label>
          <input
            className="input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        {error ? <div className="alert alert-error">{error}</div> : null}
      </form>
    </Modal>
  );
}

function GroupDetail({
  group,
  onClose,
  onChanged,
}: {
  group: Group;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState<User[] | null>(null);
  const [adding, setAdding] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    api
      .get<{ users: User[] }>('/api/admin/users?limit=100')
      .then((response) => setUsers(response.users))
      .catch(() => undefined);
  }, []);

  const addMember = async () => {
    if (!adding) return;
    try {
      await api.post(`/api/admin/groups/${group.id}/members`, { userId: adding });
      toast('Miembro añadido', 'ok');
      setAdding('');
      onChanged();
    } catch (addError) {
      toast((addError as Error).message, 'error');
    }
  };

  const removeMember = async (userId: string) => {
    try {
      await api.del(`/api/admin/groups/${group.id}/members/${userId}`);
      toast('Miembro quitado', 'ok');
      onChanged();
    } catch (removeError) {
      toast((removeError as Error).message, 'error');
    }
  };

  const removeGroup = async () => {
    try {
      await api.del(`/api/admin/groups/${group.id}`);
      toast('Grupo eliminado', 'ok');
      onClose();
      onChanged();
    } catch (removeError) {
      toast((removeError as Error).message, 'error');
    }
  };

  const candidates = (users ?? []).filter(
    (user) => !group.members.some((member) => member.id === user.id),
  );

  return (
    <Modal
      title={group.name}
      subtitle={group.description ?? 'Grupo del directorio'}
      onClose={onClose}
      footer={
        <>
          {can('groups.write') && group.source === 'local' ? (
            <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
              <Icon name="trash" /> Eliminar grupo
            </button>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Cerrar
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="row wrap" style={{ gap: 6 }}>
          <Badge tone={group.source === 'ldap' ? 'accent' : 'outline'}>
            {group.source === 'ldap' ? 'Grupo LDAP' : 'Grupo local'}
          </Badge>
          {group.roles.map((role) => (
            <Badge key={role.key} tone="ok">
              Rol: {role.name}
            </Badge>
          ))}
        </div>

        {can('groups.write') ? (
          <div className="row" style={{ gap: 8 }}>
            <select className="select" value={adding} onChange={(event) => setAdding(event.target.value)}>
              <option value="">Añadir persona…</option>
              {candidates.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName} ({user.username})
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-sm" onClick={addMember} disabled={!adding}>
              <Icon name="plus" /> Añadir
            </button>
          </div>
        ) : null}

        <div className="card">
          <div className="card-head">
            <span className="card-title">Miembros</span>
            <span className="small faint">{group.members.length}</span>
          </div>
          {group.members.length ? (
            <div className="list">
              {group.members.map((member) => (
                <div className="list-item" key={member.id}>
                  <Avatar name={member.display_name} size="sm" />
                  <span className="list-main">
                    <div className="list-title">{member.display_name}</div>
                    <div className="list-sub mono">{member.username}</div>
                  </span>
                  {can('groups.write') ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => removeMember(member.id)}
                    >
                      Quitar
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="card-body small muted">Sin miembros todavía.</div>
          )}
        </div>

        <div className="hint">
          Los cambios de pertenencia se escriben en LDAP cuando el grupo es del directorio.
        </div>
      </div>

      {confirmDelete ? (
        <Modal
          title="Eliminar grupo"
          onClose={() => setConfirmDelete(false)}
          size="center"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                Cancelar
              </button>
              <button type="button" className="btn btn-danger" onClick={removeGroup}>
                Eliminar
              </button>
            </>
          }
        >
          <div className="alert alert-warn">
            Se quitará el grupo y sus vínculos de roles. Las personas no se eliminan.
          </div>
        </Modal>
      ) : null}
    </Modal>
  );
}
