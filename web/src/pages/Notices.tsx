import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, formatDate } from '../api';
import { useAuth } from '../auth';
import { Shell } from '../Shell';
import { EmptyState, Icon, Modal, Spinner, useToast } from '../ui';

interface Post {
  id: string;
  title: string;
  body: string;
  author: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export function NoticesPage() {
  const { modules, can } = useAuth();
  const toast = useToast();
  const enabled = modules.some((module) => module.key === 'notices');
  const canWrite = can('notices.write');

  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<null | { id?: string; title: string; body: string; pinned: boolean }>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ posts: Post[] }>('/api/m/notices/posts');
      setPosts(data.posts);
      setError(null);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return posts;
    return posts.filter((post) => `${post.title} ${post.body}`.toLowerCase().includes(term));
  }, [posts, filter]);

  const save = async () => {
    if (!editing) return;
    if (!editing.title.trim() || !editing.body.trim()) {
      toast('El título y el texto son obligatorios.', 'error');
      return;
    }
    setBusy(true);
    try {
      if (editing.id) {
        await api.patch(`/api/m/notices/posts/${editing.id}`, editing);
        toast('Aviso actualizado.', 'ok');
      } else {
        await api.post('/api/m/notices/posts', editing);
        toast('Aviso publicado.', 'ok');
      }
      setEditing(null);
      await load();
    } catch (saveError) {
      toast((saveError as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (post: Post) => {
    if (!window.confirm(`¿Eliminar el aviso «${post.title}»?`)) return;
    try {
      await api.del(`/api/m/notices/posts/${post.id}`);
      toast('Aviso eliminado.', 'ok');
      await load();
    } catch (removeError) {
      toast((removeError as Error).message, 'error');
    }
  };

  if (!enabled) {
    return (
      <Shell title="Tablón" subtitle="Avisos de la intranet.">
        <div className="card">
          <EmptyState
            icon="megaphone"
            title="El tablón está desactivado"
            hint="Un administrador puede activarlo desde Administración → Módulos."
          />
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      title="Tablón de avisos"
      subtitle="Comunicados del servidor, disponibles sin conexión a internet."
      actions={
        canWrite ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setEditing({ title: '', body: '', pinned: false })}
          >
            <Icon name="plus" /> Nuevo aviso
          </button>
        ) : null
      }
    >
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 10 }}>
          <input
            className="input"
            placeholder="Filtrar avisos"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      </div>

      {error ? (
        <div className="alert alert-error">{error}</div>
      ) : loading ? (
        <Spinner />
      ) : visible.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="megaphone"
            title={filter ? 'Sin resultados' : 'No hay avisos todavía'}
            hint={filter ? 'Prueba con otra palabra.' : 'Publica el primer comunicado de la intranet.'}
            action={
              canWrite && !filter ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setEditing({ title: '', body: '', pinned: false })}
                >
                  <Icon name="plus" /> Nuevo aviso
                </button>
              ) : null
            }
          />
        </div>
      ) : (
        <div className="stack">
          {visible.map((post) => (
            <article className={`card ${post.pinned ? 'notice-pinned' : ''}`} key={post.id}>
              <div className="card-head">
                <div>
                  <div className="card-title">
                    {post.pinned ? <span className="badge badge-accent">Fijado</span> : null} {post.title}
                  </div>
                  <div className="small muted">
                    {post.author} · {formatDate(post.createdAt, true)}
                    {post.updatedAt !== post.createdAt ? ' · editado' : ''}
                  </div>
                </div>
                {canWrite ? (
                  <div className="row" style={{ gap: 6 }}>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Editar"
                      onClick={() =>
                        setEditing({
                          id: post.id,
                          title: post.title,
                          body: post.body,
                          pinned: post.pinned,
                        })
                      }
                    >
                      <Icon name="edit" size={16} />
                    </button>
                    <button type="button" className="icon-btn" title="Eliminar" onClick={() => void remove(post)}>
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="card-body">
                <p className="notice-body">{post.body}</p>
              </div>
            </article>
          ))}
        </div>
      )}

      {editing ? (
        <Modal
          title={editing.id ? 'Editar aviso' : 'Nuevo aviso'}
          onClose={() => setEditing(null)}
          size="wide"
          footer={
            <div className="row-between">
              <label className="checkbox row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={editing.pinned}
                  onChange={(event) => setEditing({ ...editing, pinned: event.target.checked })}
                />
                <span className="small">Fijar arriba del tablón</span>
              </label>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={() => setEditing(null)}>
                  Cancelar
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
                  {busy ? 'Guardando…' : 'Guardar'}
                </button>
              </div>
            </div>
          }
        >
          <div className="stack">
            <label className="field">
              <span className="label">Título</span>
              <input
                className="input"
                value={editing.title}
                autoFocus
                onChange={(event) => setEditing({ ...editing, title: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="label">Texto</span>
              <textarea
                className="textarea"
                rows={10}
                value={editing.body}
                onChange={(event) => setEditing({ ...editing, body: event.target.value })}
              />
            </label>
          </div>
        </Modal>
      ) : null}
    </Shell>
  );
}
