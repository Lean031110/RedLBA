import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Shell } from '../Shell';
import type { SearchResult } from '../types';
import { EmptyState, Icon, Spinner } from '../ui';

interface SearchResponse {
  query: string;
  minChars: number;
  providers: string[];
  results: SearchResult[];
  took: number;
}

export function SearchPage() {
  const { modules } = useAuth();
  const [params, setParams] = useSearchParams();
  const initial = params.get('q') ?? '';
  const [query, setQuery] = useState(initial);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState('all');
  const inputRef = useRef<HTMLInputElement>(null);

  const minChars = 2;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const search = params.get('q')?.trim() ?? '';
    setQuery(search);
    if (search.length < minChars) {
      setData(null);
      return;
    }

    let cancelled = false;
    const timeout = setTimeout(() => {
      setLoading(true);
      api
        .get<SearchResponse>(`/api/m/search/query?q=${encodeURIComponent(search)}`)
        .then((response) => {
          if (!cancelled) {
            setData(response);
            setError(null);
          }
        })
        .catch((loadError: Error) => {
          if (!cancelled) setError(loadError.message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [params]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const next = query.trim();
    if (next.length >= minChars) setParams({ q: next });
  };

  const providers = data?.providers ?? [];
  const labels = useMemo(() => {
    const map: Record<string, string> = { all: 'Todo' };
    for (const provider of providers) {
      const module = modules.find((item) => item.key === provider);
      map[provider] =
        { directory: 'Personas', apps: 'Aplicaciones', search: 'Módulos', mail: 'Correo' }[provider] ??
        module?.name ??
        provider;
    }
    return map;
  }, [providers, modules]);

  const results = (data?.results ?? []).filter(
    (result) => active === 'all' || result.module === active,
  );

  return (
    <Shell
      title="Buscador"
      subtitle="Un solo campo para encontrar personas, aplicaciones y accesos del servidor."
      wide
    >
      <div className="stack" style={{ gap: 18 }}>
        <form onSubmit={onSubmit} className="search-hero">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Escribe al menos 2 letras…"
            aria-label="Buscar"
          />
          {query ? (
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                setQuery('');
                setParams({});
                inputRef.current?.focus();
              }}
              aria-label="Limpiar"
            >
              <Icon name="x" size={15} />
            </button>
          ) : (
            <span className="kbd">Enter</span>
          )}
        </form>

        {error ? <div className="alert alert-error">{error}</div> : null}

        {!data && !loading ? (
          <div className="card">
            <EmptyState
              icon="search"
              title="Busca en todo tu espacio"
              hint="Prueba con un nombre, un cargo, una aplicación o el nombre de un módulo."
            />
          </div>
        ) : null}

        {loading && !data ? <Spinner label="Buscando…" /> : null}

        {data ? (
          <div className="search-panel">
            <div className="search-tabs">
              {Object.entries(labels).map(([key, label]) => {
                const count =
                  key === 'all'
                    ? data.results.length
                    : data.results.filter((result) => result.module === key).length;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`search-tab ${active === key ? 'active' : ''}`}
                    onClick={() => setActive(key)}
                  >
                    {label} <span className="faint">{count}</span>
                  </button>
                );
              })}
              <span className="search-tab" style={{ marginLeft: 'auto', cursor: 'default' }}>
                {data.results.length} resultados · {data.took} ms
              </span>
            </div>

            {results.length === 0 ? (
              <EmptyState
                icon="search"
                title={`Sin resultados para «${data.query}»`}
                hint="Revisa la ortografía o prueba con menos palabras."
              />
            ) : (
              results.map((result) => <ResultRow key={result.id} result={result} />)
            )}
          </div>
        ) : null}
      </div>
    </Shell>
  );
}

function ResultRow({ result }: { result: SearchResult }) {
  const content = (
    <>
      <span className="result-icon">
        <Icon name={result.icon ?? 'search'} />
      </span>
      <span className="result-main">
        <div className="result-title">{result.title}</div>
        {result.subtitle ? <div className="result-sub">{result.subtitle}</div> : null}
      </span>
      {result.badge ? <span className="badge badge-outline">{result.badge}</span> : null}
      <Icon name={result.href.startsWith('http') ? 'external' : 'chevronRight'} size={15} />
    </>
  );

  if (result.href.startsWith('http')) {
    return (
      <a className="result" href={result.href} target="_blank" rel="noreferrer">
        {content}
      </a>
    );
  }

  return (
    <Link className="result" to={result.href}>
      {content}
    </Link>
  );
}
