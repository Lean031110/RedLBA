import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { attachAuth } from '../core/auth.js';
import { record } from '../core/audit.js';
import { all, get, run } from '../core/db.js';
import { hasPermission } from '../core/rbac.js';
import { newId, nowIso, text as cleanText } from '../core/util.js';
import type { RedlbaModule, SearchResult } from '../core/module-registry.js';

interface NoticeRow {
  id: string;
  title: string;
  body: string;
  author_id: string | null;
  author_name: string | null;
  pinned: number;
  created_at: string;
  updated_at: string;
}

function str(value: unknown, max: number): string {
  return (cleanText(value, max) ?? '').trim();
}

function serialize(row: NoticeRow) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    author: row.author_name ?? 'Sistema',
    pinned: Boolean(row.pinned),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Tablón de avisos: comunicados de la intranet que no requieren internet.
 * Lectura para cualquier cuenta autenticada; publicación con `notices.write`.
 */
export const noticesModule: RedlbaModule = {
  key: 'notices',
  name: 'Tablón',
  description: 'Avisos y comunicados de la intranet, disponibles sin internet.',
  icon: 'megaphone',
  defaultPath: '/notices',

  register(app: FastifyInstance) {
    const auth0 = async (req: FastifyRequest) => {
      const auth = attachAuth(req);
      if (!auth) {
        const error = new Error('Inicia sesión para continuar.') as Error & { statusCode?: number };
        error.statusCode = 401;
        throw error;
      }
      return auth;
    };

    app.get<{ Querystring: { q?: string } }>('/posts', async (req) => {
      await auth0(req);
      const search = str(req.query.q, 120);
      const rows = search
        ? all<NoticeRow>(
            `SELECT * FROM announcements
              WHERE title LIKE ? OR body LIKE ?
              ORDER BY pinned DESC, created_at DESC LIMIT 200`,
            `%${search}%`,
            `%${search}%`,
          )
        : all<NoticeRow>('SELECT * FROM announcements ORDER BY pinned DESC, created_at DESC LIMIT 200');
      return { posts: rows.map(serialize) };
    });

    app.post('/posts', async (req, reply) => {
      const auth = await auth0(req);
      if (!hasPermission(auth.access, 'notices.write')) {
        return reply.code(403).send({ error: 'forbidden', required: 'notices.write' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = str(body.title, 200);
      const content = str(body.body, 20_000);
      if (!title || !content) {
        return reply.code(400).send({ error: 'invalid', message: 'Título y texto son obligatorios.' });
      }

      const id = newId();
      run(
        `INSERT INTO announcements (id, title, body, author_id, author_name, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        title,
        content,
        auth.user.id,
        auth.user.display_name,
        body.pinned ? 1 : 0,
        nowIso(),
        nowIso(),
      );
      record({ actor: auth.user, action: 'notice.create', target: title, ip: req.ip });

      const row = get<NoticeRow>('SELECT * FROM announcements WHERE id = ?', id)!;
      return { post: serialize(row) };
    });

    app.patch<{ Params: { id: string } }>('/posts/:id', async (req, reply) => {
      const auth = await auth0(req);
      if (!hasPermission(auth.access, 'notices.write')) {
        return reply.code(403).send({ error: 'forbidden', required: 'notices.write' });
      }
      const existing = get<NoticeRow>('SELECT * FROM announcements WHERE id = ?', req.params.id);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = body.title === undefined ? existing.title : str(body.title, 200);
      const content = body.body === undefined ? existing.body : str(body.body, 20_000);
      const pinned = body.pinned === undefined ? existing.pinned : body.pinned ? 1 : 0;
      if (!title || !content) {
        return reply.code(400).send({ error: 'invalid', message: 'Título y texto son obligatorios.' });
      }

      run(
        'UPDATE announcements SET title = ?, body = ?, pinned = ?, updated_at = ? WHERE id = ?',
        title,
        content,
        pinned,
        nowIso(),
        existing.id,
      );
      record({ actor: auth.user, action: 'notice.update', target: title, ip: req.ip });
      const row = get<NoticeRow>('SELECT * FROM announcements WHERE id = ?', existing.id)!;
      return { post: serialize(row) };
    });

    app.delete<{ Params: { id: string } }>('/posts/:id', async (req, reply) => {
      const auth = await auth0(req);
      if (!hasPermission(auth.access, 'notices.write')) {
        return reply.code(403).send({ error: 'forbidden', required: 'notices.write' });
      }
      const existing = get<NoticeRow>('SELECT * FROM announcements WHERE id = ?', req.params.id);
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      run('DELETE FROM announcements WHERE id = ?', existing.id);
      record({ actor: auth.user, action: 'notice.delete', target: existing.title, ip: req.ip });
      return { ok: true };
    });
  },

  async search(query, auth): Promise<SearchResult[]> {
    const rows = all<NoticeRow>(
      `SELECT * FROM announcements WHERE title LIKE ? ORDER BY pinned DESC, created_at DESC LIMIT ?`,
      `%${query}%`,
      5,
    );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      subtitle: row.body.slice(0, 120),
      href: `${config.baseUrl}/notices`,
      icon: 'megaphone',
      module: 'notices',
      badge: row.pinned ? 'Fijado' : 'Aviso',
    }));
  },
};
