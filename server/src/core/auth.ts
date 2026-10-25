import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { get, run, type SessionRow, type UserRow, all } from './db.js';
import {
  findUserByUsername,
  findUserById,
  groupsOf,
  upsertFromLdap,
} from './identity.js';
import { authenticateUser, LdapError, ldapEnabled } from './ldap.js';
import { verifyPassword } from './passwords.js';
import { effectiveAccess, hasPermission, type EffectiveAccess } from './rbac.js';
import { newId, nowIso, randomToken } from './util.js';

export const SESSION_COOKIE = 'redlba_session';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export interface AuthContext {
  user: UserRow;
  session: SessionRow;
  access: EffectiveAccess;
  groups: string[];
  csrfToken: string;
}

/* ------------------------------------------------------------------ cookies */

function signature(value: string): string {
  return createHmac('sha256', config.secretKey).update(value).digest('hex').slice(0, 40);
}

function signedValue(sessionId: string): string {
  return `${sessionId}.${signature(sessionId)}`;
}

function readSignedCookie(raw: string | undefined): string | null {
  if (!raw) return null;
  const index = raw.lastIndexOf('.');
  if (index <= 0) return null;
  const id = raw.slice(0, index);
  const provided = raw.slice(index + 1);
  const expected = signature(id);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return null;
  return id;
}

export function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(SESSION_COOKIE, signedValue(sessionId), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.baseUrl.startsWith('https://'),
    domain: config.cookieDomain,
    maxAge: config.sessionMaxDays * 86400,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    domain: config.cookieDomain,
  });
}

/* ----------------------------------------------------------------- sessions */

function sessionFor(req: FastifyRequest): { session: SessionRow; user: UserRow } | null {
  const id = readSignedCookie(req.cookies?.[SESSION_COOKIE]);
  if (!id) return null;

  const session = get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id);
  if (!session) return null;

  const now = new Date();
  if (new Date(session.expires_at) <= now) {
    run('DELETE FROM sessions WHERE id = ?', id);
    return null;
  }

  const user = findUserById(session.user_id);
  if (!user || user.status !== 'active') return null;

  const maxExpiry = new Date(new Date(session.created_at).getTime() + config.sessionMaxDays * 86400_000);
  const idleLimit = new Date(now.getTime() + config.sessionTtlHours * 3600_000);
  const nextExpiry = new Date(Math.min(maxExpiry.getTime(), idleLimit.getTime()));

  const stale = now.getTime() - new Date(session.last_seen_at).getTime() > 60_000;
  if (stale) {
    run(
      'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?',
      now.toISOString(),
      nextExpiry.toISOString(),
      id,
    );
    session.last_seen_at = now.toISOString();
    session.expires_at = nextExpiry.toISOString();
  }

  return { session, user };
}

export function currentAuth(req: FastifyRequest): AuthContext | undefined {
  return req.auth;
}

/** Carga la sesión en la request si existe. Idempotente. */
export function attachAuth(req: FastifyRequest): AuthContext | undefined {
  if (req.auth) return req.auth;
  const found = sessionFor(req);
  if (!found) return undefined;

  const access = effectiveAccess(found.user.id);
  req.auth = {
    user: found.user,
    session: found.session,
    access,
    groups: groupsOf(found.user.id),
    csrfToken: found.session.csrf,
  };
  return req.auth;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = attachAuth(req);
  if (!auth) {
    await reply.code(401).send({ error: 'unauthorized', message: 'Inicia sesión para continuar.' });
  }
}

export function requirePermission(permission: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = attachAuth(req);
    if (!auth) {
      await reply.code(401).send({ error: 'unauthorized', message: 'Inicia sesión para continuar.' });
      return;
    }
    if (!hasPermission(auth.access, permission)) {
      await reply
        .code(403)
        .send({ error: 'forbidden', message: 'No tienes permiso para esta acción.', required: permission });
    }
  };
}

export function requireAnyPermission(permissions: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = attachAuth(req);
    if (!auth) {
      await reply.code(401).send({ error: 'unauthorized', message: 'Inicia sesión para continuar.' });
      return;
    }
    if (!permissions.some((permission) => hasPermission(auth.access, permission))) {
      await reply
        .code(403)
        .send({ error: 'forbidden', message: 'No tienes permiso para esta acción.' });
    }
  };
}

/* ------------------------------------------------------------------- origin */

function allowedOrigins(req: FastifyRequest): Set<string> {
  const origins = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    try {
      origins.add(new URL(value).origin);
    } catch {
      /* ignorado */
    }
  };
  add(config.baseUrl);
  const host = req.headers.host;
  if (host) {
    add(`https://${host}`);
    add(`http://${host}`);
  }
  for (const row of all<{ hostname: string }>(
    "SELECT hostname FROM modules WHERE hostname IS NOT NULL AND hostname != ''",
  )) {
    add(`https://${row.hostname}`);
    add(`http://${row.hostname}`);
  }
  return origins;
}

export function assertSameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // clientes no navegador; se exige CSRF igualmente
  return allowedOrigins(req).has(origin);
}

/** Hook global para mutaciones de /api. */
export async function mutationGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.url.startsWith('/api')) return;
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

  if (!assertSameOrigin(req)) {
    await reply.code(403).send({ error: 'forbidden_origin', message: 'Origen no permitido.' });
    return;
  }

  if (req.url.startsWith('/api/auth/login')) return;

  const auth = attachAuth(req);
  if (!auth) {
    await reply.code(401).send({ error: 'unauthorized', message: 'Inicia sesión para continuar.' });
    return;
  }

  const token = req.headers['x-redlba-csrf'];
  if (typeof token !== 'string' || token !== auth.csrfToken) {
    await reply.code(403).send({ error: 'csrf', message: 'Token CSRF inválido. Recarga la página.' });
  }
}

/* --------------------------------------------------------------------- login */

export interface LoginResult {
  user: UserRow;
  session: SessionRow;
  roles: string[];
  permissions: string[];
  groups: string[];
}

export class AuthFailure extends Error {
  code: 'invalid_credentials' | 'disabled' | 'ldap_unreachable' | 'local_only';

  constructor(code: AuthFailure['code'], message: string) {
    super(message);
    this.name = 'AuthFailure';
    this.code = code;
  }
}

const attempts = new Map<string, { count: number; first: number }>();

export function tooManyAttempts(key: string): boolean {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > 5 * 60_000) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= 10;
}

export function registerAttempt(key: string): void {
  const entry = attempts.get(key);
  if (!entry) {
    attempts.set(key, { count: 1, first: Date.now() });
    return;
  }
  entry.count += 1;
}

export function clearAttempts(key: string): void {
  attempts.delete(key);
}

export async function login(
  usernameInput: string,
  password: string,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<LoginResult> {
  const username = usernameInput.trim().toLowerCase();
  if (!username || !password) {
    throw new AuthFailure('invalid_credentials', 'Credenciales incorrectas.');
  }

  let user: UserRow | undefined;
  let viaLdap = false;

  const localUser = findUserByUsername(username);
  // AUTH_MODE=ldap desactiva por completo las contraseñas locales.
  if (
    config.auth.mode !== 'ldap' &&
    localUser?.password_hash &&
    verifyPassword(password, localUser.password_hash)
  ) {
    user = localUser;
  }

  if (!user && config.auth.mode !== 'local' && ldapEnabled()) {
    try {
      const authenticated = await authenticateUser(username, password);
      user = upsertFromLdap(authenticated.person);
      viaLdap = true;
    } catch (error) {
      if (error instanceof LdapError && error.code === 'unreachable' && !localUser) {
        throw new AuthFailure('ldap_unreachable', 'El directorio no está disponible. Avisa al administrador.');
      }
    }
  }

  if (!user) {
    throw new AuthFailure('invalid_credentials', 'Credenciales incorrectas.');
  }

  if (user.status !== 'active') {
    throw new AuthFailure('disabled', 'La cuenta está desactivada. Contacta con soporte.');
  }

  const sessionId = newId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.min(config.sessionTtlHours * 3600_000, config.sessionMaxDays * 86400_000));
  const csrf = randomToken(24);

  run(
    `INSERT INTO sessions (id, user_id, csrf, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionId,
    user.id,
    csrf,
    meta.ip ?? null,
    (meta.userAgent ?? '').slice(0, 250),
    now.toISOString(),
    now.toISOString(),
    expiresAt.toISOString(),
  );
  run('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', now.toISOString(), now.toISOString(), user.id);

  const access = effectiveAccess(user.id);

  return {
    user,
    session: get<SessionRow>('SELECT * FROM sessions WHERE id = ?', sessionId)!,
    roles: access.roles,
    permissions: access.permissions,
    groups: groupsOf(user.id),
  };
}

export function logout(sessionId: string): void {
  run('DELETE FROM sessions WHERE id = ?', sessionId);
}

export function revokeUserSessions(userId: string, exceptSessionId?: string): number {
  const result = exceptSessionId
    ? run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, exceptSessionId)
    : run('DELETE FROM sessions WHERE user_id = ?', userId);
  return result.changes;
}

export function sessionsOf(userId: string): SessionRow[] {
  return all<SessionRow>(
    'SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC',
    userId,
  );
}

export function publicUser(user: UserRow, access?: EffectiveAccess) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.display_name,
    firstName: user.first_name,
    lastName: user.last_name,
    title: user.title,
    department: user.department,
    phone: user.phone,
    bio: user.bio,
    avatarUrl: user.avatar_url,
    profileVisibility: user.profile_visibility,
    source: user.source,
    status: user.status,
    roles: access?.roles ?? [],
    permissions: access?.permissions ?? [],
    isAdmin: access?.isAdmin ?? false,
    mustChangePassword: Boolean(user.must_change_password),
    lastLoginAt: user.last_login_at,
    createdAt: user.created_at,
  };
}
