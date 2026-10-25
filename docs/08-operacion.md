# 08 · Operación

## 1. Salud y métricas

```bash
curl -s http://localhost:8080/api/health | jq
```

```json
{ "status": "ok", "version": "0.1.0", "uptime": 43201, "ldap": "ok", "db": "ok", "mail": "ldap" }
```

- `/api/health` es público pero solo revela estado, nunca configuración.
- Logs en JSON por stdout (`docker compose logs -f redlba`). Cada línea lleva `reqId`, `userId`,
  `route`, `ms`. Con `LOG_LEVEL=debug` se añaden binds LDAP (sin contraseñas).
- Auditoría en SQLite (`audit_events`): login, logout, altas/bajas, cambios de permisos, módulos,
  buzones y errores 403. Se consulta desde el panel y por API.

## 2. Copias de seguridad

| Qué | Cómo | Frecuencia |
|---|---|---|
| SQLite de RedLBA | `npm run backup` (usa `VACUUM INTO`, seguro en caliente) | diaria |
| LDAP | `slapcat -n 0 -l ldap.dif` (config) + `slapcat -n 1` (datos) | diaria |
| `.env` | copia cifrada fuera del servidor | al cambiar |
| Correo | `doveadm backup` o rsync del Maildir | según volumen |

Script de ejemplo para cron (03:30):

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /opt/redlba
docker compose exec -T redlba npm run backup
docker compose exec -T openldap slapcat > /backup/ldap-$(date +%F).ldif
find /backup -type f -mtime +14 -delete
```

**Prueba la restauración** una vez al trimestre: un backup que nunca se restauró no es un backup.

## 3. Restauración

```bash
docker compose stop redlba
cp /backup/redlba-2026-10-24.db data/redlba.db
docker compose start redlba
```

Para LDAP: `docker compose stop openldap`, borra el volumen de datos (o usa `slapadd -l` sobre un
directorio vacío) y arranca. Si restauras LDAP, las sesiones existentes siguen valiendo hasta su
caducidad, pero los usuarios nuevos deben volver a entrar.

## 4. Actualización

```bash
git pull
docker compose build --pull
docker compose up -d
```

- El esquema de SQLite se crea y actualiza solo al arrancar (sentencias `CREATE TABLE IF NOT EXISTS`).
  No hay pasos de migración manuales en la v0.1.
- Antes de actualizar entre versiones menores: backup de SQLite y `.env`.
- `SECRET_KEY` no cambia entre versiones; si la rotas, todos vuelven a iniciar sesión.

## 5. Seguridad operativa

- Publica solo 80/443. RedLBA y LDAP quedan en la red interna de Docker.
- `TRUST_PROXY=true` únicamente si hay proxy delante; en acceso directo, `false`.
- Fuerza TLS en Caddy (`deploy/Caddyfile` ya redirige 80→443) y HSTS en el portal.
- Limita el panel de administración por IP si el servidor es público (`@admin` matcher en Caddy).
- Rota `LDAP_BIND_PASSWORD` y `SECRET_KEY` al menos una vez al año.
- Revisa `audit_events` con `action LIKE 'auth.%'` y `result='fail'` para detectar fuerza bruta.
- Desactiva el admin local (`AUTH_MODE=ldap`) cuando el directorio esté estable y tengas al menos dos
  cuentas con `owner`.

## 6. Diagnóstico rápido

| Síntoma | Comando | Qué mirar |
|---|---|---|
| No puedo entrar | `docker compose logs redlba \| grep login` | `reason=invalid_credentials` vs `ldap_unreachable` |
| Tras proxy, todo 403 | `curl -H 'Origin: https://...' ...` | `REDLBA_BASE_URL` y `COOKIE_DOMAIN` |
| Un módulo da 404 | `curl /api/bootstrap` | `modules[].enabled`, `hostname` |
| LDAP lento | `/api/health` y logs `ldap_ms` | tamaño del árbol, falta de índices en `mail`/`uid` |
| Sesiones que caducan pronto | panel → usuario → sesiones | `SESSION_TTL_HOURS`, reloj del servidor |

## 7. Recursos

Para 1.000 usuarios en una máquina de 2 vCPU / 2 GB:

- RedLBA: ~120 MB de RAM, <1 % CPU en reposo.
- SQLite: ~2 MB por 1.000 usuarios + ~8 MB por 100.000 eventos de auditoría (rota a 90 días con
  `AUDIT_RETENTION_DAYS`).
- OpenLDAP: ~80 MB, MDB de pocos MB.
