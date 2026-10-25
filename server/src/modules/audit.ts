import { attachAuth } from '../core/auth.js';
import { queryEvents } from '../core/audit.js';
import { hasPermission } from '../core/rbac.js';
import { csvCell, integer } from '../core/util.js';
import type { RedlbaModule } from '../core/module-registry.js';

interface Query {
  q?: string;
  actor?: string;
  action?: string;
  result?: string;
  from?: string;
  to?: string;
  page?: string;
  limit?: string;
}

function parseQuery(query: Query) {
  const limit = Math.min(integer(query.limit, 50), 200);
  const page = Math.max(integer(query.page, 1), 1);
  return {
    q: query.q?.trim() || undefined,
    actor: query.actor?.trim() || undefined,
    action: query.action?.trim() || undefined,
    result: query.result?.trim() || undefined,
    from: query.from || undefined,
    to: query.to || undefined,
    limit,
    offset: (page - 1) * limit,
  };
}

export const auditModule: RedlbaModule = {
  key: 'audit',
  name: 'Auditoría',
  description: 'Registro de accesos y cambios del servidor.',
  icon: 'activity',
  defaultPath: '/admin/audit',
  requires: 'audit.read',

  register(app) {
    app.get<{ Querystring: Query }>('/events', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      if (!hasPermission(auth.access, 'audit.read')) {
        return reply.code(403).send({ error: 'forbidden', required: 'audit.read' });
      }
      const { total, events } = queryEvents(parseQuery(req.query));
      return { total, events };
    });

    app.get<{ Querystring: Query }>('/events.csv', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      if (!hasPermission(auth.access, 'audit.read')) {
        return reply.code(403).send({ error: 'forbidden', required: 'audit.read' });
      }
      const { events } = queryEvents({ ...parseQuery(req.query), limit: 500 });
      const rows = events as Array<Record<string, unknown>>;
      const header = ['fecha', 'actor', 'accion', 'objetivo', 'resultado', 'ip', 'detalle'];
      const csv = [
        header.join(','),
        ...rows.map((event) =>
          [
            event.at,
            event.actor_username,
            event.action,
            event.target,
            event.result,
            event.ip,
            event.detail,
          ]
            .map(csvCell)
            .join(','),
        ),
      ].join('\n');

      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="redlba-auditoria.csv"');
      return reply.send(`\uFEFF${csv}`);
    });
  },
};
