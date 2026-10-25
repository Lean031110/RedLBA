import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { attachAuth, type AuthContext } from '../core/auth.js';
import { record } from '../core/audit.js';
import { config } from '../config.js';
import {
  checkCredentials,
  deleteMessages,
  forgetPassword,
  hasStoredPassword,
  listFolders,
  listMessages,
  moveMessages,
  readMessage,
  saveDraft,
  sendMail,
  setFlags,
  storePassword,
  WebmailError,
  type FullMessage,
} from '../core/webmail.js';
import { userMailboxes } from './mail.js';

type MailBody = Record<string, unknown>;

function body(req: FastifyRequest): MailBody {
  return (req.body ?? {}) as MailBody;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function uids(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0)
    .slice(0, 500);
}

function folderOf(value: unknown): string {
  const folder = text(value, 256);
  if (!folder) throw new WebmailError('invalid', 'Falta la carpeta.', 400);
  return folder;
}

/**
 * Rutas del webmail (estilo Gmail) bajo /api/m/mail.
 * Usa el servidor de correo real del sistema: IMAP para leer, SMTP para enviar.
 */
export function registerWebmailRoutes(app: FastifyInstance): void {
  const guard = async (req: FastifyRequest): Promise<AuthContext> => {
    const auth = attachAuth(req);
    if (!auth) throw new WebmailError('unauthorized', 'Inicia sesión para continuar.', 401);
    return auth;
  };

  const handle = (fn: (req: FastifyRequest, auth: AuthContext) => Promise<unknown>) =>
  async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const auth = await guard(req);
      return await fn(req, auth);
    } catch (error) {
      if (error instanceof WebmailError) {
        return reply.code(error.status).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  };

  /** Estado del buzón del usuario: si necesita desbloquear y con qué cuenta. */
  app.get(
    '/webmail/status',
    handle(async (req, auth) => {
      const mailboxes = userMailboxes(auth.user);
      return {
        ready: hasStoredPassword(auth.user.id) || Boolean(config.mail.imap.masterUser),
        unlocked: hasStoredPassword(auth.user.id) || Boolean(config.mail.imap.masterUser),
        requiresPassword: !config.mail.imap.masterUser,
        address: mailboxes[0]?.address ?? auth.user.email ?? '',
        mailboxes: mailboxes.map((row) => ({
          address: (row as { address: string }).address,
          status: (row as { status: string }).status,
        })),
        identity: { name: auth.user.display_name, email: auth.user.email ?? '' },
        imap: { host: config.mail.imap.host, port: config.mail.imap.port, secure: config.mail.imap.secure },
        driver: config.mail.driver,
      };
    }),
  );

  /** Desbloquea el buzón: valida la contraseña contra IMAP y la guarda cifrada. */
  app.post(
    '/webmail/unlock',
    handle(async (req, auth) => {
      const password = text(body(req).password, 512);
      if (!password) throw new WebmailError('invalid', 'Introduce tu contraseña de correo.', 400);

      await checkCredentials(auth.user, password);
      storePassword(auth.user.id, password);
      record({
        actor: auth.user,
        action: 'webmail.unlock',
        target: auth.user.username,
        ip: req.ip,
      });
      return { ok: true, unlocked: true };
    }),
  );

  app.post(
    '/webmail/lock',
    handle(async (req, auth) => {
      forgetPassword(auth.user.id);
      record({ actor: auth.user, action: 'webmail.lock', target: auth.user.username, ip: req.ip });
      return { ok: true, unlocked: false };
    }),
  );

  app.get(
    '/webmail/folders',
    handle(async (_req, auth) => ({ folders: await listFolders(auth.user) })),
  );

  app.get<{ Querystring: { folder?: string; page?: string; pageSize?: string; q?: string } }>(
    '/webmail/messages',
    handle(async (req, auth) => {
      const q = req.query as { folder?: string; page?: string; pageSize?: string; q?: string };
      const result = await listMessages(auth.user, {
        folder: folderOf(q.folder ?? 'INBOX'),
        page: Number(q.page ?? 1) || 1,
        pageSize: Number(q.pageSize ?? 25) || 25,
        query: q.q ?? '',
      });
      return result;
    }),
  );

  app.get<{ Params: { uid: string }; Querystring: { folder?: string } }>(
    '/webmail/messages/:uid',
    handle(async (req, auth) => {
      const p = req.params as { uid: string };
      const q = req.query as { folder?: string };
      const uid = Number(p.uid);
      if (!Number.isInteger(uid) || uid <= 0) {
        throw new WebmailError('invalid', 'Mensaje no válido.', 400);
      }
      const folder = folderOf(q.folder ?? 'INBOX');
      const message: FullMessage = await readMessage(auth.user, folder, uid);
      return { message };
    }),
  );

  app.post(
    '/webmail/flags',
    handle(async (req, auth) => {
      const payload = body(req);
      await setFlags(auth.user, {
        folder: folderOf(payload.folder),
        uids: uids(payload.uids),
        add: Array.isArray(payload.add) ? payload.add.map(String).slice(0, 10) : [],
        remove: Array.isArray(payload.remove) ? payload.remove.map(String).slice(0, 10) : [],
      });
      return { ok: true };
    }),
  );

  app.post(
    '/webmail/move',
    handle(async (req, auth) => {
      const payload = body(req);
      await moveMessages(auth.user, {
        folder: folderOf(payload.folder),
        uids: uids(payload.uids),
        target: folderOf(payload.target),
      });
      return { ok: true };
    }),
  );

  app.post(
    '/webmail/delete',
    handle(async (req, auth) => {
      const payload = body(req);
      await deleteMessages(auth.user, {
        folder: folderOf(payload.folder),
        uids: uids(payload.uids),
        trash: typeof payload.trash === 'string' ? payload.trash : null,
      });
      return { ok: true };
    }),
  );

  app.post(
    '/webmail/send',
    handle(async (req, auth) => {
      const payload = body(req);
      const to = text(payload.to, 4000).trim();
      const subject = text(payload.subject, 998).trim() || '(sin asunto)';
      const messageText = text(payload.text, 500_000);
      const html = text(payload.html, 1_000_000);
      if (!to) throw new WebmailError('invalid', 'Indica al menos un destinatario.', 400);
      if (!messageText && !html) throw new WebmailError('invalid', 'El mensaje está vacío.', 400);

      const result = await sendMail(auth.user, {
        to,
        cc: text(payload.cc, 2000).trim(),
        subject,
        text: messageText || html.replace(/<[^>]+>/g, ' '),
        html: html || undefined,
        inReplyTo: typeof payload.inReplyTo === 'string' ? payload.inReplyTo : null,
      });

      record({
        actor: auth.user,
        action: 'webmail.send',
        target: to,
        detail: { subject, accepted: result.accepted.length },
        ip: req.ip,
      });

      return { ok: true, ...result };
    }),
  );

  app.post(
    '/webmail/draft',
    handle(async (req, auth) => {
      const payload = body(req);
      const to = text(payload.to, 4000).trim();
      const subject = text(payload.subject, 998).trim() || '(sin asunto)';
      const messageText = text(payload.text, 500_000);
      const html = text(payload.html, 1_000_000);
      if (!to && !subject && !messageText && !html) {
        throw new WebmailError('invalid', 'Borrador vacío.', 400);
      }
      await saveDraft(auth.user, 'Drafts', { to, subject, text: messageText, html: html || undefined });
      return { ok: true };
    }),
  );
}
