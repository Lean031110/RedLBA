import { attachAuth } from '../core/auth.js';
import { all, get, type UserRow } from '../core/db.js';
import { hasPermission } from '../core/rbac.js';
import { personFor } from '../core/serialize.js';
import { escapeLike, normalize } from '../core/util.js';
import type { RedlbaModule, SearchResult } from '../core/module-registry.js';

interface Query {
  q?: string;
  limit?: string;
  offset?: string;
  department?: string;
}

export const directoryModule: RedlbaModule = {
  key: 'directory',
  name: 'Directorio',
  description: 'Personas del servidor y sus perfiles.',
  icon: 'users',
  defaultPath: '/directory',
  requires: 'users.read',

  register(app, runtime) {
    app.get<{ Querystring: Query }>('/people', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });

      const limit = Math.min(Math.max(Number(req.query.limit ?? 24) || 24, 1), 100);
      const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
      const search = normalize(req.query.q ?? '');
      const department = (req.query.department ?? '').trim();

      const clauses = ["status = 'active'"];
      const params: Array<string | number> = [];
      if (search) {
        clauses.push("search_text LIKE ? ESCAPE '!'");
        params.push(`%${escapeLike(search)}%`);
      }
      if (department) {
        clauses.push('department = ?');
        params.push(department);
      }

      const where = `WHERE ${clauses.join(' AND ')}`;
      const total = get<{ count: number }>(`SELECT COUNT(*) AS count FROM users ${where}`, ...params);
      const rows = all<UserRow>(
        `SELECT * FROM users ${where} ORDER BY display_name COLLATE NOCASE ASC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      );

      return {
        total: total?.count ?? 0,
        limit,
        offset,
        people: rows.map((user) => personFor(user, auth)),
      };
    });

    app.get('/stats', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      if (!hasPermission(auth.access, 'users.read')) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      const departments = all<{ department: string; count: number }>(
        `SELECT COALESCE(NULLIF(department, ''), 'Sin departamento') AS department, COUNT(*) AS count
           FROM users WHERE status = 'active' GROUP BY department ORDER BY count DESC LIMIT 12`,
      );
      const totals = get<{ total: number; ldap: number; local: number }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN source = 'ldap' THEN 1 ELSE 0 END) AS ldap,
                SUM(CASE WHEN source = 'local' THEN 1 ELSE 0 END) AS local
           FROM users WHERE status = 'active'`,
      );

      return {
        total: totals?.total ?? 0,
        ldap: totals?.ldap ?? 0,
        local: totals?.local ?? 0,
        departments,
      };
    });
  },

  async search(query, auth, runtime, limit): Promise<SearchResult[]> {
    const needle = normalize(query);
    const rows = all<UserRow>(
      `SELECT * FROM users WHERE status = 'active' AND search_text LIKE ? ESCAPE '!'
        ORDER BY display_name COLLATE NOCASE ASC LIMIT ?`,
      `%${escapeLike(needle)}%`,
      limit,
    );
    const base = runtime.urlBase;
    return rows.map((user) => ({
      id: `person-${user.id}`,
      title: user.display_name,
      subtitle: [user.title, user.department].filter(Boolean).join(' · ') || user.email || undefined,
      href: `${base}/${user.username}`,
      badge: 'Persona',
      icon: 'user',
      module: runtime.row.key,
    }));
  },
};
