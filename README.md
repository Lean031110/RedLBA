# RedLBA

Portal de identidad y servicios para un servidor propio, al estilo Google Workspace pero autoalojado:
**una sola cuenta para todos los sitios del servidor**, directorio de personas, buscador unificado,
panel de administración, permisos por rol y un sistema de módulos activables con dominio propio.

> Estado: **v0.1.0 (MVP funcional)**. La base (identidad, SSO, permisos, módulos, buscador, correo,
> panel) está implementada y probada. Ver [docs/09-roadmap.md](docs/09-roadmap.md) para lo que falta.

---

## Qué resuelve

| Necesidad | Cómo lo resuelve RedLBA |
|---|---|
| Una cuenta para todos los servicios | Sesión única en el dominio padre (`COOKIE_DOMAIN`) y `forward_auth` para Caddy: cualquier web detrás del proxy recibe la identidad del usuario por cabeceras. |
| No reconstruir la identidad | **LDAP (OpenLDAP) es la fuente de verdad** de usuarios, grupos y contraseñas. RedLBA lo administra, no lo reemplaza. |
| Correos por cuenta | Aprovisiona buzones (`mail`, cuota, estado) en LDAP, listo para Postfix/Dovecot, o vía API de Mailcow. |
| Buscador | Módulo independiente, con su propio subdominio, que agrega personas, aplicaciones, avisos y ficheros. |
| Dar o quitar funciones | Cada módulo se activa/desactiva desde el panel y puede servirse en un dominio distinto. |
| Permisos | RBAC con permisos granulares y mapeo automático de grupos LDAP → roles. |
| SSO hacia otras apps | **Proveedor OpenID Connect** integrado: discovery, JWKS, `authorize`, `token`, `userinfo` y clientes dados de alta en el panel. |
| Correo como Gmail | **Webmail integrado** (IMAP/SMTP): carpetas, búsqueda, estrellas, borradores y envío, con la contraseña guardada cifrada. |
| Intranet sin internet | **Tablón de avisos** y **espacio de ficheros** personal y compartido, todo local al servidor. |

## Stack

- **Backend**: Node.js 22+ / Fastify 5 / TypeScript / SQLite (`node:sqlite`) / ldapts / imapflow + nodemailer
- **Frontend**: React 19 + Vite + CSS propio (sin framework de UI, diseño minimalista)
- **Infra**: Docker Compose (RedLBA + OpenLDAP + Caddy opcional), proxy inverso Caddy con TLS automático
- **Directorio**: OpenLDAP 2.6 (cualquier LDAPv3 compatible)

## Arranque rápido (desarrollo, sin LDAP)

```bash
npm install
cp .env.example .env          # revisa ADMIN_PASSWORD
npm run dev                   # API en :8080 y web en :5173
```

Abre `http://localhost:5173` e inicia sesión con `admin` / la contraseña de `.env`.
El modo por defecto es `AUTH_MODE=hybrid`: usa LDAP si está disponible y, si no, la cuenta local de
emergencia (útil para montar el servidor antes de tener el directorio listo).

## Arranque en servidor (Docker)

```bash
cp .env.example .env
# 1) dominio, contraseñas y SECRET_KEY
docker compose up -d --build
docker compose exec redlba npm run bootstrap   # crea admin local + roles base
```

Luego apunta `portal.TUDOMINIO` al servidor y publica el portal detrás de Caddy
([deploy/Caddyfile](deploy/Caddyfile)). Guía completa: [docs/02-instalacion.md](docs/02-instalacion.md).

## Instalación en un servidor Ubuntu

```bash
./install.sh --dominio tudominio.com --auto     # solo genera configuración y guías
sudo ./install.sh --dominio tudominio.com --auto --aplicar   # además escribe en /etc y arranca el servicio
```

El instalador detecta los servicios ya presentes (Caddy, nginx, bind9, dnsmasq, postfix, dovecot,
slapd), crea `.env`, genera la zona DNS con `portal/admin/buscar/correo`, el Caddyfile y la
configuración de correo. Si un servicio ya está personalizado **no lo toca**: deja el fichero en
`deploy/generated/` y una guía paso a paso en `INFORME-INSTALACION.md`.

## Pruebas y CI

```bash
npm run typecheck   # tipos de servidor y web
npm test            # compila y ejecuta las pruebas de la API (17 pruebas)
```

El flujo [.github/workflows/ci.yml](.github/workflows/ci.yml) ejecuta tipos, compilación, pruebas,
la sintaxis del instalador y un arranque real en Ubuntu 24.04 en cada push y pull request.

## Documentación

1. [Arquitectura y decisiones](docs/01-arquitectura.md)
2. [Instalación y configuración](docs/02-instalacion.md)
3. [Sistema de módulos y dominios](docs/03-modulos.md)
4. [Permisos y roles](docs/04-permisos.md)
5. [Integración con LDAP](docs/05-ldap.md)
6. [Correo y buzones](docs/06-correo.md)
7. [Referencia de API](docs/07-api.md)
8. [Operación: backups, logs, actualización](docs/08-operacion.md)
9. [Roadmap](docs/09-roadmap.md)
10. [Integraciones futuras](docs/10-integraciones-futuras.md)

## Estructura

```
server/            API Fastify + lógica de identidad, módulos y correo
  src/core/        config, db, ldap, auth, oidc, rbac, módulos, auditoría
  src/modules/     módulos del producto (search, mail, directory, apps, audit, notices, files)
  src/routes/      endpoints HTTP (auth, oidc, portal, admin)
web/               SPA React (portal + panel de administración)
deploy/            Caddyfile, LDIF de OpenLDAP, compose auxiliar
docs/              documentación funcional y técnica
test/              pruebas de la API con el runner nativo de Node
install.sh         instalador para Ubuntu/Debian
.github/workflows/ flujo de CI
```

## Licencia

Uso libre para instalaciones propias. (Añade aquí la licencia que prefieras antes de distribuirlo.)
