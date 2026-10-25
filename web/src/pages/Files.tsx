import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatDate } from '../api';
import { useAuth } from '../auth';
import { Shell } from '../Shell';
import { EmptyState, Icon, Spinner, useToast } from '../ui';

interface Entry {
  name: string;
  type: 'file' | 'dir';
  size: number;
  mtime: string;
}

interface Listing {
  path: string;
  parent: string;
  entries: Entry[];
  usageMb: number;
  sharedMb: number;
  quotaMb: number;
  maxUploadMb: number;
}

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

export function FilesPage() {
  const { modules, user, can } = useAuth();
  const toast = useToast();
  const enabled = modules.some((module) => module.key === 'files');
  const personalRoot = user ? `u/${user.id}` : 'shared';

  const [path, setPath] = useState('shared');
  const [data, setData] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (target: string) => {
    setLoading(true);
    try {
      const result = await api.get<Listing>(
        `/api/m/files/list?path=${encodeURIComponent(target)}`,
      );
      setData(result);
      setError(null);
    } catch (loadError) {
      setData(null);
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void load(path);
  }, [enabled, path, load]);

  const go = (target: string) => {
    setPath(target);
  };

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    let count = 0;
    try {
      for (const file of Array.from(files)) {
        const target = encodeURIComponent(joinPath(path, file.name));
        await api.upload(
          `/api/m/files/upload?x=${Date.now()}`,
          file,
          {
            'X-File-Path': target,
            'Content-Type': 'application/octet-stream',
          },
        );
        count += 1;
      }
      toast(count === 1 ? 'Fichero subido.' : `${count} ficheros subidos.`, 'ok');
      await load(path);
    } catch (uploadError) {
      toast((uploadError as Error).message, 'error');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const mkdir = async () => {
    const name = window.prompt('Nombre de la carpeta:');
    if (!name?.trim()) return;
    try {
      await api.post('/api/m/files/mkdir', { path: joinPath(path, name.trim()) });
      toast('Carpeta creada.', 'ok');
      await load(path);
    } catch (mkdirError) {
      toast((mkdirError as Error).message, 'error');
    }
  };

  const renameEntry = async (entry: Entry) => {
    const name = window.prompt('Nuevo nombre:', entry.name);
    if (!name?.trim() || name.trim() === entry.name) return;
    try {
      await api.post('/api/m/files/rename', {
        from: joinPath(path, entry.name),
        to: joinPath(path, name.trim()),
      });
      toast('Renombrado.', 'ok');
      await load(path);
    } catch (renameError) {
      toast((renameError as Error).message, 'error');
    }
  };

  const removeEntry = async (entry: Entry) => {
    const kind = entry.type === 'dir' ? 'carpeta y todo su contenido' : 'fichero';
    if (!window.confirm(`¿Eliminar ${kind} «${entry.name}»?`)) return;
    try {
      await api.post('/api/m/files/delete', { path: joinPath(path, entry.name) });
      toast('Eliminado.', 'ok');
      await load(path);
    } catch (removeError) {
      toast((removeError as Error).message, 'error');
    }
  };

  if (!enabled) {
    return (
      <Shell title="Archivos" subtitle="Espacio de ficheros del servidor.">
        <div className="card">
          <EmptyState
            icon="file"
            title="El módulo de archivos está desactivado"
            hint="Un administrador puede activarlo desde Administración → Módulos."
          />
        </div>
      </Shell>
    );
  }

  const segments = path.split('/').filter(Boolean);
  const inShared = path === 'shared' || path.startsWith('shared/');
  const canDeleteShared = can('files.manage');

  return (
    <Shell
      title="Archivos"
      subtitle="Carpetas personales y compartidas de la intranet, sin internet."
      wide
      actions={
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-sm" onClick={() => void mkdir()}>
            <Icon name="folder" /> Nueva carpeta
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            <Icon name="upload" /> {busy ? 'Subiendo…' : 'Subir'}
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => void upload(event.target.files)}
          />
        </div>
      }
    >
      <div className="files-layout">
        <aside className="card files-side">
          <button
            type="button"
            className={`folder-item ${path === 'shared' || path.startsWith('shared/') ? 'active' : ''}`}
            onClick={() => go('shared')}
          >
            <Icon name="users" size={16} />
            <span className="folder-name">Compartido</span>
            <span className="tiny faint">{data?.sharedMb ?? 0} MB</span>
          </button>
          <button
            type="button"
            className={`folder-item ${path.startsWith(personalRoot) ? 'active' : ''}`}
            onClick={() => go(personalRoot)}
          >
            <Icon name="user" size={16} />
            <span className="folder-name">Mis archivos</span>
            <span className="tiny faint">
              {data?.usageMb ?? 0}/{data?.quotaMb ?? 0} MB
            </span>
          </button>
          <div className="tiny muted" style={{ marginTop: 10, padding: '0 8px' }}>
            {inShared
              ? 'Cualquier persona del servidor puede leer y escribir aquí. El borrado requiere permiso de gestión.'
              : 'Tu carpeta personal: solo tú (y los administradores) podéis verla.'}
          </div>
        </aside>

        <section className="card files-main">
          <div className="mail-toolbar">
            <nav className="row grow" style={{ gap: 4, alignItems: 'center' }}>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => go('shared')}>
                Archivos
              </button>
              {segments.map((segment, index) => {
                const target = segments.slice(0, index + 1).join('/');
                return (
                  <span key={target} className="row" style={{ gap: 4 }}>
                    <Icon name="chevronRight" size={13} />
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => go(target)}>
                      {segment === 'shared' ? 'Compartido' : segment === 'u' ? 'Mis archivos' : segment}
                    </button>
                  </span>
                );
              })}
            </nav>
            <span className="small muted nowrap">
              {data ? `${data.entries.length} elementos` : ''}
            </span>
          </div>

          {error ? (
            <div className="alert alert-error" style={{ margin: 14 }}>
              {error}
            </div>
          ) : loading ? (
            <Spinner />
          ) : !data?.entries.length ? (
            <EmptyState
              icon="file"
              title="Carpeta vacía"
              hint="Sube ficheros o crea una carpeta para empezar."
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th style={{ width: 110 }}>Tamaño</th>
                    <th style={{ width: 160 }}>Modificado</th>
                    <th style={{ width: 130 }} />
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((entry) => {
                    const full = joinPath(path, entry.name);
                    const removable = inShared ? canDeleteShared : true;
                    return (
                      <tr key={entry.name}>
                        <td>
                          <button
                            type="button"
                            className="row files-name"
                            style={{ gap: 8 }}
                            onClick={() => (entry.type === 'dir' ? go(full) : undefined)}
                            disabled={entry.type === 'file'}
                          >
                            <Icon name={entry.type === 'dir' ? 'folder' : 'file'} size={16} />
                            <span className="truncate">{entry.name}</span>
                          </button>
                        </td>
                        <td className="small muted">{entry.type === 'dir' ? '—' : formatBytes(entry.size)}</td>
                        <td className="small muted">{formatDate(entry.mtime, true)}</td>
                        <td>
                          <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                            {entry.type === 'file' ? (
                              <a
                                className="icon-btn"
                                title="Descargar"
                                href={`/api/m/files/download?path=${encodeURIComponent(full)}`}
                              >
                                <Icon name="download" size={16} />
                              </a>
                            ) : null}
                            <button
                              type="button"
                              className="icon-btn"
                              title="Renombrar"
                              onClick={() => void renameEntry(entry)}
                            >
                              <Icon name="edit" size={16} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              title="Eliminar"
                              onClick={() => void removeEntry(entry)}
                              disabled={!removable}
                            >
                              <Icon name="trash" size={16} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </Shell>
  );
}
