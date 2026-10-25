import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'Admin-Prueba-2026';
const USER_PASSWORD = 'Portal-Seguro-2026';

let server = null;
let dataDir = null;

/* ------------------------------------------------------------- utilidades */

function client() {
  const jar = new Map();
  let csrf = '';

  const absorb = (response) => {
    const cookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const cookie of cookies) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  };

  return {
    get csrf() {
      return csrf;
    },
    cookieHeader() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    async request(route, options = {}) {
      const method = options.method ?? 'GET';
      const headers = { Origin: BASE, ...(options.headers ?? {}) };
      if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (method !== 'GET' && csrf) headers['X-RedLBA-CSRF'] = csrf;
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';

      const response = await fetch(`${BASE}${route}`, {
        method,
        headers,
        redirect: 'manual',
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      absorb(response);

      const raw = await response.text();
      let data = null;
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
      }
      if (data && typeof data === 'object' && data.csrfToken) csrf = data.csrfToken;
      return { status: response.status, headers: response.headers, data };
    },
    async login(username, password) {
      const result = await this.request('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      if (result.data?.csrfToken) csrf = result.data.csrfToken;
      return result;
    },
  };
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      /* el servidor aún no escucha */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('El servidor de pruebas no respondió a tiempo.');
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'redlba-test-'));
  server = spawn(process.execPath, ['server/dist/index.js'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      SECRET_KEY: 'clave-de-pruebas-no-usar-en-produccion',
      DATABASE_PATH: path.join(dataDir, 'test.db'),
      REDLBA_DOMAIN: 'redlba.test',
      REDLBA_BASE_URL: BASE,
      REDLBA_SUBDOMAINS: 'false',
      AUTH_MODE: 'local',
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD,
      LOG_LEVEL: 'error',
    },
  });
  await waitForHealth();
});

after(async () => {
  if (server) server.kill('SIGTERM');
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
});

/* ------------------------------------------------------------------ pruebas */

test('el servicio de salud responde', async () => {
  const response = await fetch(`${BASE}/api/health`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.status, 'ok');
  assert.equal(data.db, 'ok');
});

test('el bootstrap anuncia la interfaz sin sesión', async () => {
  const response = await fetch(`${BASE}/api/bootstrap`);
  const data = await response.json();
  assert.equal(data.authenticated, false);
  assert.equal(data.site.name, 'RedLBA');
  assert.ok(Array.isArray(data.modules));
});

test('una contraseña incorrecta no abre sesión', async () => {
  const session = client();
  const result = await session.login('admin', 'clave-equívoca');
  assert.ok(result.status >= 400, `se esperaba rechazo, llegó ${result.status}`);
});

test('el administrador entra y recibe un token CSRF', async () => {
  const session = client();
  const result = await session.login('admin', ADMIN_PASSWORD);
  assert.equal(result.status, 200);
  assert.equal(result.data.user.username, 'admin');
  assert.ok(result.data.csrfToken, 'falta el token CSRF');
  assert.ok(session.csrf);
});

test('las mutaciones sin token CSRF son rechazadas', async () => {
  const session = client();
  await session.login('admin', ADMIN_PASSWORD);
  const response = await fetch(`${BASE}/api/m/notices/posts`, {
    method: 'POST',
    headers: {
      Origin: BASE,
      Cookie: session.cookieHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: 'Sin token', body: 'No debería publicarse' }),
  });
  assert.ok(response.status >= 400, `se esperaba rechazo, llegó ${response.status}`);
});

test('los módulos de intranet nacen activados', async () => {
  const session = client();
  await session.login('admin', ADMIN_PASSWORD);
  const result = await session.request('/api/admin/modules');
  assert.equal(result.status, 200);
  const keys = result.data.modules.map((module) => module.key);
  for (const key of ['notices', 'files', 'search', 'mail']) {
    assert.ok(keys.includes(key), `falta el módulo ${key}`);
  }
  const notices = result.data.modules.find((module) => module.key === 'notices');
  const files = result.data.modules.find((module) => module.key === 'files');
  assert.equal(notices.enabled, true);
  assert.equal(files.enabled, true);
});

test('se puede crear una cuenta de usuario y entrar con ella', async () => {
  const admin = client();
  await admin.login('admin', ADMIN_PASSWORD);
  const created = await admin.request('/api/admin/users', {
    method: 'POST',
    body: {
      username: 'prueba',
      firstName: 'Ana',
      lastName: 'Prueba',
      email: 'prueba@redlba.test',
      password: USER_PASSWORD,
      roles: ['user'],
    },
  });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.data));

  const user = client();
  const login = await user.login('prueba', USER_PASSWORD);
  assert.equal(login.status, 200);
  assert.equal(login.data.user.username, 'prueba');
});

test('un usuario sin permiso no puede publicar en el tablón', async () => {
  const user = client();
  await user.login('prueba', USER_PASSWORD);

  const read = await user.request('/api/m/notices/posts');
  assert.equal(read.status, 200);

  const write = await user.request('/api/m/notices/posts', {
    method: 'POST',
    body: { title: 'Intento', body: 'No debería publicarse' },
  });
  assert.equal(write.status, 403);
  assert.equal(write.data.required, 'notices.write');
});

test('el administrador publica un aviso y el usuario lo lee', async () => {
  const admin = client();
  await admin.login('admin', ADMIN_PASSWORD);
  const created = await admin.request('/api/m/notices/posts', {
    method: 'POST',
    body: { title: 'Mantenimiento', body: 'Reinicio el sábado a las 22:00.', pinned: true },
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.post.pinned, true);

  const user = client();
  await user.login('prueba', USER_PASSWORD);
  const list = await user.request('/api/m/notices/posts');
  assert.equal(list.status, 200);
  assert.ok(list.data.posts.some((post) => post.title === 'Mantenimiento'));
});

test('el espacio de ficheros sube, lista y descarga', async () => {
  const admin = client();
  await admin.login('admin', ADMIN_PASSWORD);

  const list = await admin.request('/api/m/files/list?path=shared');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data.entries));

  const folder = `shared/pruebas-${Date.now()}`;
  const mkdir = await admin.request('/api/m/files/mkdir', {
    method: 'POST',
    body: { path: folder },
  });
  assert.equal(mkdir.status, 200, JSON.stringify(mkdir.data));

  const filePath = `${folder}/nota.txt`;
  const upload = await fetch(`${BASE}/api/m/files/upload`, {
    method: 'POST',
    headers: {
      Origin: BASE,
      Cookie: admin.cookieHeader(),
      'X-RedLBA-CSRF': admin.csrf,
      'X-File-Path': encodeURIComponent(filePath),
      'Content-Type': 'application/octet-stream',
    },
    body: 'contenido de prueba',
  });
  assert.equal(upload.status, 200, await upload.text());

  const download = await fetch(
    `${BASE}/api/m/files/download?path=${encodeURIComponent(filePath)}`,
    { headers: { Cookie: admin.cookieHeader() } },
  );
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'contenido de prueba');

  const remove = await admin.request('/api/m/files/delete', {
    method: 'POST',
    body: { path: folder },
  });
  assert.equal(remove.status, 200);
});

test('las rutas con .. no escapan del directorio de ficheros', async () => {
  const admin = client();
  await admin.login('admin', ADMIN_PASSWORD);
  for (const target of ['../../etc', '%2e%2e%2f%2e%2e%2fetc', 'shared/../../etc/passwd']) {
    const result = await admin.request(`/api/m/files/list?path=${target}`);
    assert.ok(result.status >= 400, `la ruta ${target} no debía admitirse (${result.status})`);
  }
});

test('una persona no puede entrar en la carpeta personal de otra', async () => {
  const admin = client();
  const adminLogin = await admin.login('admin', ADMIN_PASSWORD);
  const adminId = adminLogin.data.user.id;

  const user = client();
  await user.login('prueba', USER_PASSWORD);
  const result = await user.request(`/api/m/files/list?path=u/${adminId}`);
  assert.equal(result.status, 403);
});

test('un usuario normal no puede borrar ficheros compartidos', async () => {
  const user = client();
  await user.login('prueba', USER_PASSWORD);
  const result = await user.request('/api/m/files/delete', {
    method: 'POST',
    body: { path: 'shared/alguna-vez-creado.txt' },
  });
  assert.equal(result.status, 403);
});

test('desactivar un módulo oculta sus rutas', async () => {
  const admin = client();
  await admin.login('admin', ADMIN_PASSWORD);

  const off = await admin.request('/api/admin/modules/notices', {
    method: 'PATCH',
    body: { enabled: false },
  });
  assert.equal(off.status, 200);

  const hidden = await admin.request('/api/m/notices/posts');
  assert.equal(hidden.status, 404);

  const on = await admin.request('/api/admin/modules/notices', {
    method: 'PATCH',
    body: { enabled: true },
  });
  assert.equal(on.status, 200);
  const visible = await admin.request('/api/m/notices/posts');
  assert.equal(visible.status, 200);
});

test('OIDC publica discovery y JWKS', async () => {
  const discovery = await fetch(`${BASE}/.well-known/openid-configuration`);
  assert.equal(discovery.status, 200);
  const data = await discovery.json();
  assert.equal(data.issuer, BASE);
  assert.ok(data.authorization_endpoint.endsWith('/oidc/authorize'));
  assert.ok(data.token_endpoint.endsWith('/oidc/token'));

  const jwks = await fetch(`${BASE}/.well-known/jwks`);
  assert.equal(jwks.status, 200);
  const keys = await jwks.json();
  assert.ok(Array.isArray(keys.keys) && keys.keys.length > 0, 'faltan claves de firma');
  assert.equal(keys.keys[0].kty, 'RSA');
});

test('flujo OIDC completo: authorize → token → userinfo', async () => {
  const admin = client();
  await admin.login('admin', ADMIN_PASSWORD);

  const clientResult = await admin.request('/api/admin/oidc/clients', {
    method: 'POST',
    body: {
      name: 'Prueba SSO',
      redirectUris: ['https://app.example/callback'],
    },
  });
  assert.equal(clientResult.status, 201, JSON.stringify(clientResult.data));
  const clientId = clientResult.data.client.client_id;
  const clientSecret = clientResult.data.clientSecret;

  const user = client();
  const userLogin = await user.login('prueba', USER_PASSWORD);
  assert.equal(userLogin.status, 200, JSON.stringify(userLogin.data));

  const authorize = await user.request(
    `/oidc/authorize?response_type=code&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent('https://app.example/callback')}` +
      '&scope=openid%20profile%20email%20offline_access&state=xyz123',
  );
  assert.equal(authorize.status, 302, JSON.stringify(authorize.data));
  const location = authorize.headers.get('location');
  assert.ok(location, 'falta la cabecera Location');
  const code = new URL(location).searchParams.get('code');
  assert.ok(code, 'falta el código de autorización');

  const token = await fetch(`${BASE}/oidc/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE,
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://app.example/callback',
    }),
  });
  const tokenBody = await token.text();
  assert.equal(token.status, 200, tokenBody);
  const tokens = JSON.parse(tokenBody);
  assert.ok(tokens.access_token, 'falta el access_token');
  assert.ok(tokens.id_token, 'falta el id_token');
  assert.ok(tokens.refresh_token, 'falta el refresh_token');

  const userinfo = await fetch(`${BASE}/oidc/userinfo`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  assert.equal(userinfo.status, 200);
  const profile = await userinfo.json();
  assert.equal(profile.preferred_username, 'prueba');
  assert.equal(profile.email, 'prueba@redlba.test');
});

test('el gateway de SSO devuelve las cabeceras de identidad', async () => {
  const user = client();
  await user.login('prueba', USER_PASSWORD);
  const result = await user.request('/api/gateway/auth');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('x-redlba-user'), 'prueba');
  assert.ok(result.headers.get('x-redlba-roles') !== null);

  const anonymous = await fetch(`${BASE}/api/gateway/auth`);
  assert.equal(anonymous.status, 401);
});
