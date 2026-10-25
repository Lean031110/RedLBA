import { useEffect, useState } from 'react';
import { api, formatDate } from '../../api';
import { Shell } from '../../Shell';
import type { AuditEvent } from '../../types';
import { Badge, EmptyState, Icon, Spinner, useToast } from '../../ui';

interface EventsResponse {
  total: number;
  events: AuditEvent[];
}

export function AdminAudit() {
  const toast = useToast();
  const [data, setData] = useState<EventsResponse | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState('');
  const [page, setPage] = useState(1);
  const limit = 40;

  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  if (result) params.set('result', result);
  params.set('page', String(page));
  params.set('limit', String(limit));

  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => {
      api
        .get<EventsResponse>(`/api/m/audit/events?${params.toString()}`)
        .then((response) => {
          if (!cancelled) setData(response);
        })
        .catch((loadError: Error) => {
          if (!cancelled) toast((loadError as Error).message, 'error');
        });
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, result, page]);

  const pages = data ? Math.max(Math.ceil(data.total / limit), 1) : 1;

  return (
    <Shell
      section="admin"
      title="Auditoría"
      subtitle="Accesos, cambios y errores. Los registros se conservan según AUDIT_RETENTION_DAYS."
      wide
      actions={
        <a className="btn btn-sm" href={`/api/m/audit/events.csv?${params.toString()}`} download>
          <Icon name="download" /> Exportar CSV
        </a>
      }
    >
      <div className="stack">
        <div className="row wrap" style={{ gap: 10 }}>
          <div className="search-hero" style={{ flex: 1, minWidth: 240, boxShadow: 'none' }}>
            <Icon name="search" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="Buscar acción, persona o destino…"
              aria-label="Buscar en auditoría"
              style={{ padding: '11px 0' }}
            />
          </div>
          <select
            className="select"
            value={result}
            onChange={(event) => {
              setResult(event.target.value);
              setPage(1);
            }}
            style={{ width: 170 }}
          >
            <option value="">Todos los resultados</option>
            <option value="ok">Correctos</option>
            <option value="fail">Fallidos</option>
          </select>
        </div>

        {!data ? (
          <Spinner />
        ) : data.events.length === 0 ? (
          <div className="card">
            <EmptyState icon="activity" title="Sin eventos" hint="Ajusta los filtros o espera actividad." />
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Actor</th>
                    <th>Acción</th>
                    <th>Objetivo</th>
                    <th>Resultado</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((event) => (
                    <tr key={event.id} title={event.detail ?? undefined}>
                      <td className="small nowrap">{formatDate(event.at, true)}</td>
                      <td className="small">{event.actor_username ?? 'sistema'}</td>
                      <td className="small mono">{event.action}</td>
                      <td className="small truncate" style={{ maxWidth: 240 }}>
                        {event.target ?? '—'}
                      </td>
                      <td>
                        <Badge tone={event.result === 'fail' ? 'danger' : 'ok'}>
                          {event.result === 'fail' ? 'fallo' : 'ok'}
                        </Badge>
                      </td>
                      <td className="small mono">{event.ip ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="row-between">
              <span className="small faint">
                {data.total} eventos · página {page} de {pages}
              </span>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setPage((current) => Math.max(current - 1, 1))}
                  disabled={page <= 1}
                >
                  Anterior
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setPage((current) => Math.min(current + 1, pages))}
                  disabled={page >= pages}
                >
                  Siguiente
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}
