import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { config } from './config.js';
import { mutationGuard } from './core/auth.js';
import { pruneEvents } from './core/audit.js';
import { healthCheck } from './core/ldap.js';
import { registerModules } from './core/module-registry.js';
import { ensureSeed, stats } from './core/seed.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { oidcRoutes } from './routes/oidc.js';
import { portalRoutes } from './routes/portal.js';
import './modules/index.js';

const app = Fastify({
  logger: {
    level: config.logLevel,
    transport: config.isProd
      ? undefined
      : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  },
  trustProxy: config.trustProxy,
  bodyLimit: 1_000_000,
});

app.addHook('onSend', async (_req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('X-Frame-Options', 'SAMEORIGIN');
  reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (reply.getHeader('content-type')?.toString().includes('text/html')) {
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: https: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'",
    );
    reply.header('Cache-Control', 'no-store');
  }
  return payload;
});

app.setErrorHandler((error, req, reply) => {
  const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
  if (statusCode >= 500) {
    req.log.error({ err: error, url: req.url }, 'error no controlado');
  }
  if (reply.sent) return;
  reply.code(statusCode).send({
    error: statusCode >= 500 ? 'internal_error' : 'invalid_request',
    message:
      statusCode >= 500
        ? 'Se produjo un error en el servidor.'
        : (error as Error).message || 'Solicitud no válida.',
  });
});

ensureSeed();
pruneEvents();

await app.register(cookie);
// Los clientes OAuth envían los tokens en form-urlencoded.
await app.register(formbody);
// Después de @fastify/cookie: la guarda necesita leer la cookie de sesión.
app.addHook('preHandler', mutationGuard);

await app.register(authRoutes);
await app.register(oidcRoutes);
await app.register(portalRoutes);
await app.register(adminRoutes);
await app.register(async (scope) => {
  await registerModules(scope);
});

const webDist = config.webDist;
const hasWeb = existsSync(path.join(webDist, 'index.html'));

if (hasWeb) {
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: '/',
    index: 'index.html',
    cacheControl: true,
    maxAge: config.isProd ? '7d' : 0,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
    },
  });
}

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api')) {
    return reply.code(404).send({ error: 'not_found', message: 'Ruta no encontrada.' });
  }
  if (hasWeb) {
    return reply.type('text/html').sendFile('index.html');
  }
  return reply
    .code(503)
    .type('text/html')
    .send(
      '<h1>RedLBA</h1><p>La API está en marcha, pero no se encontró la web compilada.</p><p>Ejecuta <code>npm run build</code> o usa el servidor de desarrollo de Vite.</p>',
    );
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[redlba] ${signal}: cerrando…`);
    app.close().finally(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });

const health = await healthCheck();
const summary = stats();
console.log('');
console.log('  RedLBA ' + config.version);
console.log('  Portal:   ' + config.baseUrl);
console.log('  Escucha:  ' + config.host + ':' + config.port);
console.log('  Auth:     ' + config.auth.mode + (health.configured ? ` (LDAP ${health.ok ? 'ok' : 'sin conexión'})` : ' (sin LDAP)'));
console.log('  Web:      ' + (hasWeb ? webDist : 'no compilada (usa npm run dev)'));
console.log(
  '  Datos:    ' +
    `${summary.users} usuarios · ${summary.groups} grupos · ${summary.modules} módulos · ${summary.mailboxes} buzones`,
);
console.log('');
