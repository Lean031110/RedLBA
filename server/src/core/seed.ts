import { config } from '../config.js';
import { all, get, run, setSetting } from './db.js';
import { ensureSystemRoles, assignRole } from './rbac.js';
import { hashPassword } from './passwords.js';
import { newId, nowIso } from './util.js';
import { listModuleDefinitions } from './module-registry.js';

const DEFAULT_MODULES = [
  {
    key: 'directory',
    name: 'Directorio',
    description: 'Personas del servidor y sus perfiles.',
    icon: 'users',
    enabled: 1,
    path: '/directory',
    sort: 10,
    adminOnly: 0,
    settings: '{}',
  },
  {
    key: 'search',
    name: 'Buscador',
    description: 'Búsqueda unificada de personas, aplicaciones y accesos.',
    icon: 'search',
    enabled: 1,
    path: '/search',
    sort: 20,
    adminOnly: 0,
    settings: '{"minChars":2}',
  },
  {
    key: 'apps',
    name: 'Aplicaciones',
    description: 'Catálogo de los sitios y servicios del servidor.',
    icon: 'grid',
    enabled: 1,
    path: '/apps',
    sort: 30,
    adminOnly: 0,
    settings: '{}',
  },
  {
    key: 'mail',
    name: 'Correo',
    description: 'Buzones, alias y cuotas de las cuentas del servidor.',
    icon: 'mail',
    enabled: 0,
    path: '/mail',
    sort: 40,
    adminOnly: 0,
    settings: '{"webmailUrl":"","maxMailboxes":0}',
  },
  {
    key: 'audit',
    name: 'Auditoría',
    description: 'Registro de accesos y cambios del servidor.',
    icon: 'activity',
    enabled: 1,
    path: '/admin/audit',
    sort: 90,
    adminOnly: 0,
    settings: '{}',
  },
  {
    key: 'notices',
    name: 'Tablón',
    description: 'Avisos y comunicados de la intranet, disponibles sin internet.',
    icon: 'megaphone',
    enabled: 1,
    path: '/notices',
    sort: 50,
    adminOnly: 0,
    settings: '{}',
  },
  {
    key: 'files',
    name: 'Archivos',
    description: 'Espacio de ficheros personal y compartido del servidor.',
    icon: 'file',
    enabled: 1,
    path: '/files',
    sort: 60,
    adminOnly: 0,
    settings: '{}',
  },
];

const DEFAULT_SETTINGS: Array<[string, string]> = [
  ['site_name', 'RedLBA'],
  ['site_tagline', 'Tu identidad y tus servicios, en un solo lugar'],
  ['support_email', `soporte@${config.domain}`],
  ['password_min_length', '10'],
  ['mail_max_per_user', '1'],
  ['registration_enabled', 'false'],
  ['bootstrap_at', nowIso()],
];

export function ensureModules(): void {
  const timestamp = nowIso();
  const seeded = new Set(DEFAULT_MODULES.map((module) => module.key));
  const registered = new Set(listModuleDefinitions().map((module) => module.key));

  for (const definition of listModuleDefinitions()) {
    if (!seeded.has(definition.key)) {
      run(
        `INSERT OR IGNORE INTO modules
          (key, name, description, icon, enabled, hostname, path, sort, admin_only, settings, updated_at)
         VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?, '{}', ?)`,
        definition.key,
        definition.name,
        definition.description,
        definition.icon,
        definition.defaultPath,
        definition.adminOnly ? 80 : 60,
        definition.adminOnly ? 1 : 0,
        timestamp,
      );
    }
  }

  for (const module of DEFAULT_MODULES) {
    if (!registered.has(module.key)) continue;
    run(
      `INSERT OR IGNORE INTO modules
        (key, name, description, icon, enabled, hostname, path, sort, admin_only, settings, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      module.key,
      module.name,
      module.description,
      module.icon,
      module.enabled,
      module.path,
      module.sort,
      module.adminOnly,
      module.settings,
      timestamp,
    );
  }

  // Subdominios por defecto (portal/admin/buscar/correo) si el sitio está publicado.
  if (config.subdomains.isPublic) {
    const defaults: Record<string, string> = {
      search: config.subdomains.hosts.search,
      mail: config.subdomains.hosts.mail,
    };
    for (const [key, hostname] of Object.entries(defaults)) {
      run(
        'UPDATE modules SET hostname = ?, updated_at = ? WHERE key = ? AND (hostname IS NULL OR hostname = \'\')',
        hostname,
        timestamp,
        key,
      );
    }
  }
}

function ensureApps(): void {
  const count = get<{ count: number }>('SELECT COUNT(*) AS count FROM apps');
  if ((count?.count ?? 0) > 0) return;
  const timestamp = nowIso();
  const apps = [
    {
      name: 'Correo web',
      url: `https://correo.${config.domain}`,
      description: 'Bandeja de entrada del servidor',
      icon: 'mail',
      color: '#d92b3a',
      permission: 'mail.read',
      sort: 10,
    },
    {
      name: 'Archivos',
      url: `https://nube.${config.domain}`,
      description: 'Documentos y carpetas compartidas',
      icon: 'folder',
      color: '#2f6fed',
      permission: 'apps.read',
      sort: 20,
    },
    {
      name: 'Repositorios',
      url: `https://git.${config.domain}`,
      description: 'Código y proyectos del equipo',
      icon: 'code',
      color: '#16161a',
      permission: 'apps.read',
      sort: 30,
    },
  ];
  for (const app of apps) {
    run(
      `INSERT INTO apps (id, name, url, description, icon, color, permission, sort, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      newId(),
      app.name,
      app.url,
      app.description,
      app.icon,
      app.color,
      app.permission,
      app.sort,
      timestamp,
    );
  }
}

function ensureLocalAdmin(): void {
  if (config.auth.mode === 'ldap') return;
  if (!config.auth.adminPassword) {
    console.warn(
      '[seed] ADMIN_PASSWORD vacía: no se creó la cuenta local de administración.',
    );
    return;
  }

  const username = config.auth.adminUser;
  let user = get<{ id: string; password_hash: string | null }>(
    'SELECT id, password_hash FROM users WHERE username = ?',
    username,
  );

  if (!user) {
    const id = newId();
    const timestamp = nowIso();
    run(
      `INSERT INTO users (id, username, email, display_name, first_name, source, status,
         password_hash, created_at, updated_at, search_text)
       VALUES (?, ?, ?, 'Administrador', 'Administrador', 'local', 'active', ?, ?, ?, ?)`,
      id,
      username,
      `admin@${config.domain}`,
      hashPassword(config.auth.adminPassword),
      timestamp,
      timestamp,
      `administrador ${username} admin@${config.domain}`,
    );
    user = { id, password_hash: null };
    console.log(`[seed] cuenta local de administración creada: ${username}`);
  }

  const owner = get<{ id: string }>('SELECT id FROM roles WHERE key = ?', 'owner');
  if (owner) {
    const binding = get<{ id: string }>(
      `SELECT id FROM role_bindings WHERE role_id = ? AND subject_type = 'user' AND subject_value = ?`,
      owner.id,
      user.id,
    );
    if (!binding) assignRole(owner.id, 'user', user.id);
  }
}

function ensureGroupBindings(): void {
  const existing = get<{ count: number }>('SELECT COUNT(*) AS count FROM role_bindings');
  if ((existing?.count ?? 0) > 0) return;

  const mappings: Array<[string, string]> = [
    ['redlba-admins', 'admin'],
    ['redlba-soporte', 'helpdesk'],
    ['redlba-usuarios', 'user'],
  ];
  for (const [group, roleKey] of mappings) {
    const role = get<{ id: string }>('SELECT id FROM roles WHERE key = ?', roleKey);
    if (!role) continue;
    assignRole(role.id, 'group', group);
  }
}

function ensureSettings(): void {
  for (const [key, value] of DEFAULT_SETTINGS) {
    const existing = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
    if (!existing) setSetting(key, value);
  }
}

/** Idempotente: se ejecuta en cada arranque. */
export function ensureSeed(): void {
  ensureSystemRoles();
  ensureModules();
  ensureApps();
  ensureSettings();
  ensureLocalAdmin();
  ensureGroupBindings();
}

export function stats(): Record<string, number> {
  const users = get<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE status = 'active'");
  const groups = get<{ count: number }>('SELECT COUNT(*) AS count FROM groups');
  const apps = get<{ count: number }>('SELECT COUNT(*) AS count FROM apps WHERE enabled = 1');
  const modules = get<{ count: number }>('SELECT COUNT(*) AS count FROM modules WHERE enabled = 1');
  const events = get<{ count: number }>('SELECT COUNT(*) AS count FROM audit_events');
  const mailboxes = get<{ count: number }>('SELECT COUNT(*) AS count FROM mailboxes');
  return {
    users: users?.count ?? 0,
    groups: groups?.count ?? 0,
    apps: apps?.count ?? 0,
    modules: modules?.count ?? 0,
    events: events?.count ?? 0,
    mailboxes: mailboxes?.count ?? 0,
  };
}

export function recentEvents(limit = 8): unknown[] {
  return all(
    'SELECT id, at, actor_username, action, target, result, ip FROM audit_events ORDER BY id DESC LIMIT ?',
    limit,
  );
}
