import { config } from '../config.js';
import {
  all,
  get,
  run,
  transaction,
  type UserRow,
} from './db.js';
import {
  addToGroups,
  createUser as createLdapUser,
  deleteUser as deleteLdapUser,
  fetchDirectory,
  removeFromGroups,
  updateAttributes,
  type LdapPerson,
} from './ldap.js';
import { checkPasswordPolicy, generateTempPassword, hashPassword } from './passwords.js';
import { newId, normalize, nowIso } from './util.js';

export function searchTextFor(user: {
  display_name?: string | null;
  username?: string | null;
  email?: string | null;
  title?: string | null;
  department?: string | null;
}): string {
  return normalize(
    [user.display_name, user.username, user.email, user.title, user.department]
      .filter(Boolean)
      .join(' '),
  );
}

export function findUserById(id: string): UserRow | undefined {
  return get<UserRow>('SELECT * FROM users WHERE id = ?', id);
}

export function findUserByUsername(username: string): UserRow | undefined {
  return get<UserRow>('SELECT * FROM users WHERE username = ?', normalize(username));
}

export function groupsOf(userId: string): string[] {
  return all<{ name: string }>(
    `SELECT g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id
      WHERE gm.user_id = ? ORDER BY g.name`,
    userId,
  ).map((row) => row.name);
}

export function ensureGroup(name: string, source: 'ldap' | 'local' = 'ldap', ldapDn?: string | null): string {
  const existing = get<{ id: string }>('SELECT id FROM groups WHERE name = ?', name);
  if (existing) {
    if (ldapDn) run('UPDATE groups SET ldap_dn = ? WHERE id = ?', ldapDn, existing.id);
    return existing.id;
  }
  const id = newId();
  run(
    'INSERT INTO groups (id, name, description, source, ldap_dn, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    name,
    null,
    source,
    ldapDn ?? null,
    nowIso(),
  );
  return id;
}

export function setUserGroups(userId: string, groupNames: string[]): void {
  transaction(() => {
    run('DELETE FROM group_members WHERE user_id = ?', userId);
    for (const name of groupNames) {
      const groupId = ensureGroup(name);
      run('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)', groupId, userId);
    }
  });
}

/** Crea/actualiza el usuario en la caché a partir de una entrada LDAP. */
export function upsertFromLdap(person: LdapPerson): UserRow {
  const username = normalize(person.username);
  if (!username) throw new Error('Entrada LDAP sin nombre de usuario');

  const existing = findUserByUsername(username);
  const displayName = person.displayName || username;
  const searchText = searchTextFor({
    display_name: displayName,
    username,
    email: person.email,
    title: person.title,
    department: person.department,
  });
  const timestamp = nowIso();

  let id: string;
  if (existing) {
    id = existing.id;
    run(
      `UPDATE users SET email = ?, display_name = ?, first_name = ?, last_name = ?, title = ?,
         department = ?, phone = ?, source = 'ldap', ldap_dn = ?, search_text = ?,
         status = CASE WHEN status = 'orphaned' THEN 'active' ELSE status END, updated_at = ?
       WHERE id = ?`,
      person.email,
      displayName,
      person.firstName,
      person.lastName,
      person.title,
      person.department,
      person.phone,
      person.dn,
      searchText,
      timestamp,
      id,
    );
  } else {
    id = newId();
    run(
      `INSERT INTO users (id, username, email, display_name, first_name, last_name, title,
         department, phone, source, ldap_dn, status, created_at, updated_at, search_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ldap', ?, 'active', ?, ?, ?)`,
      id,
      username,
      person.email,
      displayName,
      person.firstName,
      person.lastName,
      person.title,
      person.department,
      person.phone,
      person.dn,
      timestamp,
      timestamp,
      searchText,
    );
  }

  if (person.groups.length > 0 || existing?.source === 'ldap') {
    setUserGroups(id, person.groups);
  }

  return findUserById(id)!;
}

export interface SyncResult {
  users: number;
  groups: number;
  orphaned: number;
}

/** Refleja el directorio en SQLite. No borra usuarios: los marca como huérfanos. */
export async function syncDirectory(): Promise<SyncResult> {
  if (!config.ldap.configured) {
    throw new Error('LDAP no está configurado');
  }
  const directory = await fetchDirectory();
  const seen = new Set<string>();

  transaction(() => {
    for (const name of directory.groups) ensureGroup(name);
    for (const person of directory.users) {
      const user = upsertFromLdap(person);
      seen.add(user.id);
    }
  });

  const ldapUsers = all<{ id: string; username: string }>(
    "SELECT id, username FROM users WHERE source = 'ldap' AND status = 'active'",
  );
  let orphaned = 0;
  for (const user of ldapUsers) {
    if (!seen.has(user.id)) {
      run("UPDATE users SET status = 'orphaned', updated_at = ? WHERE id = ?", nowIso(), user.id);
      run('DELETE FROM sessions WHERE user_id = ?', user.id);
      orphaned += 1;
    }
  }

  return { users: directory.users.length, groups: directory.groups.length, orphaned };
}

export interface CreatePersonInput {
  username: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  title?: string | null;
  department?: string | null;
  phone?: string | null;
  password?: string | null;
  groups?: string[];
  source?: 'ldap' | 'local';
  roleKeys?: string[];
}

export interface CreatedPerson {
  user: UserRow;
  tempPassword?: string;
  warnings: string[];
}

/** Alta de persona: en LDAP si está disponible, si no, cuenta local. */
export async function createPerson(input: CreatePersonInput): Promise<CreatedPerson> {
  const username = normalize(input.username);
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw Object.assign(new Error('Nombre de usuario no válido (3-32: a-z, 0-9, punto, guion).'), {
      statusCode: 400,
    });
  }
  if (findUserByUsername(username)) {
    throw Object.assign(new Error('Ese nombre de usuario ya existe.'), { statusCode: 409 });
  }

  const warnings: string[] = [];
  const wantsLdap = (input.source ?? 'ldap') === 'ldap' && config.ldap.configured;
  const tempPassword = input.password || generateTempPassword();
  const policy = checkPasswordPolicy(tempPassword, username);
  if (!policy.ok) {
    throw Object.assign(new Error(policy.message ?? 'Contraseña no válida'), { statusCode: 400 });
  }

  const email = input.email?.trim() || `${username}@${config.mail.domain}`;

  if (wantsLdap) {
    try {
      const person = await createLdapUser({
        username,
        firstName: input.firstName,
        lastName: input.lastName,
        email,
        title: input.title,
        department: input.department,
        phone: input.phone,
        password: tempPassword,
        groups: input.groups ?? [],
      });
      const user = upsertFromLdap(person);
      if (input.roleKeys?.length) applyDirectRoles(user.id, input.roleKeys);
      return { user, tempPassword, warnings };
    } catch (error) {
      warnings.push(
        `No se pudo crear en LDAP (${error instanceof Error ? error.message : String(error)}). Se creó una cuenta local.`,
      );
    }
  }

  const id = newId();
  const timestamp = nowIso();
  const displayName = [input.firstName, input.lastName].filter(Boolean).join(' ') || username;
  run(
    `INSERT INTO users (id, username, email, display_name, first_name, last_name, title,
       department, phone, source, status, password_hash, must_change_password,
       created_at, updated_at, search_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', 'active', ?, 1, ?, ?, ?)`,
    id,
    username,
    email,
    displayName,
    input.firstName,
    input.lastName,
    input.title ?? null,
    input.department ?? null,
    input.phone ?? null,
    hashPassword(tempPassword),
    timestamp,
    timestamp,
    searchTextFor({
      display_name: displayName,
      username,
      email,
      title: input.title,
      department: input.department,
    }),
  );

  if (input.groups?.length) setUserGroups(id, input.groups);
  if (input.roleKeys?.length) applyDirectRoles(id, input.roleKeys);

  return { user: findUserById(id)!, tempPassword, warnings };
}

export function applyDirectRoles(userId: string, roleKeys: string[]): void {
  for (const key of roleKeys) {
    const role = get<{ id: string }>('SELECT id FROM roles WHERE key = ?', key);
    if (!role) continue;
    run(
      `INSERT OR IGNORE INTO role_bindings (id, role_id, subject_type, subject_value, created_at)
       VALUES (?, ?, 'user', ?, ?)`,
      newId(),
      role.id,
      userId,
      nowIso(),
    );
  }
}

export function updatePerson(
  user: UserRow,
  patch: Partial<{
    firstName: string;
    lastName: string;
    email: string;
    title: string;
    department: string;
    phone: string;
    bio: string;
    avatarUrl: string;
    displayName: string;
    profileVisibility: 'public' | 'organization' | 'private';
    status: 'active' | 'disabled';
  }>,
): UserRow {
  const firstName = patch.firstName ?? user.first_name ?? '';
  const lastName = patch.lastName ?? user.last_name ?? '';
  const displayName = patch.displayName ?? user.display_name;
  const email = patch.email ?? user.email;
  const title = patch.title ?? user.title;
  const department = patch.department ?? user.department;
  const phone = patch.phone ?? user.phone;

  run(
    `UPDATE users SET first_name = ?, last_name = ?, display_name = ?, email = ?, title = ?,
       department = ?, phone = ?, bio = ?, avatar_url = ?, profile_visibility = ?,
       status = ?, search_text = ?, updated_at = ?
     WHERE id = ?`,
    firstName || null,
    lastName || null,
    displayName,
    email,
    title,
    department,
    phone,
    patch.bio ?? user.bio,
    patch.avatarUrl ?? user.avatar_url,
    patch.profileVisibility ?? user.profile_visibility,
    patch.status ?? user.status,
    searchTextFor({ display_name: displayName, username: user.username, email, title, department }),
    nowIso(),
    user.id,
  );

  return findUserById(user.id)!;
}

/** Propaga los cambios de perfil al directorio (si el usuario es LDAP). */
export async function pushPersonToLdap(
  user: UserRow,
  patch: Record<string, string | null>,
): Promise<{ ok: boolean; error?: string }> {
  if (user.source !== 'ldap' || !user.ldap_dn) return { ok: true };
  try {
    const changes: Record<string, string | string[] | null> = {};
    if ('email' in patch && patch.email) changes.mail = patch.email;
    if ('firstName' in patch && patch.firstName) changes.givenName = patch.firstName;
    if ('lastName' in patch && patch.lastName) changes.sn = patch.lastName;
    if ('title' in patch && patch.title) changes.title = patch.title;
    if ('department' in patch && patch.department) changes.ou = patch.department;
    if ('phone' in patch && patch.phone) changes.telephoneNumber = patch.phone;
    await updateAttributes(user.ldap_dn, changes);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function changeGroups(
  user: UserRow,
  nextGroups: string[],
): Promise<void> {
  const current = groupsOf(user.id);
  const toAdd = nextGroups.filter((group) => !current.includes(group));
  const toRemove = current.filter((group) => !nextGroups.includes(group));

  if (user.source === 'ldap' && user.ldap_dn) {
    await addToGroups(toAdd, user.ldap_dn, user.username);
    await removeFromGroups(toRemove, user.ldap_dn, user.username);
  }
  setUserGroups(user.id, nextGroups);
}

export async function removePerson(user: UserRow): Promise<void> {
  if (user.source === 'ldap' && user.ldap_dn && config.ldap.configured) {
    await deleteLdapUser(user.ldap_dn).catch(() => undefined);
  }
  run('DELETE FROM sessions WHERE user_id = ?', user.id);
  run('DELETE FROM users WHERE id = ?', user.id);
}
