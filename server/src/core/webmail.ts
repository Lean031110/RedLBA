import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import type { FetchMessageObject, ListResponse, MailboxObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { ParsedMail } from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import { config } from '../config.js';
import { get, run, type UserRow } from './db.js';
import { seal, unseal } from './crypto.js';
import { nowIso } from './util.js';

export class WebmailError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'WebmailError';
    this.code = code;
    this.status = status;
  }
}

export interface FolderInfo {
  path: string;
  name: string;
  specialUse: string | null;
  flags: string[];
  total?: number;
  unseen?: number;
}

export interface MessageSummary {
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

/* ------------------------------------------------- contraseña del buzone */

export function storedPassword(userId: string): string | null {
  const row = get<{ password_sealed: string }>(
    'SELECT password_sealed FROM mail_accounts WHERE user_id = ?',
    userId,
  );
  if (!row) return null;
  try {
    return unseal(row.password_sealed);
  } catch {
    return null;
  }
}

export function storePassword(userId: string, password: string): void {
  run(
    `INSERT INTO mail_accounts (user_id, password_sealed, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET password_sealed = excluded.password_sealed,
                                        updated_at = excluded.updated_at`,
    userId,
    seal(password),
    nowIso(),
  );
}

export function forgetPassword(userId: string): void {
  run('DELETE FROM mail_accounts WHERE user_id = ?', userId);
}

export function hasStoredPassword(userId: string): boolean {
  return Boolean(
    get('SELECT 1 FROM mail_accounts WHERE user_id = ?', userId),
  );
}

/* ---------------------------------------------------------- conexión IMAP */

interface Credentials {
  user: string;
  pass: string;
}

function credentialsFor(user: UserRow, explicit?: string | null): Credentials {
  const master = config.mail.imap.masterUser;
  if (master) {
    return {
      user: `${user.username}${config.mail.imap.masterSeparator}${master}`,
      pass: process.env.IMAP_MASTER_PASS ?? '',
    };
  }
  const password = explicit ?? storedPassword(user.id);
  if (!password) {
    throw new WebmailError(
      'unlock_required',
      'Introduce tu contraseña de correo para abrir el buzón.',
      401,
    );
  }
  return { user: user.username, pass: password };
}

function clientFor(user: UserRow, credentials: Credentials): ImapFlow {
  return new ImapFlow({
    host: config.mail.imap.host,
    port: config.mail.imap.port,
    secure: config.mail.imap.secure,
    auth: { user: credentials.user, pass: credentials.pass },
    logger: false,
    socketTimeout: config.mail.imap.timeoutMs,
    connectionTimeout: config.mail.imap.timeoutMs,
    greetingTimeout: config.mail.imap.timeoutMs,
    tls: { rejectUnauthorized: !config.mail.imap.tlsInsecure },
  });
}

async function withMailbox<T>(
  user: UserRow,
  fn: (client: ImapFlow, mailbox?: MailboxObject) => Promise<T>,
  options?: { password?: string | null; folder?: string },
): Promise<T> {
  const credentials = credentialsFor(user, options?.password);
  const client = clientFor(user, credentials);
  try {
    await client.connect();
    if (options?.folder) {
      await client.mailboxOpen(options.folder);
      return await fn(client, client.mailbox || undefined);
    }
    return await fn(client);
  } catch (error) {
    if (error instanceof WebmailError) throw error;
    const message = (error as Error).message ?? '';
    if (/auth|credentials|invalid login|password/i.test(message)) {
      throw new WebmailError('auth_failed', 'Contraseña de correo incorrecta.', 401);
    }
    throw new WebmailError(
      'imap_error',
      `No se pudo contactar con el servidor de correo: ${message}`,
      502,
    );
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ consultas */

export async function checkCredentials(user: UserRow, password: string): Promise<void> {
  await withMailbox(user, async () => undefined, { password });
}

export async function listFolders(user: UserRow): Promise<FolderInfo[]> {
  return withMailbox(user, async (client) => {
    const list = (await client.list()) as ListResponse[];
    const folders: FolderInfo[] = [];
    for (const entry of list) {
      let total: number | undefined;
      let unseen: number | undefined;
      try {
        const status = await client.status(entry.path, { messages: true, unseen: true });
        if (status) {
          total = status.messages;
          unseen = status.unseen;
        }
      } catch {
        /* status no soportado */
      }
      folders.push({
        path: entry.path,
        name: entry.name,
        specialUse: entry.specialUse ?? null,
        flags: [...entry.flags],
        total,
        unseen,
      });
    }
    return sortFolders(folders);
  });
}

const SPECIAL_ORDER: Record<string, number> = {
  INBOX: 0,
  '\\Sent': 1,
  '\\Drafts': 2,
  '\\Trash': 3,
  '\\Junk': 4,
};

function sortFolders(folders: FolderInfo[]): FolderInfo[] {
  return [...folders].sort((a, b) => {
    const orderA = a.specialUse ? (SPECIAL_ORDER[a.specialUse] ?? 50) : a.path === 'INBOX' ? 0 : 50;
    const orderB = b.specialUse ? (SPECIAL_ORDER[b.specialUse] ?? 50) : b.path === 'INBOX' ? 0 : 50;
    if (orderA !== orderB) return orderA - orderB;
    return a.name.localeCompare(b.name);
  });
}

function toDate(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function addressOf(value: unknown): { name: string | null; address: string | null } {
  const list = Array.isArray(value) ? value[0] : value;
  if (!list) return { name: null, address: null };
  if (typeof list === 'string') return { name: null, address: list };
  const entry = list as { name?: string; address?: string };
  return { name: entry.name ?? null, address: entry.address ?? null };
}

function toSummary(message: FetchMessageObject): MessageSummary {
  const envelope = message.envelope;
  const from = addressOf(envelope?.from);
  const to = (envelope?.to ?? []).map((entry) => entry.address ?? '').filter(Boolean);
  const flags = message.flags ?? new Set<string>();
  return {
    uid: message.uid,
    subject: envelope?.subject ?? '(sin asunto)',
    from,
    to,
    date: toDate(envelope?.date),
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    snippet: '',
    hasAttachments: false,
  };
}

const MAX_SCAN = 500;

export async function listMessages(
  user: UserRow,
  params: { folder: string; page?: number; pageSize?: number; query?: string },
): Promise<{ messages: MessageSummary[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(params.pageSize ?? 25, 1), 100);
  const page = Math.max(params.page ?? 1, 1);

  return withMailbox(
    user,
    async (client) => {
      const mailbox = client.mailbox;
      const exists = mailbox && typeof mailbox === 'object' ? (mailbox.exists ?? 0) : 0;
      const uidNext = mailbox && typeof mailbox === 'object' ? (mailbox.uidNext ?? 1) : 1;
      const first = Math.max(1, uidNext - MAX_SCAN);
      const items =
        exists > 0
          ? await client.fetchAll(`${first}:*`, { envelope: true, flags: true, internalDate: true }, { uid: true })
          : [];

      let messages = items.map(toSummary).sort((a, b) => b.uid - a.uid);
      const query = (params.query ?? '').trim().toLowerCase();
      if (query) {
        messages = messages.filter((item) =>
          [item.subject, item.from.name ?? '', item.from.address ?? '', ...item.to]
            .join(' ')
            .toLowerCase()
            .includes(query),
        );
      }

      const total = messages.length;
      const start = (page - 1) * pageSize;
      return { messages: messages.slice(start, start + pageSize), total, page, pageSize };
    },
    { folder: params.folder },
  );
}

export interface FullMessage extends MessageSummary {
  html: string | null;
  text: string;
  toFull: Array<{ name: string | null; address: string | null }>;
  cc: Array<{ name: string | null; address: string | null }>;
  messageId: string | null;
  inReplyTo: string | null;
  raw?: undefined;
}

export async function readMessage(user: UserRow, folder: string, uid: number): Promise<FullMessage> {
  return withMailbox(
    user,
    async (client) => {
      const item = await client.fetchAll(String(uid), { envelope: true, flags: true, source: true }, { uid: true });
      const found = item[0];
      if (!found) throw new WebmailError('not_found', 'Mensaje no encontrado.', 404);

      let parsed: ParsedMail | null = null;
      if (found.source) {
        parsed = await simpleParser(found.source);
      }

      const summary = toSummary(found);
      const toFull = addressList(parsed?.to);
      const cc = addressList(parsed?.cc);

      return {
        ...summary,
        subject: parsed?.subject ?? summary.subject,
        from: parsed?.from?.value?.[0]
          ? {
              name: parsed.from.value[0].name ?? null,
              address: parsed.from.value[0].address ?? null,
            }
          : summary.from,
        date: toDate(parsed?.date ?? null) ?? summary.date,
        toFull,
        cc,
        html: parsed?.html
          ? sanitizeBody(String(parsed.html))
          : parsed?.text
            ? `<pre>${escapeHtml(parsed.text)}</pre>`
            : null,
        text: parsed?.text ?? '',
        messageId: parsed?.messageId ?? null,
        inReplyTo: parsed?.inReplyTo ?? null,
      };
    },
    { folder },
  );
}

function addressList(
  value: ParsedMail['to'],
): Array<{ name: string | null; address: string | null }> {
  if (!value) return [];
  const groups = Array.isArray(value) ? value : [value];
  return groups
    .flatMap((group) => group.value ?? [])
    .map((entry) => ({ name: entry.name ?? null, address: entry.address ?? null }));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function sanitizeBody(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'blockquote', 'pre', 'code',
      'a', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'h1', 'h2', 'h3',
      'h4', 'img', 'font',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      font: ['color'],
      td: ['colspan', 'rowspan', 'align'],
      '*': ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid'],
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: 'a',
        attribs: { ...attribs, rel: 'noopener noreferrer', target: '_blank' },
      }),
    },
  });
}

/* ------------------------------------------------------------------ acciones */

export async function setFlags(
  user: UserRow,
  params: { folder: string; uids: number[]; add?: string[]; remove?: string[] },
): Promise<void> {
  if (params.uids.length === 0) return;
  await withMailbox(
    user,
    async (client) => {
      const range = params.uids.join(',');
      if (params.add?.length) await client.messageFlagsAdd(range, params.add, { uid: true });
      if (params.remove?.length) await client.messageFlagsRemove(range, params.remove, { uid: true });
    },
    { folder: params.folder },
  );
}

export async function moveMessages(
  user: UserRow,
  params: { folder: string; uids: number[]; target: string },
): Promise<void> {
  if (params.uids.length === 0) return;
  await withMailbox(
    user,
    async (client) => {
      await client.messageMove(params.uids.join(','), params.target, { uid: true });
    },
    { folder: params.folder },
  );
}

export async function deleteMessages(
  user: UserRow,
  params: { folder: string; uids: number[]; trash?: string | null },
): Promise<void> {
  if (params.uids.length === 0) return;
  await withMailbox(
    user,
    async (client) => {
      if (params.trash && params.folder !== params.trash) {
        await client.messageMove(params.uids.join(','), params.trash, { uid: true });
      } else {
        await client.messageDelete(params.uids.join(','), { uid: true });
      }
    },
    { folder: params.folder },
  );
}

export async function saveDraft(
  user: UserRow,
  draftFolder: string,
  message: { to: string; subject: string; text: string; html?: string },
): Promise<void> {
  await withMailbox(
    user,
    async (client) => {
      const raw = buildRfc822(user, message);
      await client.append(draftFolder, raw, ['\\Draft']);
    },
    {},
  );
}

/* -------------------------------------------------------------------- envío */

function smtpTransport() {
  const { host, port, secure, user, pass, tlsInsecure } = config.mail.smtp;
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
    ignoreTLS: tlsInsecure,
    tls: tlsInsecure ? { rejectUnauthorized: false } : undefined,
    connectionTimeout: 15_000,
  });
}

function buildRfc822(
  user: UserRow,
  message: { to: string; subject: string; text: string; html?: string; inReplyTo?: string | null },
): string {
  const from = `${user.display_name} <${user.email ?? user.username}>`;
  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${new Date().getTime()}.${Math.random().toString(36).slice(2)}@${config.mail.domain}>`,
  ];
  if (message.inReplyTo) headers.push(`In-Reply-To: ${message.inReplyTo}`);

  if (message.html) {
    const boundary = `----redlba-${Math.random().toString(36).slice(2)}`;
    headers.push(`MIME-Version: 1.0`, `Content-Type: multipart/alternative; boundary="${boundary}"`);
    return [
      headers.join('\r\n'),
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      message.text,
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      message.html,
      `--${boundary}--`,
    ].join('\r\n');
  }

  headers.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8');
  return [headers.join('\r\n'), '', message.text].join('\r\n');
}

export interface SentResult {
  accepted: string[];
  messageId?: string;
}

export async function sendMail(
  user: UserRow,
  message: {
    to: string;
    cc?: string;
    subject: string;
    text: string;
    html?: string;
    inReplyTo?: string | null;
  },
): Promise<SentResult> {
  if (!user.email) {
    throw new WebmailError('no_email', 'La cuenta no tiene dirección de correo.', 400);
  }
  const transport = smtpTransport();
  try {
    const info = await transport.sendMail({
      from: `${user.display_name} <${user.email}>`,
      to: message.to,
      cc: message.cc || undefined,
      subject: message.subject,
      text: message.text,
      html: message.html,
      inReplyTo: message.inReplyTo ?? undefined,
      messageId: undefined,
    });
    return { accepted: info.accepted.map(String), messageId: info.messageId };
  } catch (error) {
    throw new WebmailError(
      'smtp_error',
      `No se pudo enviar el mensaje: ${(error as Error).message}`,
      502,
    );
  } finally {
    transport.close();
  }
}
