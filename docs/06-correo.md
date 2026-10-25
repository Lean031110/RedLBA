# 06 · Correo y buzones

RedLBA **no es un servidor de correo**: aprovisiona cuentas y las deja listas para el MTA que ya
tengas (Postfix + Dovecot con LDAP) o para Mailcow vía API. Así no reimplementas SMTP, IMAP, DKIM,
antispam ni entregas.

## 1. Qué hace el módulo `mail`

- Crear un buzón para un usuario (`usuario@redlba.tld`) añadiendo `mail` en su entrada LDAP.
- Fijar cuota (`mailQuota`) y estado (`mailEnabled`).
- Crear y borrar alias (`postalAddress` / tabla de alias del MTA, o API de Mailcow).
- Mostrar el estado del buzón en el perfil y en el panel.
- Devolver los datos de conexión IMAP/SMTP al usuario (host, puerto, TLS) según `settings`.

## 2. Drivers

| Driver | Requiere | Escribe en |
|---|---|---|
| `ldap` (por defecto) | Postfix/Dovecot configurados contra LDAP | atributos `mail`, `mailQuota`, `mailEnabled` |
| `mailcow` | `MAILCOW_URL` + `MAILCOW_API_KEY` | API REST de Mailcow (mailbox + alias) |
| `none` | — | solo registro interno (inventario) |

La interfaz común está en `server/src/core/mail.ts`:

```ts
provisionMailbox(user, address, quotaMb): Promise<MailboxInfo>
updateMailbox(address, { quotaMb?, status? }): Promise<void>
deleteMailbox(address): Promise<void>
createAlias(address, targets): Promise<void>
```

El driver se elige con `MAIL_DRIVER`. Para añadir otro (Mailu, iRedMail, Zimbra), implementa esas
cuatro funciones en `core/mail.ts` y añade el valor al tipo de configuración.

## 3. Postfix + Dovecot con LDAP

Ejemplo mínimo de `dovecot-ldap.conf.ext`:

```
uris = ldap://openldap:389
dn = cn=redlba,dc=redlba,dc=local
dnpass = <contraseña>
base = ou=people,dc=redlba,dc=local
user_filter = (&(objectClass=inetOrgPerson)(mail=%u))
pass_filter = (&(objectClass=inetOrgPerson)(mail=%u))
pass_attrs = mail=user,userPassword=password
user_attrs = mail=user,mailQuota=quota_rule=*:storage=%$M
default_pass_scheme = SSHA
```

`postfix-ldap.cf` para dominios y buzones:

```
server_host = openldap
search_base = ou=people,dc=redlba,dc=local
query_filter = (&(mail=%s)(mailEnabled=TRUE))
result_attribute = mail
```

Con eso, un buzón creado desde RedLBA funciona en segundos (Dovecot no cachea el árbol).

## 4. DNS y entregabilidad (recordatorio)

No lo gestiona RedLBA, pero sin esto el correo no llega:

```
A     mail.redlba.tld        203.0.113.10
MX    redlba.tld             mail.redlba.tld (10)
TXT   redlba.tld             "v=spf1 mx -all"
TXT   _dmarc.redlba.tld      "v=DMARC1; p=quarantine; rua=mailto:postmaster@redlba.tld"
TXT   <selector>._domainkey  (DKIM generado por tu MTA)
PTR   203.0.113.10           mail.redlba.tld
```

Abre 25/tcp (salida y entrada), 587/tcp (submission) y 993/tcp (IMAPS). El 25 lo bloquean muchos
proveedores de VPS: compruébalo antes de prometer correo.

## 5. Cuotas y límites

- Cuota por defecto: `MAIL_DEFAULT_QUOTA_MB` (5 GB). El administrador la ajusta por usuario.
- Límite de buzones: `settings.mail.maxMailboxes` (0 = ilimitado dentro de las cuotas del disco).
- Al superar la cuota, Dovecot aplica su propia política; RedLBA solo muestra el dato.

## 6. Flujo en el panel

```
Administración → Correo → Nuevo buzón
  usuario: ana            (autocompletar desde LDAP)
  dirección: ana@redlba.tld
  cuota: 5120 MB
  → POST /api/m/mail/mailboxes
     ├─ comprueba permiso mail.manage
     ├─ driver.provision()
     ├─ guarda estado en SQLite (mailboxes)
     └─ audita "mailbox.create"
```

El usuario ve en su perfil: dirección, cuota usada (si el driver la reporta), estado y botón
*Cambiar contraseña*, que afecta a LDAP y por tanto a IMAP/SMTP/portal a la vez.

## 7. Alias y listas

- Alias simple: `ventas@redlba.tld → ana, luis` (driver `ldap` usa `mailAlternativeAddress`, o la
  tabla `virtual_alias_maps` del MTA; el panel muestra ambas opciones).
- Listas de distribución: se modelan como grupo LDAP con `mail` propio; el módulo las lista y
  permite añadir miembros reutilizando la gestión de grupos.

## 8. Migración desde otro servidor

1. Crea los buzones en RedLBA (o importa el listado con `POST /api/m/mail/import`).
2. Copia el correo con `imapsync` o `doveadm sync` usando la misma contraseña LDAP.
3. Cambia el MX cuando el nuevo MTA esté validado.
No hay migración automática de buzones dentro de RedLBA: es responsabilidad del MTA.
