import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, formatDate } from '../api';
import { useAuth } from '../auth';
import { Shell } from '../Shell';
import { EmptyState, Icon, Modal, Spinner, useToast } from '../ui';

/* ------------------------------------------------------------------- tipos */

interface MailboxStatus {
  ready: boolean;
  unlocked: boolean;
  requiresPassword: boolean;
  address: string;
  mailboxes: Array<{ address: string; status: string }>;
  identity: { name: string; email: string };
  imap: { host: string; port: number; secure: boolean };
  driver: string;
}

interface FolderInfo {
  path: string;
  name: string;
  specialUse: string | null;
  flags: string[];
  total?: number;
  unseen?: number;
}

interface MessageSummary {
  uid: number;
  subject: string;
  from: { name: string | null; address: string | null };
  to: string[];
  date: string | null;
  seen: boolean;
  flagged: boolean;
  snippet: string;
  hasAttachments: boolean;
}

interface FullMessage extends MessageSummary {
  html: string | null;
  text: string;
  toFull: Array<{ name: string | null; address: string | null }>;
  cc: Array<{ name: string | null; address: string | null }>;
  messageId: string | null;
  inReplyTo: string | null;
}

interface MessagePage {
  messages: MessageSummary[];
  total: number;
  page: number;
  pageSize: number;
}

const BASE = '/api/m/mail';

function senderOf(message: MessageSummary): string {
  return message.from.name || message.from.address || '—';
}

function shortDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  }
  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
  }
  return date.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: '2-digit' });
}

function folderIcon(folder: FolderInfo): string {
  if (folder.specialUse === '\\Trash') return 'trash';
  if (folder.specialUse === '\\Sent') return 'arrowRight';
  if (folder.specialUse === '\\Drafts') return 'edit';
  if (folder.specialUse === '\\Junk') return 'alert';
  if (folder.path === 'INBOX') return 'mail';
  return 'folder';
}

function isLocked(error: unknown): boolean {
  return error instanceof ApiError && (error.data?.error === 'unlock_required' || error.status === 401);
}

/* -------------------------------------------------------------------- página */

export function MailPage() {
  const { modules, can } = useAuth();
  const toast = useToast();
  const enabled = modules.some((module) => module.key === 'mail');

  const [status, setStatus] = useState<MailboxStatus | null>(null);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [folder, setFolder] = useState('INBOX');
  const [pageData, setPageData] = useState<MessagePage | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  const [open, setOpen] = useState<FullMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());

  const [compose, setCompose] = useState<null | {
    to: string;
    cc: string;
    subject: string;
    text: string;
    inReplyTo?: string | null;
  }>(null);

  const [password, setPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  /* ------------------------------------------------------------- cargas */

  const loadFolders = useCallback(async () => {
    try {
      const data = await api.get<{ folders: FolderInfo[] }>(`${BASE}/webmail/folders`);
      setFolders(data.folders);
      setLocked(false);
    } catch (loadError) {
      if (isLocked(loadError)) setLocked(true);
      else setError((loadError as Error).message);
    }
  }, []);

  const loadMessages = useCallback(
    async (targetFolder: string, searchTerm: string, pageNumber = 1) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          folder: targetFolder,
          page: String(pageNumber),
          pageSize: '30',
        });
        if (searchTerm) params.set('q', searchTerm);
        const data = await api.get<MessagePage>(`${BASE}/webmail/messages?${params.toString()}`);
        setPageData((current) =>
          pageNumber > 1 && current
            ? { ...data, messages: [...current.messages, ...data.messages] }
            : data,
        );
        setLocked(false);
      } catch (loadError) {
        if (isLocked(loadError)) setLocked(true);
        else setError((loadError as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    api
      .get<MailboxStatus>(`${BASE}/webmail/status`)
      .then((data) => {
        setStatus(data);
        if (!data.unlocked && data.requiresPassword) {
          setLocked(true);
          setLoading(false);
          return;
        }
        return Promise.all([loadFolders(), loadMessages('INBOX', '')]);
      })
      .catch((loadError: Error) => {
        setError(loadError.message);
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Búsqueda con retardo.
  useEffect(() => {
    if (!enabled || locked) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (query === search) return;
      setSearch(query);
      void loadMessages(folder, query, 1);
    }, 350);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [query, folder, enabled, locked, loadMessages, search]);

  const unlock = async () => {
    if (!password) return;
    setBusy(true);
    setUnlockError(null);
    try {
      await api.post(`${BASE}/webmail/unlock`, { password });
      setPassword('');
      setLocked(false);
      setStatus((current) => (current ? { ...current, unlocked: true } : current));
      toast('Buzón desbloqueado.', 'ok');
      await Promise.all([loadFolders(), loadMessages(folder, search, 1)]);
    } catch (unlockFail) {
      setUnlockError((unlockFail as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const selectFolder = (path: string) => {
    setFolder(path);
    setOpen(null);
    setChecked(new Set());
    void loadMessages(path, search, 1);
    void loadFolders();
  };

  const openMessage = async (message: MessageSummary) => {
    setLoading(true);
    try {
      const data = await api.get<{ message: FullMessage }>(
        `${BASE}/webmail/messages/${message.uid}?folder=${encodeURIComponent(folder)}`,
      );
      setOpen(data.message);
      setPageData((current) =>
        current
          ? {
              ...current,
              messages: current.messages.map((item) =>
                item.uid === message.uid ? { ...item, seen: true } : item,
              ),
            }
          : current,
      );
      if (!message.seen) {
        void api.post(`${BASE}/webmail/flags`, { folder, uids: [message.uid], add: ['\\Seen'] });
        void loadFolders();
      }
    } catch (loadError) {
      if (isLocked(loadError)) setLocked(true);
      else toast((loadError as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, message?: string) => {
    try {
      await fn();
      if (message) toast(message, 'ok');
      setOpen(null);
      setChecked(new Set());
      await Promise.all([loadMessages(folder, search, 1), loadFolders()]);
    } catch (actionError) {
      if (isLocked(actionError)) setLocked(true);
      else toast((actionError as Error).message, 'error');
    }
  };

  const trashFolder = folders.find(
    (item) => item.specialUse === '\\Trash' || /papelera|trash|junk/i.test(item.path),
  );

  const removeMessages = (uids: number[]) => {
    if (uids.length === 0) return;
    const permanent = folder === trashFolder?.path;
    void act(
      () =>
        api.post(`${BASE}/webmail/delete`, {
          folder,
          uids,
          trash: permanent ? null : trashFolder?.path ?? null,
        }),
      permanent ? 'Eliminados definitivamente.' : 'Movidos a la papelera.',
    );
  };

  const moveMessages = (uids: number[], target: string) => {
    if (uids.length === 0) return;
    void act(() => api.post(`${BASE}/webmail/move`, { folder, uids, target }), 'Mensajes movidos.');
  };

  const toggleFlag = async (message: MessageSummary) => {
    try {
      await api.post(`${BASE}/webmail/flags`, {
        folder,
        uids: [message.uid],
        add: message.flagged ? [] : ['\\Flagged'],
        remove: message.flagged ? ['\\Flagged'] : [],
      });
      setPageData((current) =>
        current
          ? {
              ...current,
              messages: current.messages.map((item) =>
                item.uid === message.uid ? { ...item, flagged: !item.flagged } : item,
              ),
            }
          : current,
      );
    } catch (actionError) {
      toast((actionError as Error).message, 'error');
    }
  };

  const toggleChecked = (uid: number) => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  const allChecked = useMemo(
    () => Boolean(pageData?.messages.length) && checked.size === pageData?.messages.length,
    [checked, pageData],
  );

  const sendMail = async () => {
    if (!compose) return;
    setBusy(true);
    try {
      await api.post(`${BASE}/webmail/send`, compose);
      toast('Mensaje enviado.', 'ok');
      setCompose(null);
      await Promise.all([loadFolders(), loadMessages(folder, search, 1)]);
    } catch (sendError) {
      toast((sendError as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    if (!compose) return;
    try {
      await api.post(`${BASE}/webmail/draft`, compose);
      toast('Borrador guardado.', 'ok');
      setCompose(null);
      void loadFolders();
    } catch (draftError) {
      toast((draftError as Error).message, 'error');
    }
  };

  /* -------------------------------------------------------------- pintura */

  if (!enabled) {
    return (
      <Shell title="Correo" subtitle="Tu buzón del servidor.">
        <div className="card">
          <EmptyState
            icon="mail"
            title="El módulo de correo está desactivado"
            hint="Un administrador puede activarlo desde Administración → Módulos."
          />
        </div>
      </Shell>
    );
  }

  const inbox = folders.find((item) => item.path === 'INBOX');
  const unread = inbox?.unseen ?? 0;

  return (
    <Shell
      title="Correo"
      subtitle={
        status?.address
          ? `${status.address}${unread ? ` · ${unread} sin leer` : ''}`
          : 'Tu buzón del servidor'
      }
      actions={
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setCompose({ to: '', cc: '', subject: '', text: '' })}>
            <Icon name="edit" /> Redactar
          </button>
          {can('mail.manage') ? (
            <Link to="/admin/mail" className="btn btn-sm">
              <Icon name="settings" /> Buzones
            </Link>
          ) : null}
        </div>
      }
    >
      {locked ? (
        <div className="card" style={{ maxWidth: 460, margin: '0 auto' }}>
          <div className="card-head">
            <span className="card-title">
              <Icon name="lock" /> Abrir tu buzón
            </span>
          </div>
          <div className="card-body stack">
            <p className="small muted">
              Introduce la contraseña de tu cuenta de correo ({status?.address ?? 'tu dirección'}) para
              leer y enviar mensajes. Se guarda cifrada en el servidor y puedes bloquearla cuando
              quieras.
            </p>
            <label className="field">
              <span className="label">Contraseña de correo</span>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void unlock();
                }}
                autoFocus
              />
            </label>
            {unlockError ? <div className="alert alert-error">{unlockError}</div> : null}
            <button type="button" className="btn btn-primary btn-block" onClick={() => void unlock()} disabled={busy || !password}>
              {busy ? 'Comprobando…' : 'Abrir buzón'}
            </button>
            <p className="tiny faint">
              IMAP: {status?.imap.host ?? '—'}:{status?.imap.port ?? '—'}
            </p>
          </div>
        </div>
      ) : error ? (
        <div className="alert alert-error">{error}</div>
      ) : !pageData && loading ? (
        <Spinner />
      ) : (
        <div className="mail-layout">
          {/* --------------------------------------------------- carpetas */}
          <aside className="mail-folders card">
            <button
              type="button"
              className="btn btn-primary btn-block"
              onClick={() => setCompose({ to: '', cc: '', subject: '', text: '' })}
            >
              <Icon name="edit" /> Redactar
            </button>
            <nav className="folder-list">
              {folders.map((item) => (
                <button
                  type="button"
                  key={item.path}
                  className={`folder-item ${folder === item.path ? 'active' : ''}`}
                  onClick={() => selectFolder(item.path)}
                >
                  <Icon name={folderIcon(item)} size={16} />
                  <span className="folder-name truncate">{item.name}</span>
                  {item.unseen ? <span className="folder-count">{item.unseen}</span> : null}
                  {item.total ? <span className="folder-total tiny faint">{item.total}</span> : null}
                </button>
              ))}
            </nav>
            <div className="mail-identity tiny muted">
              <div className="truncate">{status?.identity.email}</div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void api.post(`${BASE}/webmail/lock`).then(() => setLocked(true))}
              >
                Bloquear buzón
              </button>
            </div>
          </aside>

          {/* ---------------------------------------------------- mensajes */}
          <section className="mail-main card">
            <div className="mail-toolbar">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={() =>
                    setChecked(allChecked ? new Set() : new Set(pageData?.messages.map((m) => m.uid) ?? []))
                  }
                />
              </label>
              <div className="grow">
                <input
                  className="input"
                  placeholder="Buscar en el correo"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <button
                type="button"
                className="icon-btn"
                title="Actualizar"
                onClick={() => {
                  void loadFolders();
                  void loadMessages(folder, search, 1);
                }}
              >
                <Icon name="refresh" />
              </button>
            </div>

            {checked.size > 0 ? (
              <div className="mail-bulk">
                <span className="small">{checked.size} seleccionados</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    void act(
                      () =>
                        api.post(`${BASE}/webmail/flags`, {
                          folder,
                          uids: [...checked],
                          add: ['\\Seen'],
                        }),
                      'Marcados como leídos.',
                    )
                  }
                >
                  Marcar leídos
                </button>
                <button type="button" className="btn btn-sm" onClick={() => removeMessages([...checked])}>
                  <Icon name="trash" /> Eliminar
                </button>
              </div>
            ) : null}

            {loading && !pageData ? (
              <Spinner />
            ) : !pageData?.messages.length ? (
              <EmptyState
                icon="mail"
                title={search ? 'Sin resultados' : 'No hay mensajes'}
                hint={
                  search
                    ? 'Prueba con otra palabra.'
                    : 'Cuando lleguen mensajes aparecerán aquí.'
                }
              />
            ) : (
              <ul className="mail-list">
                {pageData.messages.map((message) => (
                  <li key={message.uid} className={`mail-row ${message.seen ? '' : 'unread'} ${open?.uid === message.uid ? 'open' : ''}`}>
                    <label className="checkbox" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={checked.has(message.uid)}
                        onChange={() => toggleChecked(message.uid)}
                      />
                    </label>
                    <button
                      type="button"
                      className={`star ${message.flagged ? 'on' : ''}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void toggleFlag(message);
                      }}
                      aria-label="Destacar"
                    >
                      ★
                    </button>
                    <button type="button" className="mail-row-main" onClick={() => void openMessage(message)}>
                      <span className="mail-sender truncate">{senderOf(message)}</span>
                      <span className="mail-subject truncate">
                        {message.subject}
                        {message.snippet ? (
                          <span className="mail-snippet small muted"> — {message.snippet}</span>
                        ) : null}
                      </span>
                    </button>
                    <span className="mail-date small">{shortDate(message.date)}</span>
                  </li>
                ))}
              </ul>
            )}

            {pageData && pageData.messages.length < pageData.total ? (
              <div className="mail-more">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void loadMessages(folder, search, pageData.page + 1)}
                >
                  Cargar más ({pageData.total - pageData.messages.length} restantes)
                </button>
              </div>
            ) : null}
          </section>

          {/* ---------------------------------------------------- mensaje */}
          {open ? (
            <section className="mail-view card">
              <div className="mail-view-head">
                <button type="button" className="icon-btn" onClick={() => setOpen(null)} aria-label="Cerrar">
                  <Icon name="x" />
                </button>
                <div className="grow truncate">
                  <div className="card-title truncate">{open.subject}</div>
                  <div className="small muted truncate">
                    {senderOf(open)} → {open.toFull.map((entry) => entry.address).join(', ') || '—'}
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  title="Eliminar"
                  onClick={() => removeMessages([open.uid])}
                >
                  <Icon name="trash" />
                </button>
              </div>

              <div className="mail-view-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    setCompose({
                      to: open.from.address ?? '',
                      cc: '',
                      subject: open.subject.startsWith('Re:') ? open.subject : `Re: ${open.subject}`,
                      text: `\n\n—\nEl ${formatDate(open.date, true)} escribió ${senderOf(open)}:\n> ${open.text.slice(0, 400)}`,
                      inReplyTo: open.messageId,
                    })
                  }
                >
                  Responder
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    void act(
                      () =>
                        api.post(`${BASE}/webmail/flags`, {
                          folder,
                          uids: [open.uid],
                          remove: ['\\Seen'],
                        }),
                      'Marcado como no leído.',
                    )
                  }
                >
                  No leído
                </button>
                {trashFolder && folder !== trashFolder.path ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => moveMessages([open.uid], trashFolder.path)}
                  >
                    <Icon name="trash" /> Papelera
                  </button>
                ) : null}
              </div>

              <div className="mail-view-body">
                <div className="small muted">
                  {formatDate(open.date, true)} · Para: {open.toFull.map((e) => e.address).join(', ') || '—'}
                  {open.cc.length ? ` · Cc: ${open.cc.map((e) => e.address).join(', ')}` : ''}
                </div>
                {open.html ? (
                  <div className="mail-html" dangerouslySetInnerHTML={{ __html: open.html }} />
                ) : (
                  <pre className="mail-plain">{open.text}</pre>
                )}
              </div>
            </section>
          ) : null}
        </div>
      )}

      {/* ------------------------------------------------------ redactar */}
      {compose ? (
        <Modal
          title="Nuevo mensaje"
          subtitle={status?.identity.email}
          onClose={() => setCompose(null)}
          size="wide"
          footer={
            <div className="row-between">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void saveDraft()}>
                Guardar borrador
              </button>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={() => setCompose(null)}>
                  Cancelar
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void sendMail()} disabled={busy}>
                  {busy ? 'Enviando…' : 'Enviar'}
                </button>
              </div>
            </div>
          }
        >
          <div className="stack">
            <label className="field">
              <span className="label">Para</span>
              <input
                className="input"
                value={compose.to}
                placeholder="destinatario@dominio"
                onChange={(event) => setCompose({ ...compose, to: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="label">Cc</span>
              <input
                className="input"
                value={compose.cc}
                onChange={(event) => setCompose({ ...compose, cc: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="label">Asunto</span>
              <input
                className="input"
                value={compose.subject}
                onChange={(event) => setCompose({ ...compose, subject: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="label">Mensaje</span>
              <textarea
                className="textarea"
                rows={12}
                value={compose.text}
                onChange={(event) => setCompose({ ...compose, text: event.target.value })}
              />
            </label>
          </div>
        </Modal>
      ) : null}

    </Shell>
  );
}
