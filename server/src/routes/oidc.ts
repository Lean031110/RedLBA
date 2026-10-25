import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { attachAuth, SESSION_COOKIE } from '../core/auth.js';
import { record } from '../core/audit.js';
import { run } from '../core/db.js';
import { findUserById, findUserByUsername, groupsOf } from '../core/identity.js';
import { effectiveAccess } from '../core/rbac.js';
import {
  clientByClientId,
  exchangeRefreshToken,
  issueCode,
  OidcError,
  publicJwks,
  redeemCode,
  redirectAllowed,
  revokeRefreshToken,
  signTokens,
  verifyAccessToken,
  verifyClientSecret,
  wellKnown,
} from '../core/oidc.js';
import type { OidcIdentity } from '../core/oidc.js';

interface AuthorizeQuery {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  scope?: string;
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  prompt?: string;
}

interface TokenBody {
  grant_type?: string;
  client_id?: string;
  client_secret?: string;
  code?: string;
  redirect_uri?: string;
  code_verifier?: string;
  refresh_token?: string;
}

function errorPage(reply: import('fastify').FastifyReply, status: number, message: string) {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .send(
      `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>RedLBA · OIDC</title>
       <style>body{font-family:system-ui,sans-serif;background:#f7f6f4;color:#17171b;display:grid;place-items:center;min-height:100vh;margin:0}
       .card{background:#fff;border:1px solid #e8e5e1;border-radius:14px;padding:28px;max-width:420px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.05)}
       h1{font-size:18px;margin:0 0 8px}p{color:#6d6c76;font-size:14px;margin:0 0 14px}a{color:#d92b3a;font-weight:600}</style></head>
       <body><div class="card"><h1>Inicio de sesión OIDC</h1><p>${message}</p><a href="/">Volver al portal</a></div></body></html>`,
    );
}

function identityOf(userId: string): OidcIdentity | null {
  const user = findUserById(userId);
  if (!user || user.status !== 'active') return null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    display_name: user.display_name,
    first_name: user.first_name,
    last_name: user.last_name,
    avatar_url: user.avatar_url,
    groups: groupsOf(user.id),
    roles: effectiveAccess(user.id).roles,
  };
}

function clientCredentials(
  req: FastifyRequest,
): { clientId: string; clientSecret: string | undefined } {
  const header = req.headers.authorization;
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator >= 0) {
      return {
        clientId: decoded.slice(0, separator),
        clientSecret: decoded.slice(separator + 1),
      };
    }
  }
  const body = (req.body ?? {}) as TokenBody;
  return { clientId: body.client_id ?? '', clientSecret: body.client_secret };
}

function authenticateClient(req: FastifyRequest): string {
  const { clientId, clientSecret } = clientCredentials(req);
  if (!clientId) throw new OidcError('invalid_client', 'Falta client_id', 401);
  if (!clientSecret || !verifyClientSecret(clientId, clientSecret)) {
    throw new OidcError('invalid_client', 'Credenciales de cliente inválidas', 401);
  }
  return clientId;
}

function withParams(target: string, params: Record<string, string | undefined>): string {
  const url = new URL(target, config.baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function oidcRoutes(app: FastifyInstance): Promise<void> {
  app.get('/.well-known/openid-configuration', async () => wellKnown());

  app.get('/.well-known/jwks', async () => publicJwks());

  /* ---------------------------------------------------------- authorize */
  app.get<{ Querystring: AuthorizeQuery }>('/oidc/authorize', async (req, reply) => {
    const q = req.query;
    const clientId = q.client_id ?? '';
    const redirectUri = q.redirect_uri ?? '';
    const client = clientByClientId(clientId);

    if (!client) return errorPage(reply, 400, 'Cliente desconocido o desactivado.');
    if (!redirectUri || !redirectAllowed(client, redirectUri)) {
      return errorPage(reply, 400, 'El redirect_uri no está registrado en este cliente.');
    }
    if (q.response_type !== 'code') {
      return errorPage(reply, 400, 'Solo se admite response_type=code (PKCE recomendado).');
    }

    const auth = attachAuth(req);
    if (!auth) {
      return reply.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }

    const scope = (q.scope ?? 'openid').trim();
    if (!scope.split(/\s+/).includes('openid')) {
      return errorPage(reply, 400, 'El scope debe incluir openid.');
    }

    const code = issueCode({
      clientId,
      userId: auth.user.id,
      redirectUri,
      scope,
      nonce: q.nonce,
      codeChallenge: q.code_challenge,
      codeChallengeMethod: q.code_challenge_method,
    });

    record({
      actor: auth.user,
      action: 'oidc.authorize',
      target: `${client.name} (${clientId})`,
      ip: req.ip,
    });

    return reply.redirect(
      withParams(redirectUri, { code, iss: config.baseUrl, state: q.state }),
    );
  });

  /* -------------------------------------------------------------- token */
  app.post('/oidc/token', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as TokenBody;
      const clientId = authenticateClient(req);

      if (body.grant_type === 'authorization_code') {
        if (!body.code || !body.redirect_uri) {
          throw new OidcError('invalid_request', 'Faltan code o redirect_uri.');
        }
        const code = redeemCode({
          clientId,
          code: body.code,
          redirectUri: body.redirect_uri,
          codeVerifier: body.code_verifier,
        });
        const identity = identityOf(code.user_id);
        if (!identity) throw new OidcError('invalid_grant', 'Usuario inexistente o desactivado.');
        const client = clientByClientId(clientId)!;

        const tokens = await signTokens({
          client,
          identity,
          scope: code.scope ?? 'openid profile email',
          nonce: code.nonce,
          grant: 'authorization_code',
          roles: effectiveAccess(identity.id).roles,
          withRefresh: true,
        });
        return reply.send(tokens);
      }

      if (body.grant_type === 'refresh_token') {
        if (!body.refresh_token) throw new OidcError('invalid_request', 'Falta refresh_token.');
        const refresh = exchangeRefreshToken({ clientId, refreshToken: body.refresh_token });
        const identity = identityOf(refresh.userId);
        if (!identity) throw new OidcError('invalid_grant', 'Usuario inexistente o desactivado.');
        revokeRefreshToken(body.refresh_token);
        const client = clientByClientId(clientId)!;

        const tokens = await signTokens({
          client,
          identity,
          scope: refresh.scope,
          grant: 'refresh_token',
          roles: effectiveAccess(identity.id).roles,
          withRefresh: true,
        });
        return reply.send(tokens);
      }

      throw new OidcError('unsupported_grant_type', 'grant_type no soportado.');
    } catch (error) {
      const failure = error instanceof OidcError ? error : null;
      const status = failure?.status ?? 400;
      if (status === 401) reply.header('WWW-Authenticate', 'Basic realm="redlba"');
      return reply.code(status).send({
        error: failure?.code ?? 'server_error',
        error_description: failure?.message ?? 'Error al procesar la petición.',
      });
    }
  });

  /* ------------------------------------------------------------ userinfo */
  app.get('/oidc/userinfo', async (req, reply) => {
    try {
      const header = req.headers.authorization ?? '';
      if (!header.startsWith('Bearer ')) {
        throw new OidcError('invalid_token', 'Falta el token Bearer.', 401);
      }
      const payload = await verifyAccessToken(header.slice(7));
      const scope = typeof payload.scope === 'string' ? payload.scope : 'openid';
      const username = typeof payload.sub === 'string' ? payload.sub : '';
      const user = findUserByUsername(username);
      if (!user || user.status !== 'active') {
        throw new OidcError('invalid_token', 'Usuario inexistente o desactivado.', 401);
      }

      const claims: Record<string, unknown> = { sub: user.username };
      if (scope.includes('profile')) {
        claims.name = user.display_name;
        claims.preferred_username = user.username;
        if (user.first_name) claims.given_name = user.first_name;
        if (user.last_name) claims.family_name = user.last_name;
        if (user.avatar_url) claims.picture = user.avatar_url;
      }
      if (scope.includes('email')) {
        claims.email = user.email;
        claims.email_verified = Boolean(user.email);
      }
      if (scope.includes('groups')) claims.groups = groupsOf(user.id);

      return reply.send(claims);
    } catch (error) {
      console.error('[oidc/userinfo]', error);
      const failure = error instanceof OidcError ? error : null;
      reply.header(
        'WWW-Authenticate',
        `Bearer error="${failure?.code ?? 'invalid_token'}", error_description="${failure?.message ?? 'token inválido'}"`,
      );
      return reply.code(failure?.status ?? 401).send({
        error: failure?.code ?? 'invalid_token',
        error_description: failure?.message ?? 'Token inválido.',
      });
    }
  });

  /* --------------------------------------------------------------- logout */
  app.get<{
    Querystring: {
      post_logout_redirect_uri?: string;
      state?: string;
      client_id?: string;
    };
  }>('/oidc/logout', async (req, reply) => {
      const auth = attachAuth(req);
      if (auth) {
        record({ actor: auth.user, action: 'oidc.logout', ip: req.ip });
        run('DELETE FROM sessions WHERE id = ?', auth.session.id);
        reply.clearCookie(SESSION_COOKIE, { path: '/', domain: config.cookieDomain });
      }

      const target = req.query.post_logout_redirect_uri;
      const client = target && req.query.client_id ? clientByClientId(req.query.client_id) : null;

      if (target && client && client.post_logout_redirect_uris.includes(target)) {
        return reply.redirect(withParams(target, { state: req.query.state }));
      }
      return reply.redirect(config.baseUrl);
    },
  );

  /* Estado del proveedor (solo para el panel) */
  app.get('/oidc/ping', async () => ({ ok: true, issuer: config.baseUrl }));
}
