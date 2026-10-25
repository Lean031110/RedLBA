import { Attribute, Client, Change } from 'ldapts';
import { config } from '../config.js';
import { sshaPassword } from './passwords.js';
import { ldapEscape, normalize } from './util.js';

export type LdapErrorCode = 'not_configured' | 'invalid_credentials' | 'unreachable' | 'error';

export class LdapError extends Error {
  code: LdapErrorCode;

  constructor(code: LdapErrorCode, message: string) {
    super(message);
    this.name = 'LdapError';
    this.code = code;
  }
}

export interface LdapPerson {
  dn: string;
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  title: string | null;
  department: string | null;
  phone: string | null;
  groups: string[];
}

interface RawEntry {
  dn: string;
  [key: string]: unknown;
}

export function ldapEnabled(): boolean {
  return config.auth.mode !== 'local' && config.ldap.configured;
}

export function createClient(): Client {
  return new Client({
    url: config.ldap.url,
    timeout: 8000,
    connectTimeout: 4000,
    ...(config.ldap.tlsInsecure ? { tlsOptions: { rejectUnauthorized: false } } : {}),
  });
}

async function serviceClient(): Promise<Client> {
  if (!config.ldap.configured) {
    throw new LdapError('not_configured', 'LDAP no está configurado (LDAP_URL / LDAP_BIND_DN).');
  }
  const client = createClient();
  try {
    // StartTLS debe negociarse antes del bind.
    if (config.ldap.startTls) {
      await client.startTLS({ rejectUnauthorized: !config.ldap.tlsInsecure });
    }
    await client.bind(config.ldap.bindDn, config.ldap.bindPassword);
    return client;
  } catch (error) {
    await client.unbind().catch(() => undefined);
    throw classify(error);
  }
}

function classify(error: unknown): LdapError {
  const candidate = error as { name?: string; resultCode?: number; message?: string; code?: string };
  if (
    candidate?.name === 'InvalidCredentialsError' ||
    candidate?.resultCode === 49 ||
    candidate?.code === '49'
  ) {
    return new LdapError('invalid_credentials', 'Credenciales incorrectas.');
  }
  if (
    candidate?.name === 'NoSuchObjectError' ||
    candidate?.name === 'InsufficientAccessRightsError'
  ) {
    return new LdapError('error', candidate.message ?? 'Operación LDAP rechazada.');
  }
  return new LdapError('unreachable', candidate?.message ?? 'No se pudo contactar con el directorio.');
}

function attributesOf(entry: RawEntry): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'dn') continue;
    if (value === null || value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    output[key.toLowerCase()] = values
      .map((item) => (Buffer.isBuffer(item) ? item.toString('utf8') : String(item)))
      .filter(Boolean);
  }
  return output;
}

export function first(attributes: Record<string, string[]>, key: string): string | null {
  return attributes[key.toLowerCase()]?.[0] ?? null;
}

function mapPerson(entry: RawEntry, groups: string[] = []): LdapPerson {
  const attributes = attributesOf(entry);
  const firstName = first(attributes, 'givenName');
  const lastName = first(attributes, 'sn');
  return {
    dn: entry.dn,
    username: first(attributes, config.ldap.userAttr) ?? first(attributes, 'uid') ?? '',
    email: first(attributes, 'mail'),
    firstName,
    lastName,
    displayName:
      first(attributes, 'displayName') ??
      first(attributes, 'cn') ??
      [firstName, lastName].filter(Boolean).join(' ') ??
      '',
    title: first(attributes, 'title'),
    department: first(attributes, 'ou') ?? first(attributes, 'department'),
    phone: first(attributes, 'telephoneNumber'),
    groups,
  };
}

/** Grupos (solo bajo `groupsBase`) a los que pertenece un DN. */
export async function groupsForDn(client: Client, dn: string): Promise<string[]> {
  const escapedDn = ldapEscape(dn);
  const names: string[] = [];

  try {
    const { searchEntries } = await client.search(config.ldap.groupsBase, {
      scope: 'sub',
      filter: `(&(objectClass=groupOfNames)(member=${escapedDn}))`,
      attributes: ['cn'],
    });
    for (const entry of searchEntries as RawEntry[]) {
      const value = first(attributesOf(entry), 'cn');
      if (value) names.push(value);
    }
  } catch (error) {
    const classified = classify(error);
    if (classified.code === 'unreachable') throw classified;
  }

  if (names.length === 0) {
    // Algunos directorios usan posixGroup/memberUid.
    try {
      const { searchEntries } = await client.search(config.ldap.groupsBase, {
        scope: 'sub',
        filter: `(&(objectClass=posixGroup)(memberUid=${ldapEscape(dn.split(',')[0]?.split('=')[1] ?? dn)}))`,
        attributes: ['cn'],
      });
      for (const entry of searchEntries as RawEntry[]) {
        const value = first(attributesOf(entry), 'cn');
        if (value) names.push(value);
      }
    } catch {
      /* opcional */
    }
  }

  return [...new Set(names)].sort();
}

export interface AuthenticatedUser {
  dn: string;
  person: LdapPerson;
}

/** Bind con las credenciales del usuario; devuelve su DN y atributos. */
export async function authenticateUser(
  username: string,
  password: string,
): Promise<AuthenticatedUser> {
  if (!password) throw new LdapError('invalid_credentials', 'Credenciales incorrectas.');

  const directory = await serviceClient();
  let dn = '';
  let rawEntry: RawEntry | null = null;

  try {
    const { searchEntries } = await directory.search(config.ldap.usersBase, {
      scope: 'sub',
      filter: `(&(|(objectClass=inetOrgPerson)(objectClass=person))(${config.ldap.userAttr}=${ldapEscape(username)}))`,
      attributes: ['*', 'memberOf'],
      sizeLimit: 2,
    });
    rawEntry = (searchEntries[0] as RawEntry | undefined) ?? null;
    if (!rawEntry) throw new LdapError('invalid_credentials', 'Credenciales incorrectas.');
    dn = rawEntry.dn;
  } finally {
    await directory.unbind().catch(() => undefined);
  }

  const userClient = createClient();
  try {
    const bindName = config.ldap.upnSuffix ? `${username}${config.ldap.upnSuffix}` : dn;
    await userClient.bind(bindName, password);
  } catch (error) {
    const classified = classify(error);
    throw classified.code === 'invalid_credentials'
      ? new LdapError('invalid_credentials', 'Credenciales incorrectas.')
      : classified;
  } finally {
    await userClient.unbind().catch(() => undefined);
  }

  let groups: string[] = [];
  try {
    const groupClient = await serviceClient();
    try {
      groups = await groupsForDn(groupClient, dn);
    } finally {
      await groupClient.unbind().catch(() => undefined);
    }
  } catch {
    groups = [];
  }

  return { dn, person: mapPerson(rawEntry!, groups) };
}

export async function healthCheck(): Promise<{
  ok: boolean;
  configured: boolean;
  latencyMs: number;
  error?: string;
}> {
  if (!config.ldap.configured) {
    return { ok: false, configured: false, latencyMs: 0, error: 'Sin configuración LDAP' };
  }
  const start = Date.now();
  try {
    const client = await serviceClient();
    await client.unbind();
    return { ok: true, configured: true, latencyMs: Date.now() - start };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface LdapSyncResult {
  users: LdapPerson[];
  groups: string[];
}

/** Lectura completa del directorio para la caché local. */
export async function fetchDirectory(): Promise<LdapSyncResult> {
  const client = await serviceClient();
  try {
    // Una sola lectura de grupos: se indexan por DN de miembro y por uid (posixGroup).
    const groupsResult = await client.search(config.ldap.groupsBase, {
      scope: 'sub',
      filter: '(|(objectClass=groupOfNames)(objectClass=posixGroup))',
      attributes: ['cn', 'member', 'memberUid'],
      paged: { pageSize: 500 },
    });

    const byDn = new Map<string, string[]>();
    const byUid = new Map<string, string[]>();
    const groupNames: string[] = [];

    for (const entry of groupsResult.searchEntries as RawEntry[]) {
      const attributes = attributesOf(entry);
      const name = first(attributes, 'cn');
      if (!name) continue;
      groupNames.push(name);
      for (const member of attributes.member ?? []) {
        const key = member.toLowerCase();
        byDn.set(key, [...(byDn.get(key) ?? []), name]);
      }
      for (const uid of attributes.memberuid ?? attributes.memberUid ?? []) {
        const key = uid.toLowerCase();
        byUid.set(key, [...(byUid.get(key) ?? []), name]);
      }
    }

    const usersResult = await client.search(config.ldap.usersBase, {
      scope: 'sub',
      filter: '(|(objectClass=inetOrgPerson)(objectClass=person))',
      attributes: ['*'],
      paged: { pageSize: 500 },
    });

    const users: LdapPerson[] = [];
    for (const entry of usersResult.searchEntries as RawEntry[]) {
      const attributes = attributesOf(entry);
      const username = first(attributes, config.ldap.userAttr);
      if (!username) continue;
      const groups = [
        ...new Set([
          ...(byDn.get(entry.dn.toLowerCase()) ?? []),
          ...(byUid.get(username.toLowerCase()) ?? []),
        ]),
      ].sort();
      users.push(mapPerson(entry, groups));
    }

    return { users, groups: [...new Set(groupNames)].sort() };
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

export async function findPerson(username: string): Promise<LdapPerson | null> {
  const client = await serviceClient();
  try {
    const { searchEntries } = await client.search(config.ldap.usersBase, {
      scope: 'sub',
      filter: `(&(|(objectClass=inetOrgPerson)(objectClass=person))(${config.ldap.userAttr}=${ldapEscape(username)}))`,
      attributes: ['*'],
      sizeLimit: 1,
    });
    const entry = searchEntries[0] as RawEntry | undefined;
    if (!entry) return null;
    return mapPerson(entry, await groupsForDn(client, entry.dn).catch(() => []));
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

export interface CreateLdapUserInput {
  username: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  title?: string | null;
  department?: string | null;
  phone?: string | null;
  password: string;
  groups?: string[];
}

async function nextNumericAttribute(client: Client, attribute: string, fallback: number): Promise<number> {
  try {
    const { searchEntries } = await client.search(config.ldap.usersBase, {
      scope: 'sub',
      filter: '(objectClass=posixAccount)',
      attributes: [attribute],
      paged: { pageSize: 500 },
    });
    let max = fallback;
    for (const entry of searchEntries as RawEntry[]) {
      const value = Number(first(attributesOf(entry), attribute));
      if (Number.isFinite(value) && value > max) max = value;
    }
    return max + 1;
  } catch {
    return fallback + 1;
  }
}

export async function createUser(input: CreateLdapUserInput): Promise<LdapPerson> {
  const client = await serviceClient();
  try {
    const dn = `uid=${input.username},${config.ldap.usersBase}`;
    const uidNumber = await nextNumericAttribute(client, 'uidNumber', 10000);
    const gidNumber = await nextNumericAttribute(client, 'gidNumber', 20000);

    const entry: Record<string, string | string[]> = {
      objectClass: ['inetOrgPerson', 'posixAccount', 'shadowAccount', 'organizationalPerson'],
      uid: input.username,
      cn: [input.firstName, input.lastName].filter(Boolean).join(' ') || input.username,
      sn: input.lastName || input.username,
      displayName: [input.firstName, input.lastName].filter(Boolean).join(' '),
      uidNumber: String(uidNumber),
      gidNumber: String(gidNumber),
      homeDirectory: `/home/${input.username}`,
      loginShell: '/bin/bash',
      userPassword: sshaPassword(input.password),
    };
    if (input.firstName) entry.givenName = input.firstName;
    if (input.email) entry.mail = input.email;
    if (input.title) entry.title = input.title;
    if (input.department) entry.ou = input.department;
    if (input.phone) entry.telephoneNumber = input.phone;

    await client.add(dn, entry);

    for (const group of input.groups ?? []) {
      await addMember(client, group, dn, input.username).catch(() => undefined);
    }

    return mapPerson({ ...entry, dn } as RawEntry, input.groups ?? []);
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

function groupDn(group: string): string {
  return group.includes('=') ? group : `cn=${group},${config.ldap.groupsBase}`;
}

export async function addMember(
  client: Client,
  group: string,
  userDn: string,
  username: string,
): Promise<void> {
  const changes: Change[] = [
    new Change({
      operation: 'add',
      modification: new Attribute({ type: 'member', values: [userDn] }),
    }),
  ];
  try {
    await client.modify(groupDn(group), changes);
  } catch {
    /* el grupo puede no existir o ya contener al miembro */
  }
  try {
    await client.modify(groupDn(group), [
      new Change({
        operation: 'add',
        modification: new Attribute({ type: 'memberUid', values: [username] }),
      }),
    ]);
  } catch {
    /* opcional */
  }
}

export async function removeMember(
  client: Client,
  group: string,
  userDn: string,
  username: string,
): Promise<void> {
  try {
    await client.modify(groupDn(group), [
      new Change({
        operation: 'delete',
        modification: new Attribute({ type: 'member', values: [userDn] }),
      }),
    ]);
  } catch {
    /* no estaba */
  }
  try {
    await client.modify(groupDn(group), [
      new Change({
        operation: 'delete',
        modification: new Attribute({ type: 'memberUid', values: [username] }),
      }),
    ]);
  } catch {
    /* no estaba */
  }
}

export async function updateAttributes(
  dn: string,
  attributes: Record<string, string | string[] | null>,
): Promise<void> {
  const client = await serviceClient();
  try {
    const changes: Change[] = [];
    for (const [key, value] of Object.entries(attributes)) {
      if (value === null) continue;
      changes.push(
        new Change({
          operation: 'replace',
          modification: new Attribute({
            type: key,
            values: Array.isArray(value) ? value : [value],
          }),
        }),
      );
    }
    if (changes.length > 0) await client.modify(dn, changes);
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

export async function setPassword(dn: string, password: string): Promise<void> {
  await updateAttributes(dn, { userPassword: sshaPassword(password) });
}

export async function deleteUser(dn: string): Promise<void> {
  const client = await serviceClient();
  try {
    await client.del(dn);
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

export async function addToGroups(
  groupNames: string[],
  userDn: string,
  username: string,
): Promise<void> {
  if (groupNames.length === 0) return;
  const client = await serviceClient();
  try {
    for (const group of groupNames) {
      await addMember(client, group, userDn, username);
    }
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

export async function removeFromGroups(
  groupNames: string[],
  userDn: string,
  username: string,
): Promise<void> {
  if (groupNames.length === 0) return;
  const client = await serviceClient();
  try {
    for (const group of groupNames) {
      await removeMember(client, group, userDn, username);
    }
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

/** Búsqueda de buzones en el directorio (módulo de correo). */
export async function findMailboxes(query: string): Promise<LdapPerson[]> {
  const client = await serviceClient();
  try {
    const filter = query
      ? `(&(|(objectClass=inetOrgPerson)(objectClass=person))(mail=*${ldapEscape(query)}*))`
      : '(&(|(objectClass=inetOrgPerson)(objectClass=person))(mail=*))';
    const { searchEntries } = await client.search(config.ldap.usersBase, {
      scope: 'sub',
      filter,
      attributes: ['*'],
      sizeLimit: 200,
    });
    return (searchEntries as RawEntry[]).map((entry) => mapPerson(entry));
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

export function guessEmail(username: string): string {
  return `${normalize(username).replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '')}@${config.mail.domain}`;
}
