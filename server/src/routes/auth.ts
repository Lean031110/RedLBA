import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { record } from '../core/audit.js';
import {
  attachAuth,
  AuthFailure,
  clearAttempts,
  clearSessionCookie,
  login,
  logout,
  publicUser,
  registerAttempt,
  requireAuth,
  revokeUserSessions,
  sessionsOf,
  setSessionCookie,
  tooManyAttempts,
} from '../core/auth.js';
import { getSetting, run } from '../core/db.js';
import { findUserById, updatePerson } from '../core/identity.js';
import { authenticateUser, ldapEnabled, setPassword } from '../core/ldap.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../core/passwords.js';
import { effectiveAccess } from '../core/rbac.js';
import { nowIso, text } from '../core/util.js';

function serializeSessions(userId: string) {
  return sessionsOf(userId).map((session) => ({
    id: session.id,
    createdAt: session.created_at,
    lastSeenAt: session.last_seen_at,
    expiresAt: session.expires_at,
    ip: session.ip,
    userAgent: session.user_agent,
  }));
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { username?: string; password?: string } }>(
    '/api/auth/login',
    async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const username = text(body.username, 80)?.toLowerCase() ?? '';
      const password = typeof body.password === 'string' ? body.password : '';
      const key = `${req.ip}:${username}`;

      if (tooManyAttempts(key)) {
        record({ action: 'auth.login', target: username, result: 'fail', detail: 'rate_limit', ip: req.ip });
        return reply
          .code(429)
          .send({ error: 'rate_limited', message: 'Demasiados intentos. Espera unos minutos.' });
      }

      try {
        const result = await login(username, password, {
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        clearAttempts(key);
        setSessionCookie(reply, result.session.id);
        record({ actor: result.user, action: 'auth.login', result: 'ok', ip: req.ip });

        const access = effectiveAccess(result.user.id);
        return {
          user: publicUser(result.user, access),
          roles: result.roles,
          permissions: result.permissions,
          groups: result.groups,
          csrfToken: result.session.csrf,
          mustChangePassword: Boolean(result.user.must_change_password),
        };
      } catch (error) {
        registerAttempt(key);
        const failure = error instanceof AuthFailure ? error : null;
        record({
          action: 'auth.login',
          target: username,
          result: 'fail',
          detail: failure?.code ?? 'error',
          ip: req.ip,
        });
        const status = failure?.code === 'ldap_unreachable' ? 503 : 401;
        return reply.code(status).send({
          error: failure?.code ?? 'invalid_credentials',
          message: failure?.message ?? 'No se pudo iniciar sesión.',
        });
      }
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const auth = attachAuth(req);
    if (auth) {
      logout(auth.session.id);
      record({ actor: auth.user, action: 'auth.logout', ip: req.ip });
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    const auth = attachAuth(req);
    if (!auth) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Sin sesión activa.' });
    }
    return {
      user: publicUser(auth.user, auth.access),
      roles: auth.access.roles,
      permissions: auth.access.permissions,
      groups: auth.groups,
      csrfToken: auth.csrfToken,
      site: {
        name: getSetting('site_name', 'RedLBA'),
        tagline: getSetting('site_tagline', ''),
        domain: config.domain,
        baseUrl: config.baseUrl,
        supportEmail: getSetting('support_email', ''),
      },
      ldap: { enabled: ldapEnabled(), mode: config.auth.mode },
    };
  });

  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    '/api/auth/password',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

      const policy = checkPasswordPolicy(newPassword, auth.user.username);
      if (!policy.ok) {
        return reply.code(400).send({ error: 'weak_password', message: policy.message });
      }

      let verified = false;
      if (auth.user.password_hash) {
        verified = verifyPassword(currentPassword, auth.user.password_hash);
      }
      if (!verified && auth.user.source === 'ldap' && ldapEnabled()) {
        try {
          await authenticateUser(auth.user.username, currentPassword);
          verified = true;
        } catch {
          verified = false;
        }
      }
      if (!verified) {
        record({ actor: auth.user, action: 'auth.password', result: 'fail', ip: req.ip });
        return reply
          .code(400)
          .send({ error: 'invalid_password', message: 'La contraseña actual no es correcta.' });
      }

      if (auth.user.source === 'ldap' && auth.user.ldap_dn && ldapEnabled()) {
        await setPassword(auth.user.ldap_dn, newPassword);
      } else {
        run(
          'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
          hashPassword(newPassword),
          nowIso(),
          auth.user.id,
        );
      }

      run('UPDATE users SET must_change_password = 0 WHERE id = ?', auth.user.id);
      revokeUserSessions(auth.user.id, auth.session.id);
      record({ actor: auth.user, action: 'auth.password', result: 'ok', ip: req.ip });
      return { ok: true };
    },
  );

  app.get('/api/sessions', { preHandler: [requireAuth] }, async (req) => {
    const auth = attachAuth(req)!;
    return { sessions: serializeSessions(auth.user.id), current: auth.session.id };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/sessions/:id',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const session = sessionsOf(auth.user.id).find((item) => item.id === req.params.id);
      if (!session) return reply.code(404).send({ error: 'not_found' });
      logout(session.id);
      if (auth.session.id === session.id) clearSessionCookie(reply);
      record({ actor: auth.user, action: 'auth.session.revoke', target: req.params.id, ip: req.ip });
      return { ok: true };
    },
  );

  app.get('/api/profile', { preHandler: [requireAuth] }, async (req) => {
    const auth = attachAuth(req)!;
    const user = findUserById(auth.user.id)!;
    return {
      user: publicUser(user, auth.access),
      groups: auth.groups,
      sessions: serializeSessions(user.id),
    };
  });

  app.patch<{ Body: Record<string, unknown> }>(
    '/api/profile',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};

      if (body.firstName !== undefined) patch.firstName = text(body.firstName, 80) ?? '';
      if (body.lastName !== undefined) patch.lastName = text(body.lastName, 80) ?? '';
      if (body.displayName !== undefined) {
        const displayName = text(body.displayName, 120);
        if (displayName) patch.displayName = displayName;
      }
      if (body.title !== undefined) patch.title = text(body.title, 120) ?? '';
      if (body.department !== undefined) patch.department = text(body.department, 120) ?? '';
      if (body.phone !== undefined) patch.phone = text(body.phone, 40) ?? '';
      if (body.bio !== undefined) patch.bio = text(body.bio, 600) ?? '';
      if (body.avatarUrl !== undefined) {
        const avatar = text(body.avatarUrl, 400);
        if (avatar && !/^https?:\/\//i.test(avatar)) {
          return reply
            .code(400)
            .send({ error: 'invalid_avatar', message: 'El avatar debe ser una URL http(s).' });
        }
        patch.avatarUrl = avatar ?? '';
      }
      if (body.profileVisibility !== undefined) {
        const visibility = String(body.profileVisibility);
        if (['public', 'organization', 'private'].includes(visibility)) {
          patch.profileVisibility = visibility;
        }
      }

      const updated = updatePerson(auth.user, patch as never);
      record({ actor: auth.user, action: 'profile.update', target: auth.user.username, ip: req.ip });
      return { user: publicUser(updated, effectiveAccess(updated.id)) };
    },
  );

  app.post('/api/auth/refresh', { preHandler: [requireAuth] }, async (req) => {
    const auth = attachAuth(req)!;
    const user = findUserById(auth.user.id)!;
    return {
      user: publicUser(user, effectiveAccess(user.id)),
      groups: auth.groups,
    };
  });
}
