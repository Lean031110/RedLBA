import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { attachAuth, type AuthContext } from './auth.js';
import { all, get, type ModuleRow } from './db.js';
import { hasPermission } from './rbac.js';
import { hostOf, parseJson } from './util.js';

export interface SearchResult {
  id: string;
  title: string;
  subtitle?: string;
  href: string;
  badge?: string;
  icon?: string;
  module: string;
}

export interface ModuleRuntime {
  row: ModuleRow;
  settings: Record<string, unknown>;
  urlBase: string;
}

export interface RedlbaModule {
  key: string;
  name: string;
  description: string;
  icon: string;
  defaultPath: string;
  adminOnly?: boolean;
  requires?: string;
  register(app: FastifyInstance, runtime: ModuleRuntime): void | Promise<void>;
  search?(
    query: string,
    auth: AuthContext,
    runtime: ModuleRuntime,
    limit: number,
  ): Promise<SearchResult[]>;
}

const registry = new Map<string, RedlbaModule>();

export function registerModule(module: RedlbaModule): void {
  registry.set(module.key, module);
}

export function listModuleDefinitions(): RedlbaModule[] {
  return [...registry.values()];
}

export function moduleDefinition(key: string): RedlbaModule | undefined {
  return registry.get(key);
}

export function getModuleRow(key: string): ModuleRow | undefined {
  return get<ModuleRow>('SELECT * FROM modules WHERE key = ?', key);
}

export function listModuleRows(): ModuleRow[] {
  return all<ModuleRow>('SELECT * FROM modules ORDER BY sort ASC, key ASC');
}

export function moduleEnabled(key: string): boolean {
  const row = getModuleRow(key);
  return Boolean(row?.enabled);
}

export function moduleSettings(row: ModuleRow): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(row.settings, {});
}

function scheme(): string {
  return config.baseUrl.startsWith('https://') ? 'https' : 'http';
}

export function moduleUrl(row: ModuleRow): string {
  if (row.hostname) {
    return `${scheme()}://${row.hostname}${row.path === '/' ? '' : row.path}`;
  }
  return row.path;
}

/** Módulo cuyo hostname coincide con la petición (si lo hay). */
export function moduleForHost(host: string | undefined): ModuleRow | undefined {
  const cleanHost = hostOf(host);
  if (!cleanHost) return undefined;
  return listModuleRows().find((row) => row.enabled && row.hostname === cleanHost);
}

export function visibleModules(access: AuthContext['access']): ModuleRow[] {
  return listModuleRows().filter((row) => {
    if (!row.enabled) return false;
    if (row.admin_only && !access.isAdmin) return false;
    const definition = registry.get(row.key);
    if (definition?.requires && !hasPermission(access, definition.requires)) return false;
    return true;
  });
}

export function publicModule(row: ModuleRow, isAdmin = false) {
  const definition = registry.get(row.key);
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    icon: row.icon,
    path: row.path,
    url: moduleUrl(row),
    hostname: row.hostname,
    enabled: Boolean(row.enabled),
    adminOnly: Boolean(row.admin_only),
    sort: row.sort,
    settings: isAdmin ? moduleSettings(row) : undefined,
    searchable: Boolean(definition?.search),
  };
}

/** Guarda común: módulo apagado ⇒ 404, módulo de admin ⇒ 403. */
export function moduleGuard(key: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const row = getModuleRow(key);
    if (!row || !row.enabled) {
      await reply
        .code(404)
        .send({ error: 'module_disabled', message: 'Este módulo no está activo.' });
      return;
    }
    if (row.admin_only) {
      const auth = attachAuth(req);
      if (!auth?.access.isAdmin) {
        await reply.code(403).send({ error: 'forbidden', message: 'Módulo solo para administradores.' });
        return;
      }
    }
    if (!attachAuth(req)) {
      await reply.code(401).send({ error: 'unauthorized', message: 'Inicia sesión para continuar.' });
    }
  };
}

/**
 * Runtime con getters: los cambios de nombre/dominio/ajustes se leen en cada
 * petición, así que activar o mover un módulo no exige reiniciar el servidor.
 */
export function runtimeFor(key: string): ModuleRuntime {
  return {
    get row() {
      return getModuleRow(key)!;
    },
    get settings() {
      const row = getModuleRow(key);
      return row ? moduleSettings(row) : {};
    },
    get urlBase() {
      const row = getModuleRow(key);
      return row ? moduleUrl(row) : '/';
    },
  };
}

export async function registerModules(app: FastifyInstance): Promise<void> {
  for (const definition of registry.values()) {
    if (!getModuleRow(definition.key)) continue;
    const runtime = runtimeFor(definition.key);

    await app.register(
      async (scope) => {
        scope.addHook('onRequest', moduleGuard(definition.key));
        await definition.register(scope, runtime);
      },
      { prefix: `/api/m/${definition.key}` },
    );
  }
}

/** Ejecuta todos los proveedores de búsqueda de los módulos activos. */
export async function runSearch(
  query: string,
  auth: AuthContext,
  limitPerProvider = 6,
): Promise<{ results: SearchResult[]; providers: string[] }> {
  const rows = visibleModules(auth.access);
  const results: SearchResult[] = [];
  const providers: string[] = [];

  for (const row of rows) {
    const definition = registry.get(row.key);
    if (!definition?.search) continue;
    providers.push(row.key);
    try {
      const found = await definition.search(query, auth, runtimeFor(row.key), limitPerProvider);
      results.push(...found);
    } catch (error) {
      app_log(`[search] proveedor ${row.key} falló: ${(error as Error).message}`);
    }
  }

  return { results, providers };
}

function app_log(message: string): void {
  console.warn(message);
}
