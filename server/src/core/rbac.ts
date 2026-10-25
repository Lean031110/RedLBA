import { all, get, run, type RoleRow, type UserRow } from './db.js';
import { newId, nowIso } from './util.js';

export const PERMISSIONS = [
  { key: 'admin.access', group: 'Panel', description: 'Entrar al panel de administración' },
  { key: 'users.read', group: 'Personas', description: 'Ver el directorio y los perfiles' },
  { key: 'users.write', group: 'Personas', description: 'Crear y editar personas' },
  { key: 'users.delete', group: 'Personas', description: 'Eliminar personas' },
  { key: 'users.password', group: 'Personas', description: 'Restablecer contraseñas' },
  { key: 'groups.read', group: 'Grupos', description: 'Ver grupos y miembros' },
  { key: 'groups.write', group: 'Grupos', description: 'Gestionar grupos y miembros' },
  { key: 'roles.read', group: 'Permisos', description: 'Ver roles y asignaciones' },
  { key: 'roles.write', group: 'Permisos', description: 'Editar roles y asignaciones' },
  { key: 'modules.read', group: 'Sistema', description: 'Ver módulos' },
  { key: 'modules.manage', group: 'Sistema', description: 'Activar módulos y cambiar dominios' },
  { key: 'apps.read', group: 'Sistema', description: 'Ver el catálogo de aplicaciones' },
  { key: 'apps.manage', group: 'Sistema', description: 'Editar el catálogo de aplicaciones' },
  { key: 'mail.read', group: 'Correo', description: 'Ver buzones' },
  { key: 'mail.manage', group: 'Correo', description: 'Crear y modificar buzones' },
  { key: 'audit.read', group: 'Sistema', description: 'Consultar la auditoría' },
  { key: 'settings.read', group: 'Sistema', description: 'Ver los ajustes globales' },
  { key: 'settings.write', group: 'Sistema', description: 'Cambiar los ajustes globales' },
  { key: 'search.use', group: 'Servicios', description: 'Usar el buscador' },
  { key: 'notices.write', group: 'Intranet', description: 'Publicar y editar avisos en el tablón' },
  { key: 'files.manage', group: 'Intranet', description: 'Gestionar y borrar ficheros compartidos' },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['key'];

export const ALL_PERMISSIONS: Permission[] = PERMISSIONS.map((item) => item.key);

export const SYSTEM_ROLES: Array<{
  key: string;
  name: string;
  description: string;
  permissions: string[];
}> = [
  {
    key: 'owner',
    name: 'Propietario',
    description: 'Control total del servidor. No se puede eliminar.',
    permissions: ['*'],
  },
  {
    key: 'admin',
    name: 'Administrador',
    description: 'Gestión diaria del portal, personas, módulos y correo.',
    permissions: ALL_PERMISSIONS.filter((permission) => permission !== 'settings.write'),
  },
  {
    key: 'helpdesk',
    name: 'Soporte',
    description: 'Atención al usuario: contraseñas y buzones, sin tocar permisos.',
    permissions: [
      'admin.access',
      'users.read',
      'users.write',
      'users.password',
      'groups.read',
      'mail.read',
      'mail.manage',
      'audit.read',
    ],
  },
  {
    key: 'user',
    name: 'Usuario',
    description: 'Cuenta estándar del servidor.',
    permissions: ['users.read', 'apps.read', 'search.use'],
  },
  {
    key: 'guest',
    name: 'Invitado',
    description: 'Acceso mínimo al catálogo de aplicaciones.',
    permissions: ['apps.read'],
  },
];

export interface EffectiveAccess {
  roles: string[];
  permissions: string[];
  isAdmin: boolean;
}

export function parsePermissions(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Permisos efectivos = roles directos + roles heredados de grupos LDAP. */
export function effectiveAccess(userId: string): EffectiveAccess {
  const rows = all<RoleRow>(
    `SELECT DISTINCT r.* FROM role_bindings rb
       JOIN roles r ON r.id = rb.role_id
      WHERE (rb.subject_type = 'user' AND rb.subject_value = ?)
         OR (rb.subject_type = 'group' AND rb.subject_value IN (
              SELECT g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id
               WHERE gm.user_id = ?))`,
    userId,
    userId,
  );

  if (rows.length === 0) {
    const fallback = get<RoleRow>('SELECT * FROM roles WHERE key = ?', 'user');
    if (fallback) rows.push(fallback);
  }

  const permissions = new Set<string>();
  let owner = false;
  for (const role of rows) {
    if (role.key === 'owner') owner = true;
    for (const permission of parsePermissions(role.permissions)) permissions.add(permission);
  }
  if (owner) permissions.add('*');

  return {
    roles: rows.map((role) => role.key).sort(),
    permissions: [...permissions].sort(),
    isAdmin: permissions.has('*') || permissions.has('admin.access'),
  };
}

export function hasPermission(access: EffectiveAccess, permission: string): boolean {
  return access.permissions.includes('*') || access.permissions.includes(permission);
}

export function hasAnyPermission(access: EffectiveAccess, permissions: string[]): boolean {
  return permissions.some((permission) => hasPermission(access, permission));
}

export function userHasPermission(user: UserRow, permission: string): boolean {
  return hasPermission(effectiveAccess(user.id), permission);
}

/** Crea los roles del sistema que falten y refresca su definición. */
export function ensureSystemRoles(): void {
  for (const role of SYSTEM_ROLES) {
    const existing = get<RoleRow>('SELECT * FROM roles WHERE key = ?', role.key);
    if (existing) {
      if (existing.is_system) {
        run(
          'UPDATE roles SET name = ?, description = ?, permissions = ? WHERE id = ?',
          role.name,
          role.description,
          JSON.stringify(role.permissions),
          existing.id,
        );
      }
      continue;
    }
    run(
      `INSERT INTO roles (id, key, name, description, permissions, is_system, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      newId(),
      role.key,
      role.name,
      role.description,
      JSON.stringify(role.permissions),
      nowIso(),
    );
  }
}

export function sanitizePermissions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const known = new Set<string>(ALL_PERMISSIONS);
  return [...new Set(input.filter((item): item is string => typeof item === 'string'))].filter(
    (item) => item === '*' || known.has(item),
  );
}

export function createRole(input: {
  key: string;
  name: string;
  description?: string | null;
  permissions: string[];
}): RoleRow {
  const id = newId();
  run(
    `INSERT INTO roles (id, key, name, description, permissions, is_system, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    id,
    input.key,
    input.name,
    input.description ?? null,
    JSON.stringify(sanitizePermissions(input.permissions)),
    nowIso(),
  );
  return get<RoleRow>('SELECT * FROM roles WHERE id = ?', id)!;
}

export function assignRole(
  roleId: string,
  subjectType: 'user' | 'group',
  subjectValue: string,
): void {
  run(
    `INSERT OR IGNORE INTO role_bindings (id, role_id, subject_type, subject_value, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    newId(),
    roleId,
    subjectType,
    subjectValue,
    nowIso(),
  );
}

export function removeBinding(bindingId: string): void {
  run('DELETE FROM role_bindings WHERE id = ?', bindingId);
}

export function roleUsage(roleId: string): { users: number; rules: number } {
  const users = get<{ count: number }>(
    `SELECT COUNT(DISTINCT subject_value) AS count FROM role_bindings
      WHERE role_id = ? AND subject_type = 'user'`,
    roleId,
  );
  const rules = get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM role_bindings
      WHERE role_id = ? AND subject_type = 'group'`,
    roleId,
  );
  return { users: users?.count ?? 0, rules: rules?.count ?? 0 };
}

export interface RoleWithUsage extends RoleRow {
  parsed_permissions: string[];
  usage: { users: number; rules: number };
}

export function listRoles(): RoleWithUsage[] {
  return all<RoleRow>('SELECT * FROM roles ORDER BY is_system DESC, key ASC').map((role) => ({
    ...role,
    parsed_permissions: parsePermissions(role.permissions),
    usage: roleUsage(role.id),
  }));
}
