import { createHash } from 'node:crypto';
import { exportJWK, exportPKCS8, generateKeyPair, importJWK, importPKCS8, jwtVerify, SignJWT } from 'jose';
import { config } from '../config.js';
import { all, get, run } from './db.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { newId, nowIso, randomToken } from './util.js';

export const SUPPORTED_SCOPES = ['openid', 'profile', 'email', 'groups', 'offline_access'] as const;

export interface OidcClient {
  id: string;
  client_id: string;
  name: string;
  description: string | null;
  logo_url: string | null;
  redirect_uris: string[];
  post_logout_redirect_uris: string[];
  enabled: number;
  created_at: string;
}

export interface OidcIdentity {
  id: string;
  username: string;
  email: string | null;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  groups?: string[];
  roles?: string[];
}

export class OidcError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'OidcError';
    this.code = code;
    this.status = status;
  }
}

/* -------------------------------------------------------------------- claves */

interface KeyRow {
  id: number;
  private_pem: string;
  kid: string;
  created_at: string;
}

type SignKey = Awaited<ReturnType<typeof importPKCS8>>;

let cachedKey: { privateKey: SignKey; kid: string } | null = null;
let cachedPublic: Awaited<ReturnType<typeof importJWK>> | null = null;

async function signingKey(): Promise<{ privateKey: SignKey; kid: string }> {
  if (cachedKey) return cachedKey;

  const existing = get<KeyRow>('SELECT * FROM oidc_keys WHERE id = 1');
  if (existing) {
    // extractable: permite exportar el JWK público para validar tokens.
    const privateKey = await importPKCS8(existing.private_pem, 'RS256', { extractable: true });
    cachedKey = { privateKey, kid: existing.kid };
    return cachedKey;
  }

  const { privateKey: generated } = await generateKeyPair('RS256', { extractable: true });
  const privatePem = await exportPKCS8(generated);
  const kid = randomToken(8);
  run(
    'INSERT INTO oidc_keys (id, private_pem, kid, created_at) VALUES (1, ?, ?, ?)',
    privatePem,
    kid,
    nowIso(),
  );
  cachedKey = { privateKey: generated, kid };
  return cachedKey;
}

export async function publicJwks(): Promise<{ keys: unknown[] }> {
  const { privateKey, kid } = await signingKey();
  const jwk = await exportJWK(privateKey);
  return { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };
}

export function issuer(): string {
  return config.baseUrl;
}

/* ------------------------------------------------------------------ clientes */

interface ClientRow {
  id: string;
  client_id: string;
  client_secret_hash: string;
  name: string;
  description: string | null;
  logo_url: string | null;
  redirect_uris: string;
  post_logout_redirect_uris: string | null;
  enabled: number;
  created_at: string;
}

function mapClient(row: ClientRow): OidcClient {
  return {
    id: row.id,
    client_id: row.client_id,
    name: row.name,
    description: row.description,
    logo_url: row.logo_url,
    redirect_uris: JSON.parse(row.redirect_uris) as string[],
    post_logout_redirect_uris: row.post_logout_redirect_uris
      ? (JSON.parse(row.post_logout_redirect_uris) as string[])
      : [],
    enabled: row.enabled,
    created_at: row.created_at,
  };
}

export function listClients(): OidcClient[] {
  return all<ClientRow>('SELECT * FROM oidc_clients ORDER BY created_at ASC').map(mapClient);
}

export function clientByClientId(clientId: string): OidcClient | null {
  const row = get<ClientRow>('SELECT * FROM oidc_clients WHERE client_id = ?', clientId);
  if (!row || !row.enabled) return null;
  return mapClient(row);
}

export function createClient(input: {
  name: string;
  description?: string | null;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
}): { client: OidcClient; secret: string } {
  const clientId = `redlba_${randomToken(9)}`;
  const secret = randomToken(24);
  run(
    `INSERT INTO oidc_clients (id, client_id, client_secret_hash, name, description, logo_url,
       redirect_uris, post_logout_redirect_uris, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1, ?)`,
    newId(),
    clientId,
    hashPassword(secret),
    input.name,
    input.description ?? null,
    JSON.stringify(input.redirectUris),
    JSON.stringify(input.postLogoutRedirectUris ?? []),
    nowIso(),
  );
  return { client: clientByClientId(clientId)!, secret };
}

export function deleteClient(clientId: string): boolean {
  const removed = run('DELETE FROM oidc_clients WHERE client_id = ?', clientId);
  run('DELETE FROM oidc_refresh WHERE client_id = ?', clientId);
  return removed.changes > 0;
}

export function verifyClientSecret(clientId: string, clientSecret: string): boolean {
  const row = get<ClientRow>('SELECT * FROM oidc_clients WHERE client_id = ?', clientId);
  if (!row || !row.enabled) return false;
  return verifyPassword(clientSecret, row.client_secret_hash);
}

/** Autoriza el redirect_uri guardado (coincidencia exacta o prefijo http(s)://host). */
export function redirectAllowed(client: OidcClient, redirectUri: string): boolean {
  return client.redirect_uris.some((allowed) => {
    if (allowed === redirectUri) return true;
    if (allowed.endsWith('*')) return redirectUri.startsWith(allowed.slice(0, -1));
    return false;
  });
}

/* --------------------------------------------------------------- autorización */

interface CodeRow {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scope: string | null;
  nonce: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  expires_at: string;
  used: number;
}

export function issueCode(input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string;
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}): string {
  const code = randomToken(32);
  run(
    `INSERT INTO oidc_codes (code, client_id, user_id, redirect_uri, scope, nonce,
       code_challenge, code_challenge_method, expires_at, used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    code,
    input.clientId,
    input.userId,
    input.redirectUri,
    input.scope,
    input.nonce ?? null,
    input.codeChallenge ?? null,
    input.codeChallengeMethod ?? null,
    new Date(Date.now() + config.oidc.codeTtlSec * 1000).toISOString(),
  );
  return code;
}

function challengeFor(verifier: string, method: string | null): string {
  if (method && method !== 'S256' && method !== 'plain') {
    throw new OidcError('invalid_request', 'Método PKCE no soportado.');
  }
  return method === 'plain' ? verifier : createHash('sha256').update(verifier).digest('base64url');
}

export function redeemCode(params: {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}): CodeRow {
  const row = get<CodeRow>('SELECT * FROM oidc_codes WHERE code = ?', params.code);
  if (!row) throw new OidcError('invalid_grant', 'Código de autorización inválido.');
  if (row.used) throw new OidcError('invalid_grant', 'El código ya fue utilizado.');
  if (new Date(row.expires_at) <= new Date()) {
    throw new OidcError('invalid_grant', 'El código ha caducado.');
  }
  if (row.client_id !== params.clientId) {
    throw new OidcError('invalid_grant', 'El código pertenece a otro cliente.');
  }
  if (row.redirect_uri !== params.redirectUri) {
    throw new OidcError('invalid_grant', 'redirect_uri no coincide con la autorizada.');
  }
  if (row.code_challenge) {
    if (!params.codeVerifier) throw new OidcError('invalid_grant', 'Falta code_verifier (PKCE).');
    if (challengeFor(params.codeVerifier, row.code_challenge_method) !== row.code_challenge) {
      throw new OidcError('invalid_grant', 'code_verifier inválido.');
    }
  }

  run('UPDATE oidc_codes SET used = 1 WHERE code = ?', row.code);
  return row;
}

/* -------------------------------------------------------------------- tokens */

export async function signTokens(params: {
  client: OidcClient;
  identity: OidcIdentity;
  scope: string;
  nonce?: string | null;
  grant: 'authorization_code' | 'refresh_token';
  roles: string[];
  withRefresh: boolean;
}): Promise<{
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: 'Bearer';
  scope: string;
}> {
  const { privateKey, kid } = await signingKey();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.oidc.accessTtlSec;
  const scope = params.scope;

  const accessToken = await new SignJWT({
    scope,
    roles: params.roles,
    typ: 'at+jwt',
  })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' })
    .setSubject(params.identity.username)
    .setIssuer(issuer())
    .setAudience(params.client.client_id)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setJti(randomToken(12))
    .sign(privateKey);

  const claims: Record<string, unknown> = {};
  if (scope.includes('profile')) {
    claims.name = params.identity.display_name;
    claims.preferred_username = params.identity.username;
    if (params.identity.first_name) claims.given_name = params.identity.first_name;
    if (params.identity.last_name) claims.family_name = params.identity.last_name;
    if (params.identity.avatar_url) claims.picture = params.identity.avatar_url;
  }
  if (scope.includes('email')) {
    claims.email = params.identity.email;
    claims.email_verified = Boolean(params.identity.email);
  }
  if (scope.includes('groups') && params.identity.groups?.length) {
    claims.groups = params.identity.groups;
  }

  const idPayload = params.nonce ? { ...claims, nonce: params.nonce } : claims;
  const idBuilder = new SignJWT(idPayload)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setSubject(params.identity.username)
    .setIssuer(issuer())
    .setAudience(params.client.client_id)
    .setIssuedAt(now)
    .setExpirationTime(exp + 600)
    .setJti(randomToken(12));
  const idToken = await idBuilder.sign(privateKey);

  let refreshToken: string | undefined;
  if (scope.includes('offline_access') && params.withRefresh) {
    refreshToken = randomToken(32);
    run(
      `INSERT INTO oidc_refresh (token, client_id, user_id, scope, expires_at, revoked)
       VALUES (?, ?, ?, ?, ?, 0)`,
      refreshToken,
      params.client.client_id,
      params.identity.id,
      scope,
      new Date(Date.now() + config.oidc.refreshTtlSec * 1000).toISOString(),
    );
  }

  return {
    access_token: accessToken,
    id_token: idToken,
    refresh_token: refreshToken,
    expires_in: config.oidc.accessTtlSec,
    token_type: 'Bearer',
    scope,
  };
}

export async function verifyAccessToken(token: string): Promise<Record<string, unknown>> {
  if (!cachedPublic) {
    const { privateKey } = await signingKey();
    const jwk = await exportJWK(privateKey);
    cachedPublic = await importJWK(
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig' },
      'RS256',
    );
  }
  const publicKey = cachedPublic;
  try {
    const { payload } = await jwtVerify(token, publicKey, { issuer: issuer() });
    return payload as Record<string, unknown>;
  } catch (error) {
    throw new OidcError('invalid_token', `Token inválido: ${(error as Error).message}`, 401);
  }
}

export function exchangeRefreshToken(params: {
  clientId: string;
  refreshToken: string;
}): { scope: string; userId: string } {
  const row = get<{
    token: string;
    client_id: string;
    user_id: string;
    scope: string | null;
    expires_at: string;
    revoked: number;
  }>('SELECT * FROM oidc_refresh WHERE token = ?', params.refreshToken);

  if (!row || row.revoked) throw new OidcError('invalid_grant', 'Refresh token inválido.');
  if (new Date(row.expires_at) <= new Date()) {
    throw new OidcError('invalid_grant', 'Refresh token caducado.');
  }
  if (row.client_id !== params.clientId) {
    throw new OidcError('invalid_grant', 'Refresh token de otro cliente.');
  }
  return { scope: row.scope ?? 'openid profile email', userId: row.user_id };
}

export function revokeRefreshToken(token: string): void {
  run('UPDATE oidc_refresh SET revoked = 1 WHERE token = ?', token);
}

export function wellKnown(): Record<string, unknown> {
  const iss = issuer();
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oidc/authorize`,
    token_endpoint: `${iss}/oidc/token`,
    userinfo_endpoint: `${iss}/oidc/userinfo`,
    jwks_uri: `${iss}/.well-known/jwks`,
    end_session_endpoint: `${iss}/oidc/logout`,
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256', 'plain'],
    claims_supported: [
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      'nonce',
      'name',
      'preferred_username',
      'given_name',
      'family_name',
      'email',
      'email_verified',
      'picture',
      'groups',
    ],
    authorization_response_iss_parameter_supported: true,
  };
}
