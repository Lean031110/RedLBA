import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Shell } from '../../Shell';
import type { Mailbox, User } from '../../types';
import { Badge, EmptyState, Icon, Modal, Spinner, useToast } from '../../ui';

interface MailboxesResponse {
  driver: string;
  domain: string;
  defaults: { quotaMb: number };
  mailboxes: Mailbox[];
}

interface Alias {
  id: string;
  address: string;
  targets: string[];
}

export function AdminMail() {
  const { can } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<MailboxesResponse | null>(null);
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Mailbox | null>(null);
  const [aliasOpen, setAliasOpen] = useState(false);

  const load = useCallback(() => {
    api
      .get<MailboxesResponse>(`/api/m/mail/mailboxes${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`)
      .then(setData)
      .catch((loadError: Error) => toast((loadError as Error).message, 'error'));
    api
      .get<{ aliases: Alias[] }>('/api/m/mail/aliases')
      .then((response) => setAliases(response.aliases))
      .catch(() => undefined);
  }, [query, toast]);

  useEffect(() => {
    const timeout = setTimeout(load, 160);
    return () => clearTimeout(timeout);
  }, [load]);

  const toggleStatus = async (mailbox: Mailbox) => {
    try {
      await api.patch(`/api/m/mail/mailboxes/${encodeURIComponent(mailbox.address)}`, {
        status: mailbox.status === 'active' ? 'suspended' : 'active',
      });
      toast('Buzón actualizado', 'ok');
      load();
    } catch (statusError) {
      toast((statusError as Error).message, 'error');
    }
  };

  const remove = async (mailbox: Mailbox) => {
    try {
      await api.del(`/api/m/mail/mailboxes/${encodeURIComponent(mailbox.address)}`);
      toast('Buzón eliminado', 'ok');
      load();
    } catch (removeError) {
      toast((removeError as Error).message, 'error');
    }
  };

  return (
    <Shell
      section="admin"
      title="Correo"
      subtitle="Buzones aprovisionados en LDAP o en Mailcow. RedLBA no entrega correo: prepara las cuentas."
      wide
      actions={
        can('mail.manage') ? (
          <>
            <button type="button" className="btn btn-sm" onClick={() => setAliasOpen(true)}>
              <Icon name="arrowRight" /> Nuevo alias
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Nuevo buzón
            </button>
          </>
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
              placeholder="Buscar buzón o persona…"
              aria-label="Buscar buzones"
              style={{ padding: '11px 0' }}
            />
          </div>
          {data ? (
            <span className="chip">
              Driver: <span className="mono">{data.driver}</span>
            </span>
          ) : null}
          {data ? <span className="chip">Dominio: {data.domain}</span> : null}
        </div>

        {!data ? (
          <Spinner />
        ) : data.mailboxes.length === 0 ? (
          <div className="card">
            <EmptyState
              icon="mail"
              title="Sin buzones"
              hint="Crea el primero: se añade al usuario en el directorio."
            />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Dirección</th>
                  <th>Persona</th>
                  <th>Cuota</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.mailboxes.map((mailbox) => (
                  <tr key={mailbox.address}>
                    <td className="mono">{mailbox.address}</td>
                    <td className="small">{mailbox.display_name ?? '—'}</td>
                    <td className="small">{(mailbox.quota_mb ?? 0).toLocaleString('es-ES')} MB</td>
                    <td>
                      <Badge tone={mailbox.status === 'active' ? 'ok' : 'warn'}>
                        {mailbox.status === 'active' ? 'Activo' : 'Suspendido'}
                      </Badge>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="actions">
                        <button type="button" className="btn btn-sm" onClick={() => setEditing(mailbox)}>
                          Cuota
                        </button>
                        {can('mail.manage') ? (
                          <>
                            <button type="button" className="btn btn-sm" onClick={() => toggleStatus(mailbox)}>
                              {mailbox.status === 'active' ? 'Suspender' : 'Activar'}
                            </button>
                            <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(mailbox)}>
                              <Icon name="trash" />
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="card">
          <div className="card-head">
            <span className="card-title">Alias</span>
            <span className="small faint">{aliases.length}</span>
          </div>
          {aliases.length ? (
            <div className="list">
              {aliases.map((alias) => (
                <div className="list-item" key={alias.id}>
                  <span className="result-icon">
                    <Icon name="arrowRight" />
                  </span>
                  <span className="list-main">
                    <div className="list-title mono">{alias.address}</div>
                    <div className="list-sub">→ {alias.targets.join(', ')}</div>
                  </span>
                  {can('mail.manage') ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={async () => {
                        await api.del(`/api/m/mail/aliases/${alias.id}`).catch(() => undefined);
                        load();
                      }}
                    >
                      <Icon name="x" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="card-body small muted">Sin alias configurados.</div>
          )}
        </div>
      </div>

      {creating && data ? (
        <CreateMailbox
          domain={data.domain}
          defaultQuota={data.defaults.quotaMb}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            load();
          }}
        />
      ) : null}

      {editing ? (
        <QuotaModal
          mailbox={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      ) : null}

      {aliasOpen ? (
        <AliasModal
          domain={data?.domain ?? ''}
          onClose={() => setAliasOpen(false)}
          onSaved={() => {
            setAliasOpen(false);
            load();
          }}
        />
      ) : null}
    </Shell>
  );
}

function CreateMailbox({
  domain,
  defaultQuota,
  onClose,
  onSaved,
}: {
  domain: string;
  defaultQuota: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [userId, setUserId] = useState('');
  const [address, setAddress] = useState('');
  const [quota, setQuota] = useState(defaultQuota);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ users: User[] }>('/api/admin/users?limit=100&status=active')
      .then((response) => {
        setUsers(response.users);
        const first = response.users[0];
        if (first) {
          setUserId(first.id);
          setAddress(`${first.username}@${domain}`);
        }
      })
      .catch(() => undefined);
  }, [domain]);

  const pickUser = (id: string) => {
    setUserId(id);
    const user = users.find((item) => item.id === id);
    if (user) setAddress(`${user.username}@${domain}`);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await api.post<{ password?: string; warnings: string[] }>(
        '/api/m/mail/mailboxes',
        { userId, address, quotaMb: quota },
      );
      if (response.password) setPassword(response.password);
      response.warnings.forEach((warning) => toast(warning, 'info'));
      if (!response.password) {
        toast('Buzón creado', 'ok');
        onSaved();
      }
    } catch (createError) {
      setError((createError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Nuevo buzón"
      onClose={onSaved}
      footer={
        password ? (
          <button type="button" className="btn btn-primary" onClick={onSaved}>
            Cerrar
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" form="mailbox-form" className="btn btn-primary" disabled={busy}>
              {busy ? 'Creando…' : 'Crear buzón'}
            </button>
          </>
        )
      }
    >
      {password ? (
        <div className="stack">
          <div className="alert alert-ok">Buzón creado. Guarda la contraseña temporal:</div>
          <code className="inline-code" style={{ fontSize: 15, padding: 10 }}>
            {password}
          </code>
        </div>
      ) : (
        <form id="mailbox-form" onSubmit={onSubmit} className="stack">
          <div className="field">
            <label className="label">Persona</label>
            <select className="select" value={userId} onChange={(event) => pickUser(event.target.value)} required>
              <option value="">Selecciona…</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName} ({user.username})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label">Dirección</label>
            <input
              className="input mono"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label className="label">Cuota (MB)</label>
            <input
              className="input"
              type="number"
              min={256}
              value={quota}
              onChange={(event) => setQuota(Number(event.target.value))}
            />
          </div>
          {error ? <div className="alert alert-error">{error}</div> : null}
        </form>
      )}
    </Modal>
  );
}

function QuotaModal({
  mailbox,
  onClose,
  onSaved,
}: {
  mailbox: Mailbox;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [quota, setQuota] = useState(mailbox.quota_mb ?? 5120);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/m/mail/mailboxes/${encodeURIComponent(mailbox.address)}`, {
        quotaMb: quota,
      });
      toast('Cuota actualizada', 'ok');
      onSaved();
    } catch (saveError) {
      toast((saveError as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Cuota de ${mailbox.address}`}
      onClose={onClose}
      size="center"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
            Guardar
          </button>
        </>
      }
    >
      <div className="field">
        <label className="label">Cuota en MB</label>
        <input
          className="input"
          type="number"
          min={256}
          value={quota}
          onChange={(event) => setQuota(Number(event.target.value))}
        />
      </div>
    </Modal>
  );
}

function AliasModal({
  domain,
  onClose,
  onSaved,
}: {
  domain: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [address, setAddress] = useState('');
  const [targets, setTargets] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/m/mail/aliases', {
        address,
        targets: targets
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      });
      toast('Alias creado', 'ok');
      onSaved();
    } catch (createError) {
      setError((createError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Nuevo alias"
      subtitle={`Ejemplo: ventas@${domain} → ana@${domain}, luis@${domain}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form="alias-form" className="btn btn-primary" disabled={busy}>
            Crear alias
          </button>
        </>
      }
    >
      <form id="alias-form" onSubmit={onSubmit} className="stack">
        <div className="field">
          <label className="label">Dirección del alias</label>
          <input
            className="input mono"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder={`ventas@${domain}`}
            required
          />
        </div>
        <div className="field">
          <label className="label">Destinos</label>
          <input
            className="input mono"
            value={targets}
            onChange={(event) => setTargets(event.target.value)}
            placeholder={`ana@${domain}, luis@${domain}`}
            required
          />
          <span className="hint">Separados por comas.</span>
        </div>
        {error ? <div className="alert alert-error">{error}</div> : null}
      </form>
    </Modal>
  );
}
