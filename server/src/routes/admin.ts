import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { record } from '../core/audit.js';
import {
  attachAuth,
  publicUser,
  requireAnyPermission,
  requirePermission,
  revokeUserSessions,
  sessionsOf,
} from '../core/auth.js';
import { all, get, getSetting, run, setSetting, type UserRow } from '../core/db.js';
import {
  changeGroups,
  createPerson,
  findUserById,
  groupsOf,
  removePerson,
  syncDirectory,
  updatePerson,
  applyDirectRoles,
  pushPersonToLdap,
} from '../core/identity.js';
import { healthCheck, ldapEnabled, setPassword } from '../core/ldap.js';
import { checkPasswordPolicy, generateTempPassword, hashPassword } from '../core/passwords.js';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  assignRole,
  createRole,
  effectiveAccess,
  listRoles,
  removeBinding,
  roleUsage,
  sanitizePermissions,
} from '../core/rbac.js';
import { ensureModules, stats, recentEvents } from '../core/seed.js';
import * as oidc from '../core/oidc.js';
import { listModuleRows, publicModule } from '../core/module-registry.js';
import { appFor } from '../core/serialize.js';
import { escapeLike, integer, isEmail, newId, normalize, nowIso, text, truthy } from '../core/util.js';
import { userMailboxes } from '../modules/mail.js';

function adminUserView(user: UserRow) {
  const access = effectiveAccess(user.id);
  return {
    ...publicUser(user, access),
    groups: groupsOf(user.id),
  };
}

function ownerCount(): number {
  const row = get<{ count: number }>(
    `SELECT COUNT(DISTINCT u.id) AS count FROM users u
       JOIN role_bindings rb ON rb.subject_type = 'user' AND rb.subject_value = u.id
       JOIN roles r ON r.id = rb.role_id
      WHERE r.key = 'owner' AND u.status = 'active'`,
  );
  return row?.count ?? 0;
}

function isOwner(userId: string): boolean {
  const row = get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM role_bindings rb JOIN roles r ON r.id = rb.role_id
      WHERE r.key = 'owner' AND rb.subject_type = 'user' AND rb.subject_value = ?`,
    userId,
  );
  return (row?.count ?? 0) > 0;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------- overview */

  app.get('/api/admin/overview', { preHandler: [requirePermission('admin.access')] }, async () => {
    const ldap = await healthCheck();
    return {
      stats: { ...stats(), sessions: get<{ count: number }>('SELECT COUNT(*) AS count FROM sessions')?.count ?? 0 },
      ldap,
      events: recentEvents(10),
      modules: listModuleRows().map((row) => publicModule(row, true)),
      config: {
        version: config.version,
        domain: config.domain,
        baseUrl: config.baseUrl,
        authMode: config.auth.mode,
        mailDriver: config.mail.driver,
        mailDomain: config.mail.domain,
        cookieDomain: config.cookieDomain ?? null,
      },
    };
  });

  /* ---------------------------------------------------------------- users */

  app.get<{ Querystring: { q?: string; status?: string; page?: string; limit?: string } }>(
    '/api/admin/users',
    { preHandler: [requirePermission('users.read')] },
    async (req) => {
      const limit = Math.min(integer(req.query.limit, 25), 100);
      const page = Math.max(integer(req.query.page, 1), 1);
      const search = normalize(req.query.q ?? '');
      const status = req.query.status?.trim() ?? '';

      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (search) {
        clauses.push("(search_text LIKE ? ESCAPE '!' OR username LIKE ?)");
        params.push(`%${escapeLike(search)}%`, `%${escapeLike(search)}%`);
      }
      if (status && ['active', 'disabled', 'orphaned'].includes(status)) {
        clauses.push('status = ?');
        params.push(status);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const total = get<{ count: number }>(`SELECT COUNT(*) AS count FROM users ${where}`, ...params);

      const rows = all<UserRow>(
        `SELECT * FROM users ${where} ORDER BY display_name COLLATE NOCASE ASC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        (page - 1) * limit,
      );

      return {
        total: total?.count ?? 0,
        page,
        limit,
        users: rows.map(adminUserView),
        availableGroups: all<{ name: string }>('SELECT name FROM groups ORDER BY name').map((row) => row.name),
      };
    },
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/api/admin/users',
    { preHandler: [requirePermission('users.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const firstName = text(body.firstName, 80) ?? '';
      const lastName = text(body.lastName, 80) ?? '';
      const username = text(body.username, 40) ?? '';

      if (!firstName || !lastName) {
        return reply.code(400).send({ error: 'invalid', message: 'Nombre y apellidos son obligatorios.' });
      }
      if (!username) {
        return reply.code(400).send({ error: 'invalid', message: 'El nombre de usuario es obligatorio.' });
      }
      const email = text(body.email, 160);
      if (email && !isEmail(email)) {
        return reply.code(400).send({ error: 'invalid', message: 'El correo no es válido.' });
      }

      const groups = Array.isArray(body.groups)
        ? body.groups.filter((item): item is string => typeof item === 'string')
        : [];
      const roleKeys = Array.isArray(body.roles)
        ? body.roles.filter((item): item is string => typeof item === 'string')
        : ['user'];

      try {
        const created = await createPerson({
          username,
          firstName,
          lastName,
          email: email ?? null,
          title: text(body.title, 120) ?? null,
          department: text(body.department, 120) ?? null,
          phone: text(body.phone, 40) ?? null,
          password: text(body.password, 200) ?? null,
          groups,
          roleKeys,
          source: body.source === 'local' ? 'local' : 'ldap',
        });

        record({
          actor: auth.user,
          action: 'user.create',
          target: created.user.username,
          detail: { source: created.user.source, groups, roles: roleKeys },
          ip: req.ip,
        });

        return reply.code(201).send({
          user: adminUserView(created.user),
          tempPassword: created.tempPassword,
          warnings: created.warnings,
        });
      } catch (error) {
        const failure = error as { statusCode?: number; message?: string };
        return reply
          .code(failure.statusCode ?? 500)
          .send({ error: 'create_failed', message: failure.message ?? 'No se pudo crear la persona.' });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/admin/users/:id',
    { preHandler: [requirePermission('users.read')] },
    async (req, reply) => {
      const user = findUserById(req.params.id);
      if (!user) return reply.code(404).send({ error: 'not_found' });
      return {
        user: adminUserView(user),
        sessions: sessionsOf(user.id).map((session) => ({
          id: session.id,
          createdAt: session.created_at,
          lastSeenAt: session.last_seen_at,
          expiresAt: session.expires_at,
          ip: session.ip,
        })),
        mailboxes: userMailboxes(user),
        roleBindings: all<{ id: string; role_id: string; key: string; name: string }>(
          `SELECT rb.id, r.id AS role_id, r.key, r.name FROM role_bindings rb
             JOIN roles r ON r.id = rb.role_id
            WHERE rb.subject_type = 'user' AND rb.subject_value = ?`,
          user.id,
        ),
      };
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/admin/users/:id',
    { preHandler: [requirePermission('users.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const user = findUserById(req.params.id);
      if (!user) return reply.code(404).send({ error: 'not_found' });

      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      if (body.firstName !== undefined) patch.firstName = text(body.firstName, 80) ?? '';
      if (body.lastName !== undefined) patch.lastName = text(body.lastName, 80) ?? '';
      if (body.displayName !== undefined) patch.displayName = text(body.displayName, 120) ?? user.display_name;
      if (body.email !== undefined) {
        const email = text(body.email, 160);
        if (email && !isEmail(email)) {
          return reply.code(400).send({ error: 'invalid', message: 'Correo no válido.' });
        }
        patch.email = email ?? '';
      }
      if (body.title !== undefined) patch.title = text(body.title, 120) ?? '';
      if (body.department !== undefined) patch.department = text(body.department, 120) ?? '';
      if (body.phone !== undefined) patch.phone = text(body.phone, 40) ?? '';
      if (body.status !== undefined) {
        const status = String(body.status);
        if (!['active', 'disabled'].includes(status)) {
          return reply.code(400).send({ error: 'invalid', message: 'Estado no válido.' });
        }
        if (status === 'disabled' && user.id === auth.user.id) {
          return reply.code(400).send({ error: 'invalid', message: 'No puedes desactivar tu propia cuenta.' });
        }
        if (status === 'disabled' && isOwner(user.id) && ownerCount() <= 1) {
          return reply
            .code(400)
            .send({ error: 'invalid', message: 'Debe quedar al menos un propietario activo.' });
        }
        patch.status = status;
        if (status === 'disabled') revokeUserSessions(user.id);
      }

      const updated = updatePerson(user, patch as never);
      const ldapResult = await pushPersonToLdap(updated, patch as Record<string, string>);
      record({
        actor: auth.user,
        action: 'user.update',
        target: updated.username,
        detail: { fields: Object.keys(patch), ldap: ldapResult.ok ? 'ok' : ldapResult.error },
        ip: req.ip,
      });

      return { user: adminUserView(updated), warnings: ldapResult.ok ? [] : [ldapResult.error] };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/admin/users/:id',
    { preHandler: [requirePermission('users.delete')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const user = findUserById(req.params.id);
      if (!user) return reply.code(404).send({ error: 'not_found' });
      if (user.id === auth.user.id) {
        return reply.code(400).send({ error: 'invalid', message: 'No puedes eliminar tu propia cuenta.' });
      }
      if (isOwner(user.id) && ownerCount() <= 1) {
        return reply
          .code(400)
          .send({ error: 'invalid', message: 'Debe quedar al menos un propietario activo.' });
      }
      await removePerson(user);
      record({ actor: auth.user, action: 'user.delete', target: user.username, ip: req.ip });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { password?: string } }>(
    '/api/admin/users/:id/password',
    { preHandler: [requirePermission('users.password')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const user = findUserById(req.params.id);
      if (!user) return reply.code(404).send({ error: 'not_found' });

      const provided = text(req.body?.password, 200);
      const password = provided ?? generateTempPassword();
      const policy = checkPasswordPolicy(password, user.username);
      if (!policy.ok) {
        return reply.code(400).send({ error: 'weak_password', message: policy.message });
      }

      if (user.source === 'ldap' && user.ldap_dn && ldapEnabled()) {
        await setPassword(user.ldap_dn, password);
        run('UPDATE users SET must_change_password = 1, updated_at = ? WHERE id = ?', nowIso(), user.id);
      } else {
        run(
          'UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?',
          hashPassword(password),
          nowIso(),
          user.id,
        );
      }

      revokeUserSessions(user.id);
      record({ actor: auth.user, action: 'user.password_reset', target: user.username, ip: req.ip });
      return { ok: true, tempPassword: provided ? undefined : password };
    },
  );

  app.post<{ Params: { id: string }; Body: { roles?: string[] } }>(
    '/api/admin/users/:id/roles',
    { preHandler: [requirePermission('roles.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const user = findUserById(req.params.id);
      if (!user) return reply.code(404).send({ error: 'not_found' });

      const roleKeys = Array.isArray(req.body?.roles)
        ? [...new Set(req.body.roles.filter((item): item is string => typeof item === 'string'))]
        : [];

      if (user.id === auth.user.id && isOwner(user.id) && !roleKeys.includes('owner')) {
        return reply
          .code(400)
          .send({ error: 'invalid', message: 'No puedes quitarte el rol de propietario.' });
      }
      if (isOwner(user.id) && !roleKeys.includes('owner') && ownerCount() <= 1) {
        return reply
          .code(400)
          .send({ error: 'invalid', message: 'Debe quedar al menos un propietario.' });
      }

      run("DELETE FROM role_bindings WHERE subject_type = 'user' AND subject_value = ?", user.id);
      applyDirectRoles(user.id, roleKeys);
      record({ actor: auth.user, action: 'user.roles', target: user.username, detail: { roles: roleKeys }, ip: req.ip });
      return { user: adminUserView(user) };
    },
  );

  app.post<{ Params: { id: string }; Body: { groups?: string[] } }>(
    '/api/admin/users/:id/groups',
    { preHandler: [requirePermission('groups.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const user = findUserById(req.params.id);
      if (!user) return reply.code(404).send({ error: 'not_found' });
      const groups = Array.isArray(req.body?.groups)
        ? req.body.groups.filter((item): item is string => typeof item === 'string')
        : [];

      await changeGroups(user, groups);
      record({ actor: auth.user, action: 'user.groups', target: user.username, detail: { groups }, ip: req.ip });
      return { user: adminUserView(user) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/users/:id/disable',
    { preHandler: [requirePermission('users.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const user = findUserById(req.params.id);
      if (!user) return reply.code(404).send({ error: 'not_found' });
      if (user.id === auth.user.id) {
        return reply.code(400).send({ error: 'invalid', message: 'No puedes desactivar tu cuenta.' });
      }
      if (isOwner(user.id) && ownerCount() <= 1) {
        return reply.code(400).send({ error: 'invalid', message: 'Debe quedar al menos un propietario.' });
      }
      updatePerson(user, { status: 'disabled' });
      revokeUserSessions(user.id);
      record({ actor: auth.user, action: 'user.disable', target: user.username, ip: req.ip });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/users/:id/enable',
    { preHandler: [requirePermission('users.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const user = findUserById(req.params.id);
      if (!user) return reply.code(404).send({ error: 'not_found' });
      updatePerson(user, { status: 'active' });
      record({ actor: auth.user, action: 'user.enable', target: user.username, ip: req.ip });
      return { ok: true };
    },
  );

  /* --------------------------------------------------------------- groups */

  app.get('/api/admin/groups', { preHandler: [requirePermission('groups.read')] }, async () => {
    const groups = all<{ id: string; name: string; description: string | null; source: string }>(
      'SELECT * FROM groups ORDER BY name ASC',
    ).map((group) => ({
      ...group,
      members: all<{ id: string; username: string; display_name: string }>(
        `SELECT u.id, u.username, u.display_name FROM group_members gm
           JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY u.display_name`,
        group.id,
      ),
      roles: all<{ key: string; name: string }>(
        `SELECT r.key, r.name FROM role_bindings rb JOIN roles r ON r.id = rb.role_id
          WHERE rb.subject_type = 'group' AND rb.subject_value = ?`,
        group.name,
      ),
    }));
    return { groups };
  });

  app.post<{ Body: { name?: string; description?: string } }>(
    '/api/admin/groups',
    { preHandler: [requirePermission('groups.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const name = text(req.body?.name, 60);
      if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,58}$/.test(name)) {
        return reply.code(400).send({ error: 'invalid', message: 'Nombre de grupo no válido.' });
      }
      if (get('SELECT id FROM groups WHERE name = ?', name)) {
        return reply.code(409).send({ error: 'conflict', message: 'Ese grupo ya existe.' });
      }
      const id = newId();
      run(
        'INSERT INTO groups (id, name, description, source, created_at) VALUES (?, ?, ?, ?, ?)',
        id,
        name,
        text(req.body?.description, 200) ?? null,
        'local',
        nowIso(),
      );
      record({ actor: auth.user, action: 'group.create', target: name, ip: req.ip });
      return reply.code(201).send({ group: { id, name, description: req.body?.description ?? null, source: 'local' } });
    },
  );

  app.patch<{ Params: { id: string }; Body: { description?: string } }>(
    '/api/admin/groups/:id',
    { preHandler: [requirePermission('groups.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const group = get<{ id: string; name: string }>('SELECT id, name FROM groups WHERE id = ?', req.params.id);
      if (!group) return reply.code(404).send({ error: 'not_found' });
      run('UPDATE groups SET description = ? WHERE id = ?', text(req.body?.description, 200) ?? null, group.id);
      record({ actor: auth.user, action: 'group.update', target: group.name, ip: req.ip });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/admin/groups/:id',
    { preHandler: [requirePermission('groups.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const group = get<{ id: string; name: string; source: string }>(
        'SELECT id, name, source FROM groups WHERE id = ?',
        req.params.id,
      );
      if (!group) return reply.code(404).send({ error: 'not_found' });
      if (group.source === 'ldap') {
        return reply
          .code(400)
          .send({ error: 'invalid', message: 'Los grupos de LDAP se gestionan en el directorio.' });
      }
      run('DELETE FROM group_members WHERE group_id = ?', group.id);
      run('DELETE FROM groups WHERE id = ?', group.id);
      run("DELETE FROM role_bindings WHERE subject_type = 'group' AND subject_value = ?", group.name);
      record({ actor: auth.user, action: 'group.delete', target: group.name, ip: req.ip });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { userId?: string } }>(
    '/api/admin/groups/:id/members',
    { preHandler: [requirePermission('groups.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const group = get<{ id: string; name: string; source: string }>(
        'SELECT id, name, source FROM groups WHERE id = ?',
        req.params.id,
      );
      const user = findUserById(text(req.body?.userId, 60) ?? '');
      if (!group || !user) return reply.code(404).send({ error: 'not_found' });

      const current = groupsOf(user.id);
      if (!current.includes(group.name)) {
        await changeGroups(user, [...current, group.name]);
      }
      record({ actor: auth.user, action: 'group.member_add', target: `${group.name}:${user.username}`, ip: req.ip });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/admin/groups/:id/members/:userId',
    { preHandler: [requirePermission('groups.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const group = get<{ id: string; name: string }>('SELECT id, name FROM groups WHERE id = ?', req.params.id);
      const user = findUserById(req.params.userId);
      if (!group || !user) return reply.code(404).send({ error: 'not_found' });
      const next = groupsOf(user.id).filter((name) => name !== group.name);
      await changeGroups(user, next);
      record({ actor: auth.user, action: 'group.member_remove', target: `${group.name}:${user.username}`, ip: req.ip });
      return { ok: true };
    },
  );

  /* ---------------------------------------------------------------- roles */

  app.get('/api/admin/roles', { preHandler: [requirePermission('roles.read')] }, async () => {
    return {
      roles: listRoles().map((role) => ({
        id: role.id,
        key: role.key,
        name: role.name,
        description: role.description,
        permissions: role.parsed_permissions,
        isSystem: Boolean(role.is_system),
        usage: role.usage,
      })),
      permissions: PERMISSIONS,
      bindings: all(
        `SELECT rb.id, rb.subject_type, rb.subject_value, r.key AS role_key, r.name AS role_name
           FROM role_bindings rb JOIN roles r ON r.id = rb.role_id
          ORDER BY rb.subject_type, rb.subject_value`,
      ),
    };
  });

  app.post<{ Body: { key?: string; name?: string; description?: string; permissions?: string[] } }>(
    '/api/admin/roles',
    { preHandler: [requirePermission('roles.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const key = text(req.body?.key, 40)?.toLowerCase();
      const name = text(req.body?.name, 80);
      if (!key || !/^[a-z][a-z0-9-]{1,38}$/.test(key)) {
        return reply.code(400).send({ error: 'invalid', message: 'Clave de rol no válida.' });
      }
      if (!name) return reply.code(400).send({ error: 'invalid', message: 'El nombre es obligatorio.' });
      if (get('SELECT id FROM roles WHERE key = ?', key)) {
        return reply.code(409).send({ error: 'conflict', message: 'Ese rol ya existe.' });
      }

      const role = createRole({
        key,
        name,
        description: text(req.body?.description, 200) ?? null,
        permissions: sanitizePermissions(req.body?.permissions),
      });
      record({ actor: auth.user, action: 'role.create', target: key, ip: req.ip });
      return reply.code(201).send({
        role: { id: role.id, key: role.key, name: role.name, description: role.description, permissions: sanitizePermissions(req.body?.permissions), isSystem: false, usage: { users: 0, rules: 0 } },
      });
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/admin/roles/:id',
    { preHandler: [requirePermission('roles.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const role = get<{ id: string; key: string; is_system: number; name: string }>(
        'SELECT id, key, is_system, name FROM roles WHERE id = ?',
        req.params.id,
      );
      if (!role) return reply.code(404).send({ error: 'not_found' });
      if (role.is_system) {
        return reply
          .code(400)
          .send({ error: 'system_role', message: 'Los roles del sistema no se editan.' });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      run(
        'UPDATE roles SET name = ?, description = ?, permissions = ? WHERE id = ?',
        text(body.name, 80) ?? role.name,
        text(body.description, 200) ?? null,
        JSON.stringify(sanitizePermissions(body.permissions)),
        role.id,
      );
      record({ actor: auth.user, action: 'role.update', target: role.key, ip: req.ip });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/admin/roles/:id',
    { preHandler: [requirePermission('roles.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const role = get<{ id: string; key: string; is_system: number }>(
        'SELECT id, key, is_system FROM roles WHERE id = ?',
        req.params.id,
      );
      if (!role) return reply.code(404).send({ error: 'not_found' });
      if (role.is_system) {
        return reply.code(400).send({ error: 'system_role', message: 'Los roles del sistema no se eliminan.' });
      }
      const usage = roleUsage(role.id);
      if (usage.users > 0 || usage.rules > 0) {
        return reply.code(409).send({ error: 'in_use', message: 'El rol está asignado; quita las asignaciones primero.' });
      }
      run('DELETE FROM roles WHERE id = ?', role.id);
      record({ actor: auth.user, action: 'role.delete', target: role.key, ip: req.ip });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { subjectType?: string; subjectValue?: string } }>(
    '/api/admin/roles/:id/bindings',
    { preHandler: [requirePermission('roles.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const role = get<{ id: string; key: string }>('SELECT id, key FROM roles WHERE id = ?', req.params.id);
      if (!role) return reply.code(404).send({ error: 'not_found' });

      const subjectType = req.body?.subjectType === 'group' ? 'group' : 'user';
      const subjectValue = text(req.body?.subjectValue, 120);
      if (!subjectValue) {
        return reply.code(400).send({ error: 'invalid', message: 'Indica el usuario o grupo.' });
      }

      if (subjectType === 'user') {
        if (!findUserById(subjectValue)) {
          return reply.code(404).send({ error: 'not_found', message: 'Usuario no encontrado.' });
        }
      } else if (!get('SELECT id FROM groups WHERE name = ?', subjectValue)) {
        return reply.code(404).send({ error: 'not_found', message: 'Grupo no encontrado.' });
      }

      assignRole(role.id, subjectType, subjectValue);
      record({
        actor: auth.user,
        action: 'role.binding',
        target: `${role.key}:${subjectType}:${subjectValue}`,
        ip: req.ip,
      });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/admin/roles/bindings/:id',
    { preHandler: [requirePermission('roles.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const binding = get<{ id: string; role_id: string; subject_type: string; subject_value: string }>(
        'SELECT * FROM role_bindings WHERE id = ?',
        req.params.id,
      );
      if (!binding) return reply.code(404).send({ error: 'not_found' });
      const role = get<{ key: string }>('SELECT key FROM roles WHERE id = ?', binding.role_id);
      if (role?.key === 'owner' && binding.subject_type === 'user' && ownerCount() <= 1) {
        return reply.code(400).send({ error: 'invalid', message: 'Debe quedar al menos un propietario.' });
      }
      removeBinding(binding.id);
      record({ actor: auth.user, action: 'role.unbinding', target: binding.subject_value, ip: req.ip });
      return { ok: true };
    },
  );

  app.get('/api/admin/roles/matrix', { preHandler: [requirePermission('roles.read')] }, async () => {
    const roles = listRoles();
    return {
      permissions: ALL_PERMISSIONS,
      roles: roles.map((role) => ({
        key: role.key,
        name: role.name,
        permissions: role.parsed_permissions,
      })),
    };
  });

  /* -------------------------------------------------------------- modules */

  app.get('/api/admin/modules', { preHandler: [requirePermission('modules.read')] }, async () => {
    return {
      modules: listModuleRows().map((row) => publicModule(row, true)),
      domain: config.domain,
      allowedDomains: [config.domain, ...config.allowedModuleDomains],
      proxySnippet: proxySnippet(),
    };
  });

  app.patch<{ Params: { key: string }; Body: Record<string, unknown> }>(
    '/api/admin/modules/:key',
    { preHandler: [requirePermission('modules.manage')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const row = listModuleRows().find((item) => item.key === req.params.key);
      if (!row) return reply.code(404).send({ error: 'not_found' });

      const body = (req.body ?? {}) as Record<string, unknown>;
      let hostname = row.hostname;
      if (body.hostname !== undefined) {
        const raw = text(body.hostname, 120)?.toLowerCase() ?? '';
        if (raw) {
          if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(raw)) {
            return reply.code(400).send({ error: 'invalid_hostname', message: 'Dominio no válido.' });
          }
          const allowedDomains = [config.domain, ...config.allowedModuleDomains];
          if (!allowedDomains.some((domain) => raw === domain || raw.endsWith(`.${domain}`))) {
            return reply.code(400).send({
              error: 'invalid_hostname',
              message: `El dominio debe pertenecer a ${allowedDomains.join(' o ')}. Añádelo en ALLOWED_MODULE_DOMAINS.`,
            });
          }
          const taken = listModuleRows().find((item) => item.key !== row.key && item.hostname === raw);
          if (taken) {
            return reply.code(409).send({ error: 'conflict', message: `Ya lo usa el módulo ${taken.name}.` });
          }
        }
        hostname = raw || null;
      }

      let path = row.path;
      if (body.path !== undefined) {
        const raw = text(body.path, 80) ?? row.path;
        if (!raw.startsWith('/')) {
          return reply.code(400).send({ error: 'invalid_path', message: 'La ruta debe empezar por /.' });
        }
        path = raw.length > 1 ? raw.replace(/\/+$/, '') : '/';
      }

      let settings = row.settings;
      if (body.settings !== undefined) {
        if (typeof body.settings !== 'object' || body.settings === null || Array.isArray(body.settings)) {
          return reply.code(400).send({ error: 'invalid_settings', message: 'settings debe ser un objeto.' });
        }
        settings = JSON.stringify(body.settings);
      }

      run(
        `UPDATE modules SET name = ?, description = ?, icon = ?, enabled = ?, hostname = ?,
           path = ?, sort = ?, admin_only = ?, settings = ?, updated_at = ? WHERE key = ?`,
        text(body.name, 80) ?? row.name,
        body.description === undefined ? row.description : text(body.description, 200) ?? null,
        text(body.icon, 40) ?? row.icon,
        body.enabled === undefined ? row.enabled : truthy(body.enabled) ? 1 : 0,
        hostname,
        path,
        body.sort === undefined ? row.sort : integer(body.sort, row.sort),
        body.adminOnly === undefined ? row.admin_only : truthy(body.adminOnly) ? 1 : 0,
        settings,
        nowIso(),
        row.key,
      );

      record({
        actor: auth.user,
        action: 'module.update',
        target: row.key,
        detail: { enabled: body.enabled, hostname, path },
        ip: req.ip,
      });

      const updated = listModuleRows().find((item) => item.key === row.key)!;
      return { module: publicModule(updated, true), proxySnippet: proxySnippet() };
    },
  );

  app.post('/api/admin/modules/sync', { preHandler: [requirePermission('modules.manage')] }, async (req) => {
    const auth = attachAuth(req);
    ensureModules();
    record({ actor: auth?.user, action: 'module.sync', ip: req.ip });
    return { modules: listModuleRows().map((row) => publicModule(row, true)) };
  });

  app.get(
    '/api/admin/modules/proxy-config',
    { preHandler: [requirePermission('modules.manage')] },
    async () => ({ snippet: proxySnippet() }),
  );

  /* ------------------------------------------------------------- settings */

  app.get(
    '/api/admin/settings',
    { preHandler: [requireAnyPermission(['settings.read', 'admin.access'])] },
    async () => {
      const ldap = await healthCheck();
      return {
        settings: {
          siteName: getSetting('site_name', 'RedLBA'),
          siteTagline: getSetting('site_tagline', ''),
          supportEmail: getSetting('support_email', ''),
          passwordMinLength: Number(getSetting('password_min_length', '10')),
          mailMaxPerUser: Number(getSetting('mail_max_per_user', '1')),
          registrationEnabled: getSetting('registration_enabled', 'false') === 'true',
        },
        env: {
          domain: config.domain,
          baseUrl: config.baseUrl,
          version: config.version,
          authMode: config.auth.mode,
          cookieDomain: config.cookieDomain ?? null,
          ldap: {
            configured: config.ldap.configured,
            url: config.ldap.url,
            bindDn: config.ldap.bindDn,
            baseDn: config.ldap.baseDn,
            usersBase: config.ldap.usersBase,
            groupsBase: config.ldap.groupsBase,
            userAttr: config.ldap.userAttr,
            healthy: ldap.ok,
            latencyMs: ldap.latencyMs,
            error: ldap.error,
          },
          mail: {
            driver: config.mail.driver,
            domain: config.mail.domain,
            defaultQuotaMb: config.mail.defaultQuotaMb,
            aliasesEnabled: config.mail.aliasesEnabled,
          },
        },
      };
    },
  );

  app.patch<{ Body: Record<string, unknown> }>(
    '/api/admin/settings',
    { preHandler: [requirePermission('settings.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const body = (req.body ?? {}) as Record<string, unknown>;

      if (body.siteName !== undefined) {
        const name = text(body.siteName, 60);
        if (!name) return reply.code(400).send({ error: 'invalid', message: 'El nombre es obligatorio.' });
        setSetting('site_name', name);
      }
      if (body.siteTagline !== undefined) setSetting('site_tagline', text(body.siteTagline, 120) ?? '');
      if (body.supportEmail !== undefined) {
        const email = text(body.supportEmail, 160);
        if (email && !isEmail(email)) {
          return reply.code(400).send({ error: 'invalid', message: 'Correo de soporte no válido.' });
        }
        setSetting('support_email', email ?? '');
      }
      if (body.passwordMinLength !== undefined) {
        const value = integer(body.passwordMinLength, 10);
        if (value < 8 || value > 64) {
          return reply.code(400).send({ error: 'invalid', message: 'La longitud debe estar entre 8 y 64.' });
        }
        setSetting('password_min_length', String(value));
      }
      if (body.mailMaxPerUser !== undefined) {
        setSetting('mail_max_per_user', String(Math.max(integer(body.mailMaxPerUser, 1), 0)));
      }
      if (body.registrationEnabled !== undefined) {
        setSetting('registration_enabled', truthy(body.registrationEnabled) ? 'true' : 'false');
      }

      record({ actor: auth.user, action: 'settings.update', detail: Object.keys(body), ip: req.ip });
      return { ok: true };
    },
  );

  app.post(
    '/api/admin/settings/ldap/test',
    { preHandler: [requireAnyPermission(['settings.read', 'admin.access'])] },
    async (req) => {
      const auth = attachAuth(req);
      const result = await healthCheck();
      record({
        actor: auth?.user,
        action: 'ldap.test',
        result: result.ok ? 'ok' : 'fail',
        detail: { latencyMs: result.latencyMs },
        ip: req.ip,
      });
      return result;
    },
  );

  app.post(
    '/api/admin/settings/ldap/sync',
    { preHandler: [requirePermission('users.write')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      if (!config.ldap.configured) {
        return reply.code(400).send({ error: 'not_configured', message: 'LDAP no está configurado.' });
      }
      try {
        const result = await syncDirectory();
        record({ actor: auth.user, action: 'ldap.sync', detail: result, ip: req.ip });
        return { ok: true, ...result };
      } catch (error) {
        record({
          actor: auth.user,
          action: 'ldap.sync',
          result: 'fail',
          detail: (error as Error).message,
          ip: req.ip,
        });
        return reply
          .code(502)
          .send({ error: 'sync_failed', message: (error as Error).message });
      }
    },
  );

  /* --------------------------------------------------------------- extras */

  app.get(
    '/api/admin/apps',
    { preHandler: [requirePermission('apps.manage')] },
    async () => ({
      apps: all<import('../core/db.js').AppRow>('SELECT * FROM apps ORDER BY sort ASC, name ASC').map(appFor),
    }),
  );

  app.get('/api/admin/sessions-summary', { preHandler: [requirePermission('admin.access')] }, async () => {
    return {
      sessions: all(
        `SELECT s.id, s.ip, s.user_agent, s.created_at, s.last_seen_at, u.username, u.display_name
           FROM sessions s JOIN users u ON u.id = s.user_id
          ORDER BY s.last_seen_at DESC LIMIT 100`,
      ),
    };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/admin/sessions/:id',
    { preHandler: [requirePermission('admin.access')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const session = get<{ id: string; user_id: string }>('SELECT id, user_id FROM sessions WHERE id = ?', req.params.id);
      if (!session) return reply.code(404).send({ error: 'not_found' });
      run('DELETE FROM sessions WHERE id = ?', session.id);
      record({ actor: auth.user, action: 'session.revoke', target: session.id, ip: req.ip });
      return { ok: true };
    },
  );

  /* ---------------------------------------------------- OIDC (SSO hacia apps) */

  app.get(
    '/api/admin/oidc/clients',
    { preHandler: [requirePermission('admin.access')] },
    async () => ({ clients: oidc.listClients(), issuer: oidc.issuer(), wellKnown: oidc.wellKnown() }),
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/api/admin/oidc/clients',
    { preHandler: [requirePermission('admin.access')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = text(body.name, 80);
      const redirectUris = Array.isArray(body.redirectUris)
        ? body.redirectUris.filter((item): item is string => typeof item === 'string')
        : [];
      if (!name || redirectUris.length === 0) {
        return reply
          .code(400)
          .send({ error: 'invalid', message: 'Nombre y al menos un redirect_uri son obligatorios.' });
      }
      if (
        !redirectUris.every(
          (uri) => /^https?:\/\//.test(uri) || uri.startsWith('/') || uri.startsWith('.'),
        )
      ) {
        return reply.code(400).send({
          error: 'invalid',
          message: 'Los redirect_uri deben ser absolutos (https://…) o rutas relativas.',
        });
      }

      const created = oidc.createClient({
        name,
        description: text(body.description, 200) ?? null,
        redirectUris,
        postLogoutRedirectUris: Array.isArray(body.postLogoutRedirectUris)
          ? body.postLogoutRedirectUris.filter((item): item is string => typeof item === 'string')
          : [],
      });
      record({
        actor: auth.user,
        action: 'oidc.client.create',
        target: created.client.client_id,
        ip: req.ip,
      });
      return reply.code(201).send({ client: created.client, clientSecret: created.secret });
    },
  );

  app.delete<{ Params: { clientId: string } }>(
    '/api/admin/oidc/clients/:clientId',
    { preHandler: [requirePermission('admin.access')] },
    async (req, reply) => {
      const auth = attachAuth(req)!;
      if (!oidc.deleteClient(req.params.clientId)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      record({
        actor: auth.user,
        action: 'oidc.client.delete',
        target: req.params.clientId,
        ip: req.ip,
      });
      return { ok: true };
    },
  );
}

function proxySnippet(): string {
  const rows = listModuleRows().filter((row) => row.enabled && row.hostname);
  const lines = [
    '# RedLBA · dominios de módulos (pega en tu Caddyfile y recarga)',
    ...rows.map(
      (row) => `${row.hostname} {\n\tencode zstd gzip\n\treverse_proxy redlba:8080\n}`,
    ),
  ];
  if (rows.length === 0) lines.push('# No hay módulos con dominio propio configurado.');
  return lines.join('\n\n');
}
