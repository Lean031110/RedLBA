import { attachAuth } from '../core/auth.js';
import { hasPermission } from '../core/rbac.js';
import {
  listModuleRows,
  moduleUrl,
  runSearch,
  type RedlbaModule,
  type SearchResult,
} from '../core/module-registry.js';

interface Query {
  q?: string;
  limit?: string;
}

export const searchModule: RedlbaModule = {
  key: 'search',
  name: 'Buscador',
  description: 'Búsqueda unificada de personas, aplicaciones y accesos.',
  icon: 'search',
  defaultPath: '/search',
  requires: 'search.use',

  register(app, runtime) {
    app.get<{ Querystring: Query }>('/query', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      if (!hasPermission(auth.access, 'search.use')) {
        return reply.code(403).send({ error: 'forbidden', message: 'No tienes acceso al buscador.' });
      }

      const query = (req.query.q ?? '').trim();
      const minChars = Number(runtime.settings.minChars ?? 2);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 6) || 6, 1), 20);

      if (query.length < minChars) {
        return {
          query,
          minChars,
          providers: [],
          results: [] as SearchResult[],
          took: 0,
        };
      }

      const started = Date.now();
      const { results, providers } = await runSearch(query, auth, limit);
      return {
        query,
        minChars,
        providers,
        results: results.slice(0, 40),
        took: Date.now() - started,
      };
    });

    app.get<{ Querystring: Query }>('/suggest', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      if (!hasPermission(auth.access, 'search.use')) return { suggestions: [] };

      const query = (req.query.q ?? '').trim();
      if (query.length < 2) return { suggestions: [] };

      const { results } = await runSearch(query, auth, 3);
      return {
        suggestions: results.slice(0, 5).map((item) => ({
          title: item.title,
          subtitle: item.subtitle,
          href: item.href,
          module: item.module,
          icon: item.icon,
        })),
      };
    });
  },

  async search(query, auth, runtime, limit): Promise<SearchResult[]> {
    // El buscador aporta los enlaces a los demás módulos activos.
    const needle = query.toLowerCase();
    return listModuleRows()
      .filter((row) => row.enabled && row.key !== 'search')
      .filter((row) => !row.admin_only || auth.access.isAdmin)
      .filter((row) => row.name.toLowerCase().includes(needle) || row.key.includes(needle))
      .slice(0, limit)
      .map((row) => ({
        id: `module-${row.key}`,
        title: row.name,
        subtitle: row.description ?? 'Ir al módulo',
        href: moduleUrl(row),
        badge: 'Módulo',
        icon: row.icon,
        module: runtime.row.key,
      }));
  },
};
