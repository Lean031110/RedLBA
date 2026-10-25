# 09 · Roadmap

## v0.1 — MVP (estado actual)

- [x] Identidad LDAP (login, JIT provisioning, alta de usuarios, SSHA, cambio de contraseña)
- [x] Cuenta local de emergencia (`AUTH_MODE=hybrid`)
- [x] Sesiones con cookie compartida entre subdominios + CSRF + revocación
- [x] RBAC con permisos granulares, roles de sistema y mapeo de grupos LDAP
- [x] Panel de administración: usuarios, grupos, roles, módulos, apps, correo, auditoría, ajustes
- [x] Sistema de módulos activables con hostname propio y guardas comunes
- [x] Buscador unificado (personas, apps, módulos) con su propio dominio
- [x] Aprovisionamiento de buzones (driver LDAP y Mailcow) y alias
- [x] Perfiles de usuario con visibilidad configurable
- [x] SSO para el resto del servidor vía Caddy `forward_auth`
- [x] Proveedor OIDC/OAuth2 propio (discovery, JWKS, authorize, token, userinfo, refresh) con
  clientes dados de alta en el panel
- [x] Webmail integrado (IMAP/SMTP): carpetas, búsqueda, estrellas, borradores, envío
- [x] Módulos de intranet sin internet: `notices` (tablón) y `files` (área personal + compartida)
- [x] Subdominios `portal`/`admin`/`buscar`/`correo` resueltos por cabecera `Host`
- [x] Instalador para Ubuntu (`install.sh`) con detección de servicios y guías
- [x] Suite de pruebas de la API y flujo de CI en GitHub Actions
- [x] Docker Compose, Caddyfile, LDIF de ejemplo, documentación

## v0.2 — Endurecimiento y operación

- [ ] 2FA TOTP para cuentas con `admin.access` (obligatorio configurable)
- [ ] Invitaciones por correo con enlace de un solo uso
- [ ] Rotación automática de auditoría y exportación a syslog/HTTP
- [ ] Métricas Prometheus (`/metrics`) y alertas básicas
- [ ] Webhooks (`user.created`, `mailbox.created`, `login.failed`)

## v0.3 — Producto

- [ ] Módulo `calendar`/`contacts` (CalDAV/CardDAV delegado)
- [ ] Autoservicio: el usuario solicita acceso a una app y un admin aprueba
- [ ] Editor visual de roles y simulador ("¿qué ve Ana?")
- [ ] Tema claro/oscuro persistente y personalización de marca por servidor
- [ ] i18n (es/en) y accesibilidad AA

## v1.0 — Estable

- [ ] PostgreSQL como backend opcional (migración automática desde SQLite)
- [ ] Multitenant / múltiples dominios de correo
- [ ] API keys de servicio y scopes para integraciones
- [ ] Backups programados desde el panel + verificación de restauración
- [ ] Migraciones con rollback y `CHANGELOG` semántico
- [ ] Suite de tests e2e (Playwright)

## Fuera de alcance (a propósito)

- Servidor SMTP/IMAP propio, antispam o DKIM: se delega en Postfix/Dovecot/Mailcow.
- Almacenamiento de ficheros propietario: se integra con Nextcloud/Seafile.
- Suite ofimática o videollamadas: se enlazan desde el catálogo de apps.
- Kubernetes/HA: el objetivo es un servidor bien montado, no un clúster.
