import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Raíz del proyecto (server/src o server/dist → dos niveles arriba).
// Las rutas relativas se resuelven ahí, no en el cwd del script de npm.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(moduleDir, '..', '..');
const resolveFromRoot = (value: string) =>
  path.isAbsolute(value) ? value : path.resolve(appRoot, value);

// Carga .env sin dependencias: las variables ya definidas en el entorno mandan.
for (const candidate of ['.env', '../.env']) {
  const envPath = path.resolve(appRoot, candidate);
  if (existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      /* .env con formato inválido: se ignora y se usan las variables del sistema */
    }
    break;
  }
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'si', 'sí'].includes(value.trim().toLowerCase());
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const trimSlash = (value: string) => value.replace(/\/+$/, '');

const isProd = (process.env.NODE_ENV ?? 'development') === 'production';
const port = num(process.env.PORT, 8080);
const domain = (process.env.REDLBA_DOMAIN ?? 'redlba.local').trim().replace(/^\./, '');
const baseUrl = trimSlash(process.env.REDLBA_BASE_URL ?? `http://localhost:${port}`);

let baseHost = 'localhost';
try {
  baseHost = new URL(baseUrl).hostname;
} catch {
  /* baseUrl inválida: se mantiene localhost */
}

const secretKey =
  process.env.SECRET_KEY?.trim() ||
  (isProd ? '' : 'redlba-dev-secret-no-usar-en-produccion');

if (!secretKey) {
  throw new Error(
    'SECRET_KEY es obligatoria en producción. Genera una con: openssl rand -hex 32',
  );
}

/**
 * Dominio de la cookie de sesión. Si el portal vive en un subdominio del dominio
 * raíz, la cookie se comparte con el resto de módulos (SSO). En localhost se deja
 * como cookie de host para no romper el desarrollo.
 */
const explicitCookieDomain = process.env.COOKIE_DOMAIN?.trim().replace(/^\./, '');
const cookieDomain = explicitCookieDomain
  ? `.${explicitCookieDomain}`
  : baseHost === domain || baseHost.endsWith(`.${domain}`)
    ? `.${domain}`
    : undefined;

const ldapUrl = process.env.LDAP_URL?.trim() ?? '';
const ldapBindDn = process.env.LDAP_BIND_DN?.trim() ?? '';
const ldapBaseDn = process.env.LDAP_BASE_DN?.trim() ?? 'dc=redlba,dc=local';
const ldapUsersOu = process.env.LDAP_USERS_OU?.trim() ?? 'ou=people';
const ldapGroupsOu = process.env.LDAP_GROUPS_OU?.trim() ?? 'ou=groups';

export const config = {
  version: '0.1.0',
  isProd,
  host: process.env.HOST?.trim() || '0.0.0.0',
  port,
  domain,
  baseUrl,
  baseHost,
  cookieDomain,
  secretKey,
  sessionTtlHours: num(process.env.SESSION_TTL_HOURS, 12),
  sessionMaxDays: 7,
  trustProxy: bool(process.env.TRUST_PROXY, true),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  dbPath: resolveFromRoot(process.env.DATABASE_PATH ?? './data/redlba.db'),
  webDist: resolveFromRoot(process.env.WEB_DIST ?? './web/dist'),
  allowedModuleDomains: (process.env.ALLOWED_MODULE_DOMAINS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
  auditRetentionDays: num(process.env.AUDIT_RETENTION_DAYS, 90),

  auth: {
    mode: (process.env.AUTH_MODE ?? 'hybrid').trim().toLowerCase() as
      | 'ldap'
      | 'local'
      | 'hybrid',
    adminUser: (process.env.ADMIN_USER ?? 'admin').trim().toLowerCase(),
    adminPassword: process.env.ADMIN_PASSWORD ?? '',
    hasLocal: true,
  },

  ldap: {
    url: ldapUrl,
    bindDn: ldapBindDn,
    bindPassword: process.env.LDAP_BIND_PASSWORD ?? '',
    baseDn: ldapBaseDn,
    usersOu: ldapUsersOu,
    groupsOu: ldapGroupsOu,
    userAttr: process.env.LDAP_USER_ATTR?.trim() || 'uid',
    startTls: bool(process.env.LDAP_STARTTLS, false),
    tlsInsecure: bool(process.env.LDAP_TLS_INSECURE, false),
    upnSuffix: process.env.LDAP_UPN_SUFFIX?.trim() ?? '',
    passwordModify: bool(process.env.LDAP_PASSWORD_MODIFY, false),
    useMemberOf: bool(process.env.LDAP_USE_MEMBEROF, false),
    get usersBase() {
      return `${ldapUsersOu},${ldapBaseDn}`;
    },
    get groupsBase() {
      return `${ldapGroupsOu},${ldapBaseDn}`;
    },
    get configured() {
      return Boolean(ldapUrl && ldapBindDn);
    },
  },

  mail: {
    driver: (process.env.MAIL_DRIVER ?? 'ldap').trim().toLowerCase() as
      | 'ldap'
      | 'mailcow'
      | 'none',
    domain: (process.env.MAIL_DOMAIN ?? domain).trim().toLowerCase(),
    defaultQuotaMb: num(process.env.MAIL_DEFAULT_QUOTA_MB, 5120),
    mailcowUrl: trimSlash(process.env.MAILCOW_URL ?? ''),
    mailcowApiKey: process.env.MAILCOW_API_KEY ?? '',
    aliasesEnabled: bool(process.env.MAIL_ALIASES_ENABLED, true),
    /** Webmail: cliente IMAP + envío por SMTP local (Postfix). */
    imap: {
      host: (process.env.IMAP_HOST ?? `mail.${domain}`).trim(),
      port: num(process.env.IMAP_PORT, 993),
      secure: bool(process.env.IMAP_SECURE, true),
      /** Usuario maestro de Dovecot (mail_admin_master_user_passwd). */
      masterUser: process.env.IMAP_MASTER_USER?.trim() ?? '',
      masterSeparator: process.env.IMAP_MASTER_SEP ?? '*',
      timeoutMs: num(process.env.IMAP_TIMEOUT_MS, 20_000),
      tlsInsecure: bool(process.env.IMAP_TLS_INSECURE, false),
    },
    smtp: {
      host: (process.env.SMTP_HOST ?? '127.0.0.1').trim(),
      port: num(process.env.SMTP_PORT, 25),
      secure: bool(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER?.trim() ?? '',
      pass: process.env.SMTP_PASS ?? '',
      tlsInsecure: bool(process.env.SMTP_TLS_INSECURE, false),
    },
    /** Guarda cifradas las contraseñas de correo para que el webmail no pida clave cada vez. */
    cachePasswords: bool(process.env.MAIL_CACHE_PASSWORDS, true),
  },

  /** Espacio de ficheros de la intranet (todo local, sin internet). */
  files: {
    root: resolveFromRoot(process.env.FILES_DIR ?? './data/files'),
    quotaMb: num(process.env.FILES_QUOTA_MB, 5120),
    maxUploadMb: num(process.env.FILES_MAX_UPLOAD_MB, 64),
  },

  /** Subdominios que crea el instalador (se resuelven por cabecera Host). */
  subdomains: {
    enabled: bool(process.env.REDLBA_SUBDOMAINS, true),
    portal: (process.env.PORTAL_SUBDOMAIN ?? 'portal').trim().replace(/\.$/, ''),
    admin: (process.env.ADMIN_SUBDOMAIN ?? 'admin').trim().replace(/\.$/, ''),
    search: (process.env.SEARCH_SUBDOMAIN ?? 'buscar').trim().replace(/\.$/, ''),
    mail: (process.env.MAIL_SUBDOMAIN ?? 'correo').trim().replace(/\.$/, ''),
    /** Solo aplica fuera de local: evita roturar el entorno de desarrollo. */
    isPublic: bool(process.env.REDLBA_SUBDOMAINS, true) && (baseHost === domain || baseHost.endsWith(`.${domain}`)),
    hosts: {
      portal: `${(process.env.PORTAL_SUBDOMAIN ?? 'portal').trim().replace(/\.$/, '')}.${domain}`,
      admin: `${(process.env.ADMIN_SUBDOMAIN ?? 'admin').trim().replace(/\.$/, '')}.${domain}`,
      search: `${(process.env.SEARCH_SUBDOMAIN ?? 'buscar').trim().replace(/\.$/, '')}.${domain}`,
      mail: `${(process.env.MAIL_SUBDOMAIN ?? 'correo').trim().replace(/\.$/, '')}.${domain}`,
    },
  },

  /** Proveedor OpenID Connect (SSO hacia apps que exigen OAuth2). */
  oidc: {
    codeTtlSec: num(process.env.OIDC_CODE_TTL, 120),
    accessTtlSec: num(process.env.OIDC_ACCESS_TTL, 3600),
    refreshTtlSec: num(process.env.OIDC_REFRESH_TTL, 60 * 60 * 24 * 14),
  },
} as const;

export type AppConfig = typeof config;
