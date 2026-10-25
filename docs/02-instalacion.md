# 02 · Instalación y configuración

## 1. Requisitos

- Linux (probado en Ubuntu 24.04 / Debian 12) o macOS para desarrollo
- Docker 24+ y Docker Compose v2 **o** Node.js 22+ si instalas sin contenedores
- 1 vCPU / 1 GB de RAM para RedLBA (más si compartes máquina con correo)
- Dominio con capacidad de crear subdominios (`portal`, `buscar`, `correo`…)

## 2. Instalación automática en Ubuntu (`install.sh`)

```bash
./install.sh --dominio tudominio.com --auto                   # solo genera configuración y guías
sudo ./install.sh --dominio tudominio.com --auto --aplicar     # además escribe en /etc y arranca el servicio
```

Qué hace:

1. Detecta Ubuntu/Debian y los servicios presentes (Caddy, nginx, bind9, dnsmasq, postfix,
   dovecot, slapd, Docker).
2. Crea `.env` con `SECRET_KEY`, dominio, subdominios (`portal`, `admin`, `buscar`, `correo`) y
   parámetros de LDAP/correo. Si ya existe, lo conserva.
3. Genera la zona DNS con los registros `A` de cada subdominio (bind9 o dnsmasq).
4. Genera el Caddyfile con los cuatro subdominios y, si existe nginx, también su bloque `proxy_pass`.
5. Crea las guías de correo y de LDAP y la plantilla de transporte LDAP de Postfix.
6. Instala dependencias, compila y prepara la unidad `redlba.service`.
7. Escribe `deploy/generated/INFORME-INSTALACION.md` con lo hecho y lo que queda pendiente.

**Regla de seguridad**: solo escribe en `/etc` con `--aplicar`, y siempre después de guardar una
copia con extensión `.bak.redlba`. Si un servicio ya tiene configuración propia no la modifica:
deja el fichero generado en `deploy/generated/` y los pasos exactos en la guía.

| Opción / variable | Efecto |
|---|---|
| `--dominio <d>` | Dominio raíz (obligatorio en `--auto`) |
| `--puerto <n>` | Puerto de la app (8080 por defecto) |
| `--aplicar` | Instala los ficheros generados en `/etc` y recarga los servicios |
| `--sin-internet` | No descarga nada: exige `node_modules` presente |
| `REDLBA_SERVER_IP` | IP de los registros DNS (si no, la primera de `hostname -I`) |

## 3. Instalación con Docker (recomendada)

```bash
git clone <tu-repo> redlba && cd redlba
cp .env.example .env
```

Edita `.env` — lo mínimo imprescindible:

```env
REDLBA_DOMAIN=redlba.tld
REDLBA_BASE_URL=https://portal.redlba.tld
SECRET_KEY=<64 caracteres aleatorios>     # openssl rand -hex 32
ADMIN_PASSWORD=<contraseña fuerte>        # cuenta local de emergencia
LDAP_BIND_PASSWORD=<otra contraseña fuerte>
```

```bash
docker compose up -d --build
docker compose exec redlba npm run bootstrap
docker compose logs -f redlba
```

`bootstrap` es idempotente: crea los roles del sistema, el usuario local de emergencia, los módulos
base y carga el catálogo inicial de aplicaciones. Se puede ejecutar las veces que haga falta.

Comprobación:

```bash
curl -fsS http://localhost:8080/api/health
# {"status":"ok","version":"0.1.0","ldap":"ok|unavailable"}
```

### Servicios del compose

| Servicio | Puerto | Notas |
|---|---|---|
| `redlba` | 8080 (interno) | API + SPA estática. No lo publiques a Internet sin proxy. |
| `openldap` | 389 (interno) | Directorio de ejemplo (Bitnami OpenLDAP) con `ou=people` y el grupo `redlba-usuarios`. Para producción, usa tu propio directorio o monta el LDIF de `deploy/ldap/`. |
| `caddy` (perfil `proxy`) | 80/443 | TLS automático + dominios de módulos. |

```bash
docker compose --profile proxy up -d      # añade Caddy
```

## 4. Instalación sin Docker

```bash
npm install
npm run build
cp .env.example .env
npm run bootstrap
npm start          # sirve API + web compilada en :8080
npm run dev        # alternativa de desarrollo con recarga (API :8080, web :5173)
```

Necesitas un LDAP accesible (puede ser el de otra máquina) o `AUTH_MODE=local` para empezar solo con
la cuenta de administración local.

## 5. Variables de entorno

### Núcleo

| Variable | Por defecto | Descripción |
|---|---|---|
| `REDLBA_DOMAIN` | `redlba.local` | Dominio raíz. Se usa para cookies y valores por defecto. |
| `REDLBA_BASE_URL` | `http://localhost:8080` | URL pública del portal. Debe coincidir con el proxy (CORS/origen). |
| `PORT` | `8080` | Puerto de la API. |
| `DATABASE_PATH` | `./data/redlba.db` | Ruta del SQLite (volumen persistente). |
| `SECRET_KEY` | — | Firma de cookies y tokens. **Obligatoria en producción.** |
| `COOKIE_DOMAIN` | automático | Dominio de la cookie. Se deduce del dominio raíz cuando la URL pública está en él o en un subdominio; en `localhost` se deja como cookie de host. Fíjalo a mano para SSO entre subdominios. |
| `SESSION_TTL_HOURS` | `12` | Caducidad por inactividad. |
| `TRUST_PROXY` | `true` | Lee `X-Forwarded-*` (necesario detrás de Caddy). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

### Autenticación

| Variable | Por defecto | Descripción |
|---|---|---|
| `AUTH_MODE` | `hybrid` | `ldap` (solo directorio), `local` (solo SQLite), `hybrid` (LDAP + admin local de respaldo). |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / — | Cuenta local de emergencia, solo para `local`/`hybrid`. |
| `LDAP_URL` | `ldap://openldap:389` | URL del directorio (`ldaps://` soportado). |
| `LDAP_BIND_DN` | — | Cuenta de servicio con permiso de lectura y escritura en personas/grupos. |
| `LDAP_BIND_PASSWORD` | — | Contraseña de esa cuenta. |
| `LDAP_BASE_DN` | `dc=redlba,dc=local` | Base del árbol. |
| `LDAP_USERS_OU` | `ou=people` | OU donde viven los usuarios (relativa a la base). |
| `LDAP_GROUPS_OU` | `ou=groups` | OU de grupos. |
| `LDAP_USER_ATTR` | `uid` | Atributo de login (`uid` o `cn`/`sAMAccountName` en AD). |
| `LDAP_STARTTLS` | `false` | Exige StartTLS (recomendado si no usas `ldaps://`). |
| `LDAP_TLS_INSECURE` | `false` | Acepta certificados autofirmados (solo laboratorio). |

### Correo

| Variable | Por defecto | Descripción |
|---|---|---|
| `MAIL_DRIVER` | `ldap` | `ldap`, `mailcow` o `none`. |
| `MAIL_DOMAIN` | `${REDLBA_DOMAIN}` | Dominio de las direcciones. |
| `MAIL_DEFAULT_QUOTA_MB` | `5120` | Cuota inicial por buzón. |
| `MAILCOW_URL` / `MAILCOW_API_KEY` | — | Solo si `MAIL_DRIVER=mailcow`. |
| `MAIL_ALIASES_ENABLED` | `true` | Permite crear alias desde el panel. |

> Nunca escribas secretos en ficheros versionados: `.env` está en `.gitignore` y en Docker se inyecta
> por `env_file`. Para rotar `SECRET_KEY` se invalidan las sesiones (los usuarios deben reentrar).

## 6. DNS y TLS

Crea estos registros (ajusta a los módulos que actives):

```
portal.redlba.tld.   A     203.0.113.10
buscar.redlba.tld.   A     203.0.113.10
*.redlba.tld.        A     203.0.113.10     # opcional, para módulos futuros
```

Con Caddy el certificado se emite solo (`deploy/Caddyfile`). Si usas otro proxy, publica únicamente
el 443 hacia `redlba:8080` y activa `TRUST_PROXY=true`.

### Nombres de módulos

En el panel → **Módulos** → *Dominio*, escribe `buscar.redlba.tld` y guarda. RedLBA actualiza el
`snippet` de Caddy que puedes generar con **Módulos → Ver configuración de proxy**, o recarga Caddy
si usas el Caddyfile dinámico incluido (`deploy/Caddyfile` ya enruta `*.{$REDLBA_DOMAIN}` al portal,
así que en la mayoría de casos no hay que tocar nada).

## 7. Primeros pasos en el panel

1. Entra con la cuenta de administración.
2. **Ajustes** → confirma el dominio raíz y la URL pública.
3. **LDAP** → prueba la conexión y ejecuta *Importar usuarios* (o espera al cron).
4. **Roles** → revisa `Administrador` y `Usuario`; mapea grupos LDAP (p. ej. `redlba-admins` → Administrador).
5. **Módulos** → activa buscador, correo, directorio; asigna dominios si quieres.
6. **Aplicaciones** → añade los sitios del servidor (Nextcloud, Gitea…) para que aparezcan en el portal.
7. Crea una cuenta de prueba y verifica el SSO en un sitio protegido por `forward_auth`.

## 8. Copias de seguridad

```bash
# SQLite consistente + directorio
docker compose exec redlba npm run backup      # deja data/backups/redlba-<fecha>.db
docker compose exec openldap slapcat > ldap-$(date +%F).ldif
```

Restauración: para RedLBA basta con reponer el `.db` (parando el servicio); para LDAP, `slapadd`.
Detalle en [08-operacion.md](08-operacion.md).

## 9. Problemas frecuentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| `ldap: unavailable` en `/api/health` | URL, DN de bind o contraseña incorrectos | `docker compose logs openldap`; prueba `ldapsearch -H $LDAP_URL -D $LDAP_BIND_DN -w ...` |
| Login correcto pero sin permisos | El usuario no está en ningún grupo mapeado | Panel → Roles → *Vincular grupo*; o asigna rol directo al usuario |
| La sesión no se comparte entre subdominios | `COOKIE_DOMAIN` mal o TLS sin `Secure` | Usa `.tudominio.tld` y sirve todo por HTTPS |
| `403 Origen no permitido` | `REDLBA_BASE_URL` no coincide con el navegador | Iguala esquema, host y puerto exactos |
| Caddy devuelve 502 | RedLBA no escucha en `0.0.0.0` | `HOST=0.0.0.0` y revisa `docker compose ps` |
