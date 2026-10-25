# 07 · Referencia de API

Base: `${REDLBA_BASE_URL}/api`. Todas las respuestas son JSON. Autenticación por cookie de sesión
`redlba_session`. Las mutaciones (`POST`/`PUT`/`PATCH`/`DELETE`) exigen:

```
Origin: https://portal.redlba.tld      (coincide con REDLBA_BASE_URL)
X-RedLBA-CSRF: <token de /api/auth/me>
```

Errores: `{ "error": "código", "message": "texto", "required"?: "permiso" }` con HTTP
`400` (validación), `401` (sin sesión), `403` (permiso/origen), `404`, `409` (conflicto), `429`
(rate limit), `500`.

## Público

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/health` | Estado del servicio, versión y conectividad LDAP. |
| `GET` | `/api/bootstrap` | Configuración pública: nombre, dominio, módulos activos, módulo actual según `Host`, usuario (si hay sesión). |
| `POST` | `/api/auth/login` | `{ username, password }` → sesión + `csrfToken` + usuario. |
| `POST` | `/api/auth/logout` | Cierra la sesión actual. |
| `GET` | `/api/auth/me` | Usuario, permisos, roles y `csrfToken`. `401` si no hay sesión. |
| `POST` | `/api/auth/password` | `{ currentPassword, newPassword }` (autenticado). |
| `GET` | `/.well-known/openid-configuration` | Discovery del proveedor OIDC (issuer, endpoints, scopes). |
| `GET` | `/.well-known/jwks` | Claves públicas RS256 para verificar los tokens. |
| `GET` | `/oidc/authorize` | Flujo *authorization code*: `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`, `nonce`, PKCE opcional. Redirige a `/login` sin sesión. |
| `POST` | `/oidc/token` | `authorization_code` (Basic o `client_id`/`client_secret`) y `refresh_token`. |
| `GET` | `/oidc/userinfo` | `Authorization: Bearer <access_token>` → `sub`, `name`, `preferred_username`, `email`, `groups`. |

## Portal (usuario autenticado)

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| `GET` | `/api/portal/dashboard` | — | Apps visibles, módulos activos, accesos recientes, perfil resumido. |
| `GET` | `/api/profile` | — | Perfil propio completo. |
| `PATCH` | `/api/profile` | — | Edita campos permitidos: nombre, cargo, teléfono, bio, visibilidad, avatar. |
| `GET` | `/api/directory?q=&page=` | `users.read` | Directorio paginado, respetando visibilidad. |
| `GET` | `/api/directory/:username` | `users.read` | Ficha pública de una persona. |
| `GET` | `/api/apps` | `apps.read` | Catálogo filtrado por permisos. |
| `GET` | `/api/gateway/auth` | — | Endpoint para `forward_auth` de Caddy. |
| `GET` | `/api/sessions` | — | Sesiones activas propias. |
| `DELETE` | `/api/sessions/:id` | — | Cierra otra sesión propia. |

### Gateway (SSO por cabeceras)

```
GET /api/gateway/auth
200 → X-RedLBA-User, X-RedLBA-Email, X-RedLBA-Name, X-RedLBA-Roles, X-RedLBA-Groups
401 → { "error": "unauthorized" }   (Caddy redirige a /login?next=<url>)
```

## Módulos

Todas cuelgan de `/api/m/:module/...` y fallan con `404 module_disabled` si el módulo está apagado.

### Buscador (`search`)

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| `GET` | `/api/m/search/query?q=&limit=` | `search.use` | Resultados agregados: `[{ module, title, subtitle, href, badge }]`. |
| `GET` | `/api/m/search/suggest?q=` | `search.use` | Sugerencias cortas (máx. 5) para el autocompletado. |

### Directorio (`directory`)

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| `GET` | `/api/m/directory/people?q=` | `users.read` | Personas con campos según visibilidad. |
| `GET` | `/api/m/directory/stats` | `users.read` | Totales por departamento y estado. |

### Correo (`mail`)

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| `GET` | `/api/m/mail/mailboxes` | `mail.read` | Inventario de buzones. |
| `POST` | `/api/m/mail/mailboxes` | `mail.manage` | `{ userId, address?, quotaMb? }`. |
| `PATCH` | `/api/m/mail/mailboxes/:address` | `mail.manage` | Cuota o estado. |
| `DELETE` | `/api/m/mail/mailboxes/:address` | `mail.manage` | Baja del buzón. |
| `POST` | `/api/m/mail/aliases` | `mail.manage` | `{ address, targets: [] }`. |
| `GET` | `/api/m/mail/status` | — | Buzones propios del usuario + datos IMAP/SMTP. |

#### Webmail (incluido en `mail`)

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| `GET` | `/api/m/mail/webmail/status` | — | ¿Necesita desbloquearse?, dirección, identidad e IMAP. |
| `POST` | `/api/m/mail/webmail/unlock` | — | `{ password }` validada contra IMAP; se guarda cifrada. `401 unlock_required` si falta. |
| `POST` | `/api/m/mail/webmail/lock` | — | Borra la contraseña guardada. |
| `GET` | `/api/m/mail/webmail/folders` | — | Carpetas con `unseen`/`total`, ordenadas por especial (Entrada, Enviados…). |
| `GET` | `/api/m/mail/webmail/messages?folder=&page=&q=` | — | Lista paginada con remitente, asunto, estrellas y flags. |
| `GET` | `/api/m/mail/webmail/messages/:uid?folder=` | — | Mensaje completo (HTML saneado) y cabeceras. |
| `POST` | `/api/m/mail/webmail/flags` | — | `{ folder, uids, add?, remove? }` (`\\Seen`, `\\Flagged`). |
| `POST` | `/api/m/mail/webmail/move` | — | `{ folder, uids, target }`. |
| `POST` | `/api/m/mail/webmail/delete` | — | `{ folder, uids, trash? }` (a papelera o definitivo). |
| `POST` | `/api/m/mail/webmail/send` | — | `{ to, cc?, subject, text, html?, inReplyTo? }` por SMTP. |
| `POST` | `/api/m/mail/webmail/draft` | — | Guarda el borrador en `Drafts`. |

### Tablón (`notices`)

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| `GET` | `/api/m/notices/posts?q=` | — | Avisos ordenados por fijado y fecha. |
| `POST` | `/api/m/notices/posts` | `notices.write` | `{ title, body, pinned? }`. |
| `PATCH` | `/api/m/notices/posts/:id` | `notices.write` | Edita título, texto o fijado. |
| `DELETE` | `/api/m/notices/posts/:id` | `notices.write` | Elimina el aviso. |

### Archivos (`files`)

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| `GET` | `/api/m/files/list?path=` | — | Entradas de `shared/` o de tu carpeta `u/<id>` + cuota. |
| `GET` | `/api/m/files/download?path=` | — | Descarga en binario (`Content-Disposition`). |
| `POST` | `/api/m/files/upload` | — | Cuerpo binario con cabecera `X-File-Path` (URL-encode). Límite `FILES_MAX_UPLOAD_MB`. |
| `POST` | `/api/m/files/mkdir` | — | `{ path }`. |
| `POST` | `/api/m/files/rename` | — | `{ from, to }`. |
| `POST` | `/api/m/files/delete` | — | `{ path }`. En `shared/` exige `files.manage`; en área personal, ser su dueño. |

### Aplicaciones (`apps`)

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| `GET` | `/api/m/apps` | `apps.read` | Catálogo. |
| `POST` | `/api/m/apps` | `apps.manage` | Alta de app. |
| `PATCH` | `/api/m/apps/:id` | `apps.manage` | Edición. |
| `DELETE` | `/api/m/apps/:id` | `apps.manage` | Baja. |

### Auditoría (`audit`)

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| `GET` | `/api/m/audit/events?q=&actor=&from=&to=&page=` | `audit.read` | Eventos paginados. |
| `GET` | `/api/m/audit/events.csv` | `audit.read` | Exportación CSV. |

## Administración (`/api/admin/*`)

| Método | Ruta | Permiso |
|---|---|---|
| `GET` | `/api/admin/overview` | `admin.access` |
| `GET` | `/api/admin/users?q=&status=&page=` | `users.read` |
| `POST` | `/api/admin/users` | `users.write` |
| `GET` `PATCH` `DELETE` | `/api/admin/users/:id` | `users.read` / `users.write` / `users.delete` |
| `POST` | `/api/admin/users/:id/password` | `users.password` |
| `POST` | `/api/admin/users/:id/roles` | `roles.write` |
| `POST` | `/api/admin/users/:id/disable` · `/enable` | `users.write` |
| `GET` | `/api/admin/groups` · `POST` · `PATCH`/`DELETE` `/:id` | `groups.*` |
| `GET` `POST` | `/api/admin/roles` | `roles.read` / `roles.write` |
| `PATCH` `DELETE` | `/api/admin/roles/:id` | `roles.write` |
| `POST` | `/api/admin/roles/:id/bindings` | `roles.write` (usuario o grupo) |
| `GET` | `/api/admin/roles/matrix` | `roles.read` |
| `GET` | `/api/admin/modules` | `modules.read` |
| `PATCH` | `/api/admin/modules/:key` | `modules.manage` |
| `POST` | `/api/admin/modules/sync` | `modules.manage` |
| `GET` | `/api/admin/modules/proxy-config` | `modules.manage` (snippet de Caddy) |
| `GET` `PATCH` | `/api/admin/settings` | `settings.read` / `settings.write` |
| `POST` | `/api/admin/settings/ldap/test` | `settings.read` |
| `POST` | `/api/admin/settings/ldap/sync` | `users.write` |

### Ejemplos

```bash
# login
curl -c jar -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"cambiame"}'

# sesión y permisos
curl -b jar http://localhost:8080/api/auth/me

# crear usuario
curl -b jar -X POST http://localhost:8080/api/admin/users \
  -H 'Content-Type: application/json' -H "X-RedLBA-CSRF: $CSRF" \
  -d '{"username":"ana","firstName":"Ana","lastName":"Ruiz","email":"ana@redlba.tld","groups":["redlba-usuarios"]}'

# buscador
curl -b jar "http://localhost:8080/api/m/search/query?q=ana"
```

## Rate limits

| Ámbito | Límite |
|---|---|
| `POST /api/auth/login` | 10 intentos / 5 min por IP+usuario |
| API autenticada | 600 req / min por usuario |
| Buscador | 60 req / min por usuario |
| Gateway (`forward_auth`) | 2000 req / min por IP |

Se configura en `settings.rateLimit`. Las cabeceras `X-RateLimit-*` se devuelven en las respuestas
afectadas.

## Versionado

La API es estable dentro de `0.x` con cambios aditivos. En `1.0` se congelará y cualquier ruptura
pasará a `/api/v2`.
