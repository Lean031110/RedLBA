# Integraciones futuras

Ideas ordenadas por prioridad y por lo que aportan a una intranet autoalojada. Todo lo de esta
página es opcional: RedLBA funciona sin ello y **no necesita internet** para operar.

Para empezar una nueva integración basta con crear un módulo en `server/src/modules/` (ver
[docs/03-modulos.md](03-modulos.md)): registro, rutas, página en `web/src/pages/` y fila en
`DEFAULT_MODULES`. Si necesita credenciales, van en `.env` o en los secretos del panel.

---

## 1. SSO con otras aplicaciones (hecho, queda ampliar cobertura)

RedLBA ya es **proveedor OIDC** (`/.well-known/openid-configuration`, `authorize`, `token`,
`userinfo`) y los clientes se dan de alta en Administración → OIDC. Cualquier app compatible se
conecta sin tocar código:

| Aplicación | Cómo se conecta |
|---|---|
| Nextcloud, GitLab, Grafana, Portainer, Vaultwarden, Jenkins, Gitea | OAuth2/OIDC con la URL de discovery de RedLBA |
| Mattermost, Rocket.Chat, Discourse | OpenID Connect |
| Apps antiguas que solo entienden SAML | Requiere puente SAML → OIDC (ver punto 3) |

Pendiente: botón de "crear cliente" con plantillas preconfiguradas por aplicación (una sola
pantalla en lugar de copiar URLs a mano).

## 2. Identidad: MFA, passkeys y recuperación

- **TOTP (2FA)**: tabla `mfa_methods`, desafío en el login y aplicación de 190301 en roles.
- **Passkeys/WebAuthn**: autenticación sin contraseña con llaves del sistema operativo.
- **Códigos de recuperación** de un solo uso y auto-servicio de "he olvidado mi contraseña" por
  correo (ya hay envío SMTP, solo faltaría la plantilla).
- **SCIM 2.0** para sincronizar altas y bajas con otra herramienta de RR. HH.

## 3. Puente SAML 2.0

Muchas aplicaciones empresariales (SharePoint, servicios de terceros) solo entienden SAML. Un módulo
`saml` que emita aserciones firmadas con la clave ya existente de OIDC cubriría esa demanda sin
instalar ADFS ni Keycloak.

## 4. Colaboración ofimática

- **WebDAV** sobre el módulo de archivos: que Nextcloud, Finder o Explorer monten las carpetas de
  RedLBA como unidad de red.
- **CalDAV/CardDAV**: calendario compartido y contactos sincronizables con Thunderbird o el móvil.
- **Editor de documentos** embebido ( Collabora / OnlyOffice en contenedor local) para abrir los
  ficheros del módulo *Archivos* sin descargarlos.
- **Notas y documentos de texto** en el propio portal (sucesor ligero de un wiki).

## 5. Mensajería y presencia

- **Chat interno** tipo Slack con el realtime que ya ofrece la sesión (websockets) y el directorio
  LDAP para los canales.
- **Matrix (Synapse)** detrás del mismo SSO para mensajería cifrada entre equipos.
- **Llamadas VoIP** (Jitsu o Janus) embebido en el perfil de cada persona.

## 6. Operaciones del servidor

| Área | Integración propuesta |
|---|---|
| Copias | Programar `npm run backup` desde el panel y enviar el tar a un almacenamiento NFS/S3 |
| Monitorización | Métricas de `/api/health` exportadas en formato Prometheus + Grafana con el mismo SSO |
| Alertas | Correo o webhook cuando falle LDAP, el disco o el servicio de correo |
| Registro | Exportar `audit_events` a un SIEM (syslog/JSON) para revisión centralizada |
| Actualizaciones | Aviso en el panel de nueva versión con botón de actualización |

## 7. Correo avanzado

- **Antispam y antivirus** (Rspamd + ClamAV) ya instalables en el mismo servidor; RedLBA solo
  aprovisionaría las reglas por usuario.
- **Listas de correo** por grupo LDAP (`redlba-everyone@dominio`).
- **Reglas y filtros** de usuario (sieve) gestionadas desde el webmail.
- **Archivado** cumpliendo la política de retención del servidor.

## 8. Seguridad y cumplimiento

- **IPs y redes permitidas** por módulo (por ejemplo, la VPN interna).
- **Registro de actividad por usuario** ampliado con mapa de sesiones y alertas de acceso raro.
- **Auditoría de permisos**: quién puede qué, exportable, para revisiones periódicas.
- **Bloqueo de cuentas** por intentos fallidos con ventana deslizante.

## 9. Presentación y portales

- **Página de inicio configurable**: tarjetas, enlaces fijados por el administrador y fondo propio.
- **Apps institucionales** en el catálogo con iconos, permisos y agrupación por categorías (ya
  existe el catálogo; faltan etiquetas y orden manual).
- **Multilingüe**: claves de traducción en los textos de la interfaz (ahora mismo, español).
- **Modo oscuro** y paleta de marca por instalación.

## 10. Escalado

- **Varios nodos**: SQLite pasa a Postgres si la carga lo exige; el código de acceso a datos ya está
  concentrado en `server/src/core/db.ts`.
- **Almacenamiento distribuido**: R2/S3 o MinIO para ficheros grandes detrás del módulo *Archivos*.
- **Federación de identidad** entre varias instalaciones RedLBA (OIDC entre dominios).

---

## Criterios para aceptar una integración

1. **Funciona sin internet**: todo debe poder instalarse desde los repositorios del propio sistema.
2. **Un solo login**: se conecta por OIDC o `forward_auth`, nunca con una cuenta aparte.
3. **Se puede apagar**: vive en un módulo que se activa y desactiva desde el panel.
4. **Coste de mantenimiento bajo**: si obliga a mantener un proyecto externo grande, se documenta
   antes de meterlo.

Ver también el [roadmap](09-roadmap.md) para el estado actual del producto.
