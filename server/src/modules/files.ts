import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { attachAuth } from '../core/auth.js';
import { record } from '../core/audit.js';
import { hasPermission } from '../core/rbac.js';
import type { RedlbaModule, SearchResult } from '../core/module-registry.js';

const SHARED = 'shared';

interface Entry {
  name: string;
  type: 'file' | 'dir';
  size: number;
  mtime: string;
}

class FileError extends Error {
  status: number;
  code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Rutas relativas seguras: nunca se escapa de FILES_DIR y cada persona solo
 * ve su carpeta `u/<su id>` salvo que tenga `files.manage`.
 */
function resolvePath(relative: string): string {
  const clean = String(relative ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
  if (clean.split('/').includes('..')) {
    throw new FileError('invalid_path', 'Ruta no válida.', 400);
  }
  const absolute = path.resolve(config.files.root, clean);
  if (absolute !== config.files.root && !absolute.startsWith(config.files.root + path.sep)) {
    throw new FileError('invalid_path', 'Ruta no válida.', 400);
  }
  return absolute;
}

function normalizeRelative(relative: string): string {
  const clean = String(relative ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
  if (!clean || clean.split('/').includes('..')) {
    throw new FileError('invalid_path', 'Ruta no válida.', 400);
  }
  return clean;
}

function ownerOf(relative: string): string | null {
  const [first, second] = relative.split('/');
  return first === 'u' && second ? second : null;
}

async function ensureRoot(): Promise<void> {
  await mkdir(config.files.root, { recursive: true });
  await mkdir(path.join(config.files.root, SHARED), { recursive: true });
}

async function directorySize(absolute: string): Promise<number> {
  let total = 0;
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const target = path.join(absolute, entry.name);
    if (entry.isDirectory()) total += await directorySize(target);
    else total += (await stat(target)).size;
  }
  return total;
}

function allowed(
  relative: string,
  access: { isAdmin: boolean; userId: string },
  mode: 'read' | 'write',
): boolean {
  const owner = ownerOf(relative);
  if (owner) {
    if (owner === access.userId) return true;
    if (mode === 'read' && access.isAdmin) return true;
    return false;
  }
  // Compartido: lectura para todos; escritura para todos; borrar solo con permiso.
  if (mode === 'read') return true;
  return true;
}

function encodeHeader(value: string): string {
  return encodeURIComponent(value);
}

function decodeHeader(value: string | undefined): string {
  if (!value) throw new FileError('invalid_path', 'Falta la ruta del fichero.', 400);
  try {
    return normalizeRelative(decodeURIComponent(value));
  } catch {
    throw new FileError('invalid_path', 'Ruta no válida.', 400);
  }
}

/** Espacio de ficheros local: carpetas personales y un área compartida. */
export const filesModule: RedlbaModule = {
  key: 'files',
  name: 'Archivos',
  description: 'Espacio de ficheros personal y compartido del servidor, sin internet.',
  icon: 'file',
  defaultPath: '/files',

  register(app: FastifyInstance) {
    // Los errores de ruta/cuota se devuelven con su código en lugar de 500.
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof FileError) {
        return reply.code(error.status).send({ error: error.code, message: error.message });
      }
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      if (status >= 500) {
        return reply.code(500).send({ error: 'internal_error', message: 'Se produjo un error en el servidor.' });
      }
      return reply.code(status).send({ error: 'invalid_request', message: (error as Error).message });
    });
    const auth0 = async (req: FastifyRequest) => {
      const auth = attachAuth(req);
      if (!auth) {
        const error = new Error('Inicia sesión para continuar.') as Error & { statusCode?: number };
        error.statusCode = 401;
        throw error;
      }
      return auth;
    };

    const guard = async (req: FastifyRequest, relative: string, mode: 'read' | 'write') => {
      const auth = await auth0(req);
      if (!allowed(relative, { isAdmin: auth.access.isAdmin, userId: auth.user.id }, mode)) {
        throw new FileError('forbidden', 'No tienes acceso a esa carpeta.', 403);
      }
      return auth;
    };

    // El subida se recibe en binario plano: no hace falta multipart ni dependencias.
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: config.files.maxUploadMb * 1024 * 1024 },
      (_req, payload, done) => done(null, payload),
    );

    app.get<{ Querystring: { path?: string } }>('/list', async (req) => {
      const base = req.query.path ? normalizeRelative(req.query.path) : '';
      const auth = await guard(req, base || `${SHARED}/`, 'read');
      await ensureRoot();

      const absolute = resolvePath(base);
      const info = await stat(absolute).catch(() => null);
      if (!info) throw new FileError('not_found', 'La carpeta no existe.', 404);
      if (!info.isDirectory()) throw new FileError('not_a_dir', 'No es una carpeta.', 400);

      const items = await readdir(absolute, { withFileTypes: true });
      const entries: Entry[] = [];
      for (const item of items) {
        if (item.name.startsWith('.')) continue;
        const target = path.join(absolute, item.name);
        const stats = await stat(target).catch(() => null);
        if (!stats) continue;
        entries.push({
          name: item.name,
          type: stats.isDirectory() ? 'dir' : 'file',
          size: stats.size,
          mtime: stats.mtime.toISOString(),
        });
      }
      entries.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name, 'es') : a.type === 'dir' ? -1 : 1,
      );

      const usage = await directorySize(path.join(config.files.root, 'u', auth.user.id));
      const sharedUsage = await directorySize(path.join(config.files.root, SHARED));

      return {
        path: base,
        parent: base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '',
        entries,
        usageMb: Math.round((usage / 1_048_576) * 10) / 10,
        sharedMb: Math.round((sharedUsage / 1_048_576) * 10) / 10,
        quotaMb: config.files.quotaMb,
        maxUploadMb: config.files.maxUploadMb,
      };
    });

    app.get<{ Querystring: { path?: string } }>('/download', async (req, reply) => {
      const relative = decodeHeader(req.query.path ? encodeURIComponent(req.query.path) : undefined);
      const auth = await guard(req, relative, 'read');
      const absolute = resolvePath(relative);
      const info = await stat(absolute).catch(() => null);
      if (!info || !info.isFile()) throw new FileError('not_found', 'Fichero no encontrado.', 404);

      const name = path.basename(relative);
      record({ actor: auth.user, action: 'file.download', target: relative, ip: req.ip });
      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Length', String(info.size))
        .header(
          'Content-Disposition',
          `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        )
        .header('Cache-Control', 'no-store')
        .send(createReadStream(absolute));
    });

    app.post<{ Headers: { 'x-file-path'?: string } }>('/upload', { bodyLimit: config.files.maxUploadMb * 1024 * 1024 }, async (req, reply) => {
      const relative = decodeHeader(req.headers['x-file-path']);
      const auth = await guard(req, relative, 'write');

      const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
      if (parent) await guard(req, parent, 'write');

      const usage = await directorySize(path.join(config.files.root, 'u', auth.user.id));
      const content = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (usage + content.length > config.files.quotaMb * 1_048_576) {
        throw new FileError('quota', 'Has superado tu cuota de almacenamiento.', 413);
      }
      if (content.length === 0) {
        throw new FileError('empty', 'El fichero está vacío.', 400);
      }

      await ensureRoot();
      const absolute = resolvePath(relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content);

      record({
        actor: auth.user,
        action: 'file.upload',
        target: relative,
        detail: { bytes: content.length },
        ip: req.ip,
      });
      return { ok: true, path: relative, size: content.length };
    });

    app.post('/mkdir', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const relative = normalizeRelative(String(body.path ?? ''));
      await guard(req, relative, 'write');
      await ensureRoot();
      const absolute = resolvePath(relative);
      if (await stat(absolute).catch(() => null)) {
        return reply.code(409).send({ error: 'conflict', message: 'Ya existe esa carpeta.' });
      }
      await mkdir(absolute, { recursive: true });
      return { ok: true, path: relative };
    });

    app.post('/rename', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const from = normalizeRelative(String(body.from ?? ''));
      const to = normalizeRelative(String(body.to ?? ''));
      const auth = await guard(req, from, 'write');
      await guard(req, to, 'write');
      const source = resolvePath(from);
      const target = resolvePath(to);
      if (await stat(target).catch(() => null)) {
        return reply.code(409).send({ error: 'conflict', message: 'Ya existe en el destino.' });
      }
      await mkdir(path.dirname(target), { recursive: true });
      await rename(source, target);
      record({ actor: auth.user, action: 'file.rename', target: `${from} → ${to}`, ip: req.ip });
      return { ok: true, path: to };
    });

    app.post('/delete', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const relative = normalizeRelative(String(body.path ?? ''));
      const auth = await auth0(req);

      const owner = ownerOf(relative);
      const isShared = relative.startsWith(`${SHARED}/`);
      const canDelete = owner
        ? owner === auth.user.id
        : isShared
          ? hasPermission(auth.access, 'files.manage')
          : false;

      if (!canDelete) {
        return reply.code(403).send({ error: 'forbidden', message: 'No puedes borrar esa carpeta.' });
      }

      const absolute = resolvePath(relative);
      await rm(absolute, { recursive: true, force: true });
      record({ actor: auth.user, action: 'file.delete', target: relative, ip: req.ip });
      return { ok: true };
    });
  },

  async search(query, auth, _runtime, limit): Promise<SearchResult[]> {
    await ensureRoot();
    const roots: Array<[string, string]> = [
      [path.join(config.files.root, 'u', auth.user.id), `u/${auth.user.id}`],
      [path.join(config.files.root, SHARED), SHARED],
    ];
    const results: SearchResult[] = [];

    const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
      if (results.length >= limit || depth > 4) return;
      const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const item of items) {
        if (results.length >= limit) return;
        if (item.name.startsWith('.')) continue;
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory()) {
          if (item.name.toLowerCase().includes(query.toLowerCase())) {
            results.push({
              id: relative,
              title: item.name,
              subtitle: 'Carpeta',
              href: `${config.baseUrl}/files?path=${encodeURIComponent(relative)}`,
              icon: 'folder',
              module: 'files',
            });
          }
          await walk(path.join(dir, item.name), relative, depth + 1);
        } else if (item.name.toLowerCase().includes(query.toLowerCase())) {
          results.push({
            id: relative,
            title: item.name,
            subtitle: 'Archivo',
            href: `${config.baseUrl}/files?path=${encodeURIComponent(path.posix.dirname(relative))}`,
            icon: 'file',
            module: 'files',
          });
        }
      }
    };

    for (const [rootDir, prefix] of roots) {
      await walk(rootDir, prefix, 0);
    }
    return results;
  },
};
