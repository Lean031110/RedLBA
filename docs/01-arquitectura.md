# 01 · Arquitectura y decisiones

## 1. Objetivo

RedLBA es el **plano de control** de un servidor: identidad, permisos, catálogo de servicios y
administración. No intenta reimplementar un servidor de correo ni un almacenamiento de ficheros:
se apoya en piezas estándar (LDAP, Postfix/Dovecot, Caddy) y las unifica en una sola experiencia.

```
                       ┌──────────────────────────────┐
   navegador  ───────► │  Caddy (TLS, dominios)       │
                       │  portal.redlba.tld           │
                       │  buscar.redlba.tld           │
                       │  correo.redlba.tld           │
                       └───────┬──────────────┬───────┘
                               │              │  forward_auth
                    ┌──────────▼───────┐      │  (cualquier sitio del servidor)
                    │  RedLBA (Node)   │◄─────┘
                    │  ─ API /api/*    │
                    │  ─ SPA estática  │
                    └───┬──────────┬───┘
                        │          │
              ┌─────────▼──┐   ┌───▼──────────────┐
              │ SQLite      │   │ OpenLDAP          │
              │ (control)   │   │ (identidad)       │
              │ sesiones    │   │ usuarios, grupos, │
              │ roles       │   │ contraseñas,      │
              │ módulos     │   │ atributos de      │
              │ auditoría   │   │ correo            │
              └─────────────┘   └───────────────────┘
                        │
              ┌─────────▼─────────────────────────────┐
              │ Servicios del servidor (opcionales)   │
              │ Postfix/Dovecot · Nextcloud · Gitea…  │
              └───────────────────────────────────────┘
```

## 2. Reparto de responsabilidades

| Capa | Guarda | Por qué |
|---|---|---|
| **LDAP** | Personas, grupos, contraseñas, atributos de correo | Es el estándar que ya entienden Postfix, Dovecot, Nextcloud, Gitea, Jellyfin, etc. Si algún día RedLBA desaparece, las cuentas siguen existiendo. |
| **SQLite** | Sesiones, roles y permisos, configuración de módulos, catálogo de apps, auditoría, estado de buzones | Datos operativos que no pertenecen al directorio corporativo. Copia de seguridad = un fichero. |
| **RedLBA** | Orquestación y UI | No es la fuente de verdad de nada crítico: se puede reinstalar sin perder cuentas. |

Esta separación es la decisión más importante del proyecto: **la identidad vive en LDAP**, así que
RedLBA puede actualizarse, romperse o reinstalarse sin dejar a nadie sin cuenta.

## 3. Flujo de autenticación

```
1. POST /api/auth/login  { username, password }
2. RedLBA busca el DN del usuario (uid=...,ou=people,dc=...)
3. Bind LDAP con ese DN y la contraseña  →  OK / invalidCredentials
4. Provisioning JIT: se copia el usuario y sus grupos a la caché SQLite
5. Se resuelven permisos: rol directo + roles heredados de grupos LDAP
6. Se crea sesión (SQLite) y se emite cookie HttpOnly firmada
   Dominio = COOKIE_DOMAIN (.redlba.tld)  →  válida en TODOS los subdominios
```

- La cookie es `HttpOnly`, `SameSite=Lax`, `Secure` cuando el origen es HTTPS.
- Toda mutación exige mismo origen + cabecera `X-RedLBA-CSRF` con el token de la sesión
  (se entrega en `/api/auth/me` y se guarda en memoria del cliente, nunca en `localStorage`).
- Las sesiones caducan por inactividad (`SESSION_TTL_HOURS`, por defecto 12 h) y máximo absoluto
  de 7 días. Revocables desde el panel (ver sesiones de un usuario).

### SSO para el resto del servidor

Caddy pregunta a RedLBA antes de entregar cualquier sitio protegido:

```caddyfile
forward_auth redlba:8080 {
    uri /api/gateway/auth
    copy_headers X-RedLBA-User X-RedLBA-Email X-RedLBA-Groups X-RedLBA-Roles
}
```

`/api/gateway/auth` responde `200` + cabeceras si hay sesión válida y `401` si no; el sitio de detrás
solo tiene que confiar en esas cabeceras (patrón *trusted header auth*). Es el equivalente ligero de
un OAuth2 Proxy, sin dependencias extra. Un proveedor OIDC propio está en el roadmap para apps que
exijan OAuth2/OIDC real.

## 4. Módulos y dominios

Un módulo es una unidad de producto (buscador, correo, directorio, apps, auditoría) que:

- se activa o desactiva desde el panel;
- puede tener **su propio hostname** (`buscar.redlba.tld`), o vivir bajo el portal en `/m/<clave>`;
- aporta rutas de API, entradas de menú y, opcionalmente, resultados de búsqueda.

```ts
interface RedlbaModule {
  key: string
  name: string
  description: string
  icon: string
  adminOnly?: boolean
  defaultPath: string
  register(ctx): void            // rutas Fastify
  search?(ctx, q, user): Promise<SearchResult[]>
  menu?(user): MenuItem[]
}
```

La resolución del módulo activo se hace por cabecera `Host`: si el host coincide con el `hostname`
configurado de un módulo habilitado, la SPA abre directamente ese módulo. Detalle en
[03-modulos.md](03-modulos.md).

## 5. Permisos

RBAC plano con permisos granulares (`users.write`, `modules.manage`, `mail.manage`…), asignados a
roles, y roles asignados a usuarios **o a grupos LDAP**. Los grupos son la vía recomendada: se
gestionan en el directorio y RedLBA los traduce a roles en cada login. Detalle en
[04-permisos.md](04-permisos.md).

## 6. Por qué estas tecnologías

| Elección | Alternativa descartada | Motivo |
|---|---|---|
| Fastify + TS | NestJS, Django | Arranque en milisegundos, pocas dependencias, tipado claro; cabe en una Raspberry. |
| SQLite (WAL) | PostgreSQL | Instalación de un solo contenedor, backup de un fichero, suficiente para decenas de miles de usuarios. El acceso está aislado en `core/db.ts` para poder migrar. |
| React + CSS propio | MUI/Ant/Next | Control total del diseño minimalista, sin 200 kB de estilos ajenos y sin build de servidor. |
| Cookies de sesión | JWT en localStorage | Revocación inmediata, sin XSS trivial, SSO real entre subdominios. |
| LDAP como fuente de verdad | Usuarios solo en SQLite | Interoperabilidad inmediata con el resto del servidor. |
| Caddy | Nginx + certbot | TLS automático, configuración de 10 líneas, `forward_auth` nativo. |

## 7. Límites conocidos de la v0.1

- No hay proveedor OIDC/OAuth2 todavía (solo sesión + cabeceras de confianza).
- El buscador indexa directorio, apps y módulos; no contenido de ficheros ni correo.
- Un solo tenant (una organización). Multitenant está en el roadmap.
- La caché de usuarios se refresca en cada login y con `npm run ldap:sync` (cron cada 15 min).
