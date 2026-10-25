import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { record } from '../core/audit.js';
import {
  attachAuth,
  publicUser,
  requireAuth,
} from '../core/auth.js';
import { all, get, getSetting, type AppRow, type UserRow } from '../core/db.js';
import { findUserByUsername } from '../core/identity.js';
import { healthCheck } from '../core/ldap.js';
import {
  moduleForHost,
  moduleSettings,
  publicModule,
  visibleModules,
} from '../core/module-registry.js';
import { userMailboxes } from '../modules/mail.js';
import { hasPermission } from '../core/rbac.js';
import { appFor, personFor } from '../core/serialize.js';
import { recentEvents, stats } from '../core/seed.js';
import { escapeLike, hostOf, normalize } from '../core/util.js';

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    const ldap = await healthCheck();
    let db = 'ok';
    try {
      get('SELECT 1');
    } catch {
      db = 'error';
    }
    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      version: config.version,
      uptime: Math.round(process.uptime()),
      ldap: ldap.configured ? (ldap.ok ? 'ok' : 'unavailable') : 'not_configured',
      db,
      mail: config.mail.driver,
    };
  });

  app.get('/api/bootstrap', async (req) => {
    const auth = attachAuth(req);
    const requestHost = hostOf(req.headers.host);
    const currentModule = moduleForHost(req.headers.host);
    const isAdminHost = Boolean(
      requestHost && config.subdomains.isPublic && requestHost === config.subdomains.hosts.admin,
    );

    const moduleRows = auth ? visibleModules(auth.access) : [];
    const modules = moduleRows.map((row) => publicModule(row, Boolean(auth?.access.isAdmin)));

    return {
      site: {
        name: getSetting('site_name', 'RedLBA'),
        tagline: getSetting('site_tagline', ''),
        domain: config.domain,
        baseUrl: config.baseUrl,
        version: config.version,
        supportEmail: getSetting('support_email', ''),
        hosts: config.subdomains.isPublic ? config.subdomains.hosts : null,
      },
      currentModule: currentModule?.key ?? null,
      adminHost: isAdminHost,
      modules,
      authenticated: Boolean(auth),
      user: auth ? publicUser(auth.user, auth.access) : null,
      ldap: { configured: config.ldap.configured, mode: config.auth.mode },
    };
  });

  app.get('/api/portal/dashboard', { preHandler: [requireAuth] }, async (req) => {
    const auth = attachAuth(req)!;
    const appRows = all<AppRow>('SELECT * FROM apps WHERE enabled = 1 ORDER BY sort ASC, name ASC').filter(
      (row) => !row.permission || hasPermission(auth.access, row.permission),
    );
    const modules = visibleModules(auth.access).map((row) => publicModule(row));
    const mailRow = get<{ enabled: number }>("SELECT enabled FROM modules WHERE key = 'mail'");

    return {
      user: publicUser(auth.user, auth.access),
      apps: appRows.map(appFor),
      modules,
      stats: auth.access.isAdmin
        ? stats()
        : {
            users: get<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE status = 'active'")?.count ?? 0,
            groups: get<{ count: number }>('SELECT COUNT(*) AS count FROM groups')?.count ?? 0,
            apps: appRows.length,
          },
      mailboxes: mailRow?.enabled ? userMailboxes(auth.user) : [],
      events: auth.access.isAdmin ? recentEvents(6) : [],
      ldap: { configured: config.ldap.configured, mode: config.auth.mode },
    };
  });

  app.get<{ Querystring: { q?: string; limit?: string; offset?: string } }>(
    '/api/directory',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      if (!hasPermission(auth.access, 'users.read')) {
        return reply.code(403).send({ error: 'forbidden', required: 'users.read' });
      }
      const search = normalize(req.query.q ?? '');
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
      const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);

      const where = search ? "WHERE status = 'active' AND search_text LIKE ? ESCAPE '!'" : "WHERE status = 'active'";
      const params = search ? [`%${escapeLike(search)}%`] : [];
      const total = get<{ count: number }>(`SELECT COUNT(*) AS count FROM users ${where}`, ...params);
      const rows = all<UserRow>(
        `SELECT * FROM users ${where} ORDER BY display_name COLLATE NOCASE ASC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      );

      return { total: total?.count ?? 0, people: rows.map((user) => personFor(user, auth)) };
    },
  );

  app.get<{ Params: { username: string } }>(
    '/api/directory/:username',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      if (!hasPermission(auth.access, 'users.read')) {
        return reply.code(403).send({ error: 'forbidden', required: 'users.read' });
      }
      const user = findUserByUsername(req.params.username);
      if (!user || user.status === 'orphaned') {
        return reply.code(404).send({ error: 'not_found', message: 'Persona no encontrada.' });
      }
      const mailboxes =
        hasPermission(auth.access, 'mail.read')
          ? all('SELECT address, quota_mb, status FROM mailboxes WHERE user_id = ?', user.id)
          : [];
      return { person: personFor(user, auth), mailboxes };
    },
  );

  app.get('/api/apps', { preHandler: [requireAuth] }, async (req, reply) => {
    const auth = attachAuth(req)!;
    if (!hasPermission(auth.access, 'apps.read')) {
      return reply.code(403).send({ error: 'forbidden', required: 'apps.read' });
    }
    const rows = all<AppRow>('SELECT * FROM apps WHERE enabled = 1 ORDER BY sort ASC, name ASC').filter(
      (row) => !row.permission || hasPermission(auth.access, row.permission),
    );
    return { apps: rows.map(appFor) };
  });

  /** Endpoint de forward_auth para Caddy: identidad por cabeceras de confianza. */
  app.get('/api/gateway/auth', async (req, reply) => {
    const auth = attachAuth(req);
    if (!auth) {
      record({ action: 'gateway.deny', target: req.headers.host ?? '', result: 'fail', ip: req.ip });
      return reply.code(401).header('X-RedLBA-Login', `${config.baseUrl}/login`).send();
    }
    record({ actor: auth.user, action: 'gateway.access', target: req.headers.host ?? '', ip: req.ip });

    return reply
      .header('X-RedLBA-User', auth.user.username)
      .header('X-RedLBA-Email', auth.user.email ?? '')
      .header('X-RedLBA-Name', encodeURIComponent(auth.user.display_name))
      .header('X-RedLBA-Roles', auth.access.roles.join(','))
      .header('X-RedLBA-Groups', auth.groups.join(','))
      .code(200)
      .send();
  });

  app.get<{ Params: { key: string } }>('/api/modules/:key/settings', { preHandler: [requireAuth] }, async (req, reply) => {
    const auth = attachAuth(req)!;
    const row = visibleModules(auth.access).find((item) => item.key === req.params.key);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { module: publicModule(row, auth.access.isAdmin), settings: moduleSettings(row) };
  });
}
