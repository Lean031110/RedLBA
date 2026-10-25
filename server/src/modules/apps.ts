import { attachAuth } from '../core/auth.js';
import { all, get, run, type AppRow } from '../core/db.js';
import { record } from '../core/audit.js';
import { hasPermission } from '../core/rbac.js';
import { appFor } from '../core/serialize.js';
import { integer, newId, nowIso, normalize, text, truthy } from '../core/util.js';
import type { RedlbaModule, SearchResult } from '../core/module-registry.js';

interface Query {
  q?: string;
}

function visibleApps(access: Parameters<typeof hasPermission>[0]): AppRow[] {
  return all<AppRow>('SELECT * FROM apps WHERE enabled = 1 ORDER BY sort ASC, name ASC').filter(
    (row) => !row.permission || hasPermission(access, row.permission),
  );
}

export const appsModule: RedlbaModule = {
  key: 'apps',
  name: 'Aplicaciones',
  description: 'Catálogo de los sitios y servicios del servidor.',
  icon: 'grid',
  defaultPath: '/apps',
  requires: 'apps.read',

  register(app) {
    app.get<{ Querystring: Query }>('/', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      const search = normalize(req.query.q ?? '');
      const rows = (hasPermission(auth.access, 'apps.manage')
        ? all<AppRow>('SELECT * FROM apps ORDER BY sort ASC, name ASC')
        : visibleApps(auth.access)
      ).filter(
        (row) => !search || normalize(`${row.name} ${row.description ?? ''} ${row.url}`).includes(search),
      );
      return { apps: rows.map(appFor) };
    });

    app.post('/', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      if (!hasPermission(auth.access, 'apps.manage')) {
        return reply.code(403).send({ error: 'forbidden', required: 'apps.manage' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = text(body.name, 80);
      const url = text(body.url, 300);
      if (!name || !url || !/^https?:\/\//i.test(url)) {
        return reply.code(400).send({ error: 'invalid', message: 'Nombre y URL http(s) son obligatorios.' });
      }
      const id = newId();
      run(
        `INSERT INTO apps (id, name, url, description, icon, color, permission, sort, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        name,
        url,
        text(body.description, 200) ?? null,
        text(body.icon, 40) ?? 'grid',
        text(body.color, 20) ?? null,
        text(body.permission, 60) ?? null,
        integer(body.sort, 100),
        truthy(body.enabled ?? true) ? 1 : 0,
        nowIso(),
      );
      record({ actor: auth.user, action: 'app.create', target: name, ip: req.ip });
      return { app: appFor(get<AppRow>('SELECT * FROM apps WHERE id = ?', id)!) };
    });

    app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      if (!hasPermission(auth.access, 'apps.manage')) {
        return reply.code(403).send({ error: 'forbidden', required: 'apps.manage' });
      }
      const existing = get<AppRow>('SELECT * FROM apps WHERE id = ?', req.params.id);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      const body = (req.body ?? {}) as Record<string, unknown>;
      run(
        `UPDATE apps SET name = ?, url = ?, description = ?, icon = ?, color = ?, permission = ?,
           sort = ?, enabled = ? WHERE id = ?`,
        text(body.name, 80) ?? existing.name,
        text(body.url, 300) ?? existing.url,
        body.description === undefined ? existing.description : text(body.description, 200) ?? null,
        text(body.icon, 40) ?? existing.icon,
        body.color === undefined ? existing.color : text(body.color, 20) ?? null,
        body.permission === undefined ? existing.permission : text(body.permission, 60) ?? null,
        body.sort === undefined ? existing.sort : integer(body.sort, existing.sort),
        body.enabled === undefined ? existing.enabled : truthy(body.enabled) ? 1 : 0,
        existing.id,
      );
      record({ actor: auth.user, action: 'app.update', target: existing.name, ip: req.ip });
      return { app: appFor(get<AppRow>('SELECT * FROM apps WHERE id = ?', existing.id)!) };
    });

    app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      if (!hasPermission(auth.access, 'apps.manage')) {
        return reply.code(403).send({ error: 'forbidden', required: 'apps.manage' });
      }
      const existing = get<AppRow>('SELECT * FROM apps WHERE id = ?', req.params.id);
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      run('DELETE FROM apps WHERE id = ?', existing.id);
      record({ actor: auth.user, action: 'app.delete', target: existing.name, ip: req.ip });
      return { ok: true };
    });
  },

  async search(query, auth, _runtime, limit): Promise<SearchResult[]> {
    if (!hasPermission(auth.access, 'apps.read')) return [];
    const needle = normalize(query);
    return visibleApps(auth.access)
      .filter((row) => normalize(`${row.name} ${row.description ?? ''}`).includes(needle))
      .slice(0, limit)
      .map((row) => ({
        id: `app-${row.id}`,
        title: row.name,
        subtitle: row.description ?? row.url,
        href: row.url,
        badge: 'Aplicación',
        icon: row.icon,
        module: 'apps',
      }));
  },
};
