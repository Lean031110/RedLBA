import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate } from '../api';
import { useAuth } from '../auth';
import { Shell } from '../Shell';
import type { Mailbox, Person } from '../types';
import { Avatar, Badge, EmptyState, Icon, Spinner } from '../ui';

export function Directory() {
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<Person[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPeople(null);
    const timeout = setTimeout(() => {
      api
        .get<{ people: Person[]; total: number }>(
          `/api/directory?limit=60${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ''}`,
        )
        .then((response) => {
          if (!cancelled) {
            setPeople(response.people);
            setTotal(response.total);
          }
        })
        .catch((loadError: Error) => {
          if (!cancelled) setError(loadError.message);
        });
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [query]);

  return (
    <Shell
      title="Directorio"
      subtitle={`${total} ${total === 1 ? 'persona' : 'personas'} en el servidor.`}
      actions={<span className="badge badge-outline">LDAP como fuente de verdad</span>}
      wide
    >
      <div className="stack">
        <div className="search-hero">
          <Icon name="search" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar por nombre, cargo o departamento…"
            aria-label="Buscar personas"
          />
        </div>

        {error ? <div className="alert alert-error">{error}</div> : null}

        {!people ? (
          <Spinner />
        ) : people.length === 0 ? (
          <div className="card">
            <EmptyState
              icon="users"
              title="No hay coincidencias"
              hint="Prueba con otro nombre o revisa que el directorio esté sincronizado."
            />
          </div>
        ) : (
          <div className="people-grid">
            {people.map((person) => (
              <Link key={person.id} to={`/directory/${person.username}`} className="person-card">
                <Avatar name={person.displayName} src={person.avatarUrl} size="md" />
                <span className="grow">
                  <div className="person-name">{person.displayName}</div>
                  <div className="person-role">{person.title ?? 'Sin cargo'}</div>
                  <div className="small faint truncate" style={{ marginTop: 4 }}>
                    {person.department ?? person.email ?? ''}
                  </div>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}

export function PersonPage() {
  const { username = '' } = useParams();
  const { user } = useAuth();
  const [data, setData] = useState<{ person: Person; mailboxes: Mailbox[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    api
      .get<{ person: Person; mailboxes: Mailbox[] }>(`/api/directory/${encodeURIComponent(username)}`)
      .then(setData)
      .catch((loadError: Error) => setError(loadError.message));
  }, [username]);

  const isSelf = user?.username === username;

  return (
    <Shell title="Ficha de la persona" subtitle="Datos del directorio del servidor.">
      {error ? <div className="alert alert-error">{error}</div> : null}
      {!data ? (
        <Spinner />
      ) : (
        <div className="split">
          <div className="card">
            <div className="card-body stack" style={{ gap: 20 }}>
              <div className="row" style={{ gap: 16 }}>
                <Avatar name={data.person.displayName} src={data.person.avatarUrl} size="lg" />
                <div className="grow">
                  <h2 style={{ fontSize: 22, fontWeight: 640, letterSpacing: '-0.03em' }}>
                    {data.person.displayName}
                  </h2>
                  <div className="muted">{data.person.title ?? 'Sin cargo definido'}</div>
                  <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
                    {data.person.email ? (
                      <a className="chip" href={`mailto:${data.person.email}`}>
                        <Icon name="mail" size={13} />
                        {data.person.email}
                      </a>
                    ) : null}
                    {data.person.department ? (
                      <span className="chip">{data.person.department}</span>
                    ) : null}
                    {data.person.source === 'ldap' ? (
                      <span className="chip">LDAP</span>
                    ) : (
                      <span className="chip">Cuenta local</span>
                    )}
                  </div>
                </div>
                {isSelf ? (
                  <Link to="/profile" className="btn btn-sm">
                    Editar mi perfil
                  </Link>
                ) : null}
              </div>

              {data.person.bio ? <p className="muted small">{data.person.bio}</p> : null}

              <hr className="divider" />

              <dl className="kv">
                <dt>Usuario</dt>
                <dd className="mono">{data.person.username}</dd>
                <dt>Correo</dt>
                <dd>{data.person.email ?? '—'}</dd>
                <dt>Departamento</dt>
                <dd>{data.person.department ?? '—'}</dd>
                <dt>Teléfono</dt>
                <dd>{data.person.phone ?? '—'}</dd>
                <dt>Grupos</dt>
                <dd>
                  {data.person.groups?.length ? (
                    <span className="row wrap" style={{ gap: 6 }}>
                      {data.person.groups.map((group) => (
                        <span key={group} className="chip">
                          {group}
                        </span>
                      ))}
                    </span>
                  ) : (
                    '—'
                  )}
                </dd>
                {data.person.lastLoginAt ? (
                  <>
                    <dt>Último acceso</dt>
                    <dd>{formatDate(data.person.lastLoginAt, true)}</dd>
                  </>
                ) : null}
              </dl>
            </div>
          </div>

          <div className="stack">
            <div className="card">
              <div className="card-head">
                <span className="card-title">Correo</span>
                <Badge tone={data.mailboxes.length ? 'ok' : 'neutral'}>
                  {data.mailboxes.length ? `${data.mailboxes.length} buzón` : 'Sin buzón'}
                </Badge>
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
                        <div className="list-sub">
                          {(mailbox.quota_mb ?? 0).toLocaleString('es-ES')} MB
                        </div>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="card-body small muted">
                  Este usuario todavía no tiene buzón. Un administrador puede crearlo desde
                  Administración → Correo.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}
