# 05 · Integración con LDAP

## 1. Modelo de directorio asumido

Compatible con OpenLDAP 2.6 usando esquemas estándar (`inetOrgPerson`, `posixAccount`, `shadowAccount`):

```
dc=redlba,dc=local
├── ou=people
│   ├── uid=ana          (inetOrgPerson, posixAccount, shadowAccount)
│   └── uid=luis
└── ou=groups
    ├── cn=redlba-admins (groupOfNames, gidNumber)
    └── cn=redlba-usuarios
```

Atributos usados:

| Atributo | Uso en RedLBA |
|---|---|
| `uid` | Nombre de usuario (login). |
| `cn` | Nombre visible. |
| `sn`, `givenName` | Apellidos y nombre. |
| `mail` | Correo principal; **también** es el buzón de Postfix/Dovecot. |
| `title`, `ou`, `telephoneNumber` | Cargo, departamento, teléfono (perfil). |
| `uidNumber`, `gidNumber`, `homeDirectory` | Cuenta POSIX. |
| `userPassword` | Contraseña (SSHA por defecto). |
| `mailQuota` (opcional) | Cuota de buzón en MB si usas el esquema de correo. |
| `member` / `memberOf` | Pertenencia a grupos. |

Puedes adaptarlo a Active Directory con `LDAP_USER_ATTR=sAMAccountName` y ajustando los DN en
`server/src/core/ldap.ts` (`userDn`, `groupDn`).

## 2. Cuenta de servicio

```ldif
dn: cn=redlba,dc=redlba,dc=local
objectClass: simpleSecurityObject
objectClass: organizationalRole
cn: redlba
description: Cuenta de servicio de RedLBA
userPassword: {SSHA}...
```

Necesita:
- lectura de `ou=people,ou=groups`;
- escritura en `ou=people` (alta, `mail`, `userPassword`, atributos de perfil);
- escritura en `ou=groups` (miembros).

Crea el rol ACL en `slapd.conf`/`cn=config`, no reutilices `cn=admin`.

## 3. Flujo de login

```
uid=ana,ou=people,dc=redlba,dc=local
        │  bind con la contraseña introducida
        ▼
  OK → leer atributos + grupos (memberOf o búsqueda inversa de member)
     → upsert en SQLite (caché para listados, búsqueda y auditoría)
     → resolver roles (directos + grupos mapeados)
     → sesión
  Error 49 (invalidCredentials) → mensaje genérico "Credenciales incorrectas"
```

- Si LDAP responde pero el usuario no existe en la caché, se crea en el acto (JIT).
- Si el usuario está desactivado en RedLBA (`status=disabled`), el login se rechaza aunque las
  credenciales sean válidas — así se puede suspender a alguien sin tocar el directorio.
- En `AUTH_MODE=hybrid`, si LDAP está caído se permite el admin local de emergencia y se registra una
  alerta en auditoría. El resto de usuarios no puede entrar (fail-closed).

## 4. Alta de usuarios desde el panel

`POST /api/admin/users` con `source=ldap`:

1. Calcula `uidNumber`/`gidNumber` libres (máximo actual + 1).
2. Crea el DN `uid=<user>,ou=people,<base>` con:
   `objectClass: inetOrgPerson, posixAccount, shadowAccount, organizationalPerson`
3. Genera `userPassword` SSHA (o deja que el usuario la cambie en el primer acceso).
4. Añade `mail` si el módulo de correo está activo.
5. Añade el DN a los grupos indicados.
6. Refleja el usuario en SQLite y audita el alta.

La contraseña se envía una sola vez en la respuesta de creación (`tempPassword`) para que el
administrador la entregue; no se guarda en claro ni se registra en auditoría.

## 5. Contraseñas

- **Alta/restablecimiento**: se escribe `userPassword` con `{SSHA}` calculado en `core/ldap.ts`
  (`sha1(password + salt) + salt`, en base64). Compatible con OpenLDAP sin módulos extra.
- **Cambio por el propio usuario**: `POST /api/auth/password` verifica primero el bind con la
  contraseña actual y luego escribe la nueva.
- Alternativa soportada: extended operation *Password Modify* (RFC 3062) si tu directorio lo exige
  (`LDAP_PASSWORD_MODIFY=true`).
- Política mínima aplicada en servidor: 10 caracteres, sin el nombre de usuario dentro y fuera de
  una lista de contraseñas comunes (`core/passwords.ts`).

## 6. Sincronización

```bash
npm run ldap:sync            # importa/actualiza usuarios y grupos
npm run ldap:sync -- --dry   # muestra qué cambiaría, sin escribir
```

- Se ejecuta al arrancar, en cada login y por cron (`*/15 * * * *` en el contenedor).
- Nunca borra en LDAP: si un usuario desaparece del directorio, se marca `status=orphaned` en la
  caché y se revocan sus sesiones. Decide en el panel si lo eliminas.
- Los cambios hechos en LDAP mandan: la caché solo se escribe para reflejarlos (excepto el estado
  `disabled`, que es decisión de RedLBA).

## 7. Probar la conexión

```bash
npm run ldap:check
# URL: ldap://openldap:389
# bind: OK (cn=redlba,...)
# base: dc=redlba,dc=local (2 OU, 14 usuarios, 5 grupos)
# grupos mapeados: redlba-admins → admin, redlba-usuarios → user
```

Desde el panel: **Ajustes → LDAP → Probar conexión** ejecuta lo mismo y muestra latencia.

## 8. Active Directory (notas)

- `LDAP_USER_ATTR=sAMAccountName`, `LDAP_BIND_DN=CN=svc-redlba,OU=Servicios,DC=empresa,DC=com`.
- El bind de usuario requiere `usuario@dominio` o `DOMINIO\usuario`: configura `LDAP_UPN_SUFFIX`.
- `memberOf` es la vía fiable para grupos; activa `LDAP_USE_MEMBEROF=true`.
- Para escribir contraseñas en AD hace falta LDAPS y el permiso *Replicating Directory Changes*; si
  no lo tienes, deja el cambio de contraseña delegado en AD y oculta la acción en el perfil.
