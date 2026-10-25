# 04 · Permisos y roles

## 1. Modelo

```
usuario ──┬── rol directo ─────────────┐
          │                            ├── permisos (conjunto final)
          └── grupo LDAP ── rol ───────┘
```

- **Permisos**: cadenas `recurso.acción` (`users.write`, `modules.manage`). Son la única unidad que
  comprueba el código.
- **Roles**: agrupaciones con nombre de permisos. Hay roles de sistema (no borrables) y roles propios.
- **Asignaciones**: un rol se asigna a un usuario o a un grupo del directorio. Los grupos son la vía
  recomendada porque se gestionan desde LDAP.
- Los permisos efectivos se recalculan en cada login y en `POST /api/auth/refresh`.

## 2. Permisos disponibles

| Permiso | Permite |
|---|---|
| `admin.access` | Entrar al panel de administración (condición previa a los siguientes). |
| `users.read` | Ver el directorio y los perfiles. |
| `users.write` | Crear, editar, desactivar personas. |
| `users.delete` | Borrar personas (además de desactivarlas). |
| `users.password` | Restablecer contraseñas ajenas. |
| `groups.read` / `groups.write` | Ver / gestionar grupos y sus miembros. |
| `roles.read` / `roles.write` | Ver / editar roles y asignaciones. |
| `modules.read` / `modules.manage` | Ver / activar módulos, dominios y ajustes. |
| `apps.read` / `apps.manage` | Ver / editar el catálogo de aplicaciones. |
| `mail.read` / `mail.manage` | Ver / crear buzones, alias y cuotas. |
| `audit.read` | Consultar la auditoría. |
| `settings.read` / `settings.write` | Ver / cambiar ajustes globales y LDAP. |
| `search.use` | Usar el buscador. |
| `notices.write` | Publicar, editar y borrar avisos en el tablón. |
| `files.manage` | Borrar ficheros del área compartida (las carpetas personales solo su dueño). |

Convención: `recurso.read` implica poder leer; `recurso.write` incluye lo de `.read` en la práctica
(el chequeo lo hace cada ruta, pero los roles base ya lo respetan).

## 3. Roles de sistema

| Rol | Permisos | Para quién |
|---|---|---|
| `owner` | Todos | Propietario del servidor. No se puede eliminar. |
| `admin` | Todos menos `settings.write` y borrar el `owner` | Administradores diarios. |
| `helpdesk` | `admin.access`, `users.read`, `users.write`, `users.password`, `mail.read`, `mail.manage`, `audit.read` | Soporte: resetea contraseñas y crea buzones, no toca permisos. |
| `user` | `users.read`, `apps.read`, `search.use` | Cuenta estándar. |
| `guest` | `apps.read` | Acceso mínimo (invitados). |

La matriz completa se consulta en el panel (**Roles → Matriz**) y se exporta en
`GET /api/admin/roles/matrix`.

## 4. Mapeo LDAP → roles

En **Roles → Grupos vinculados** se asocia un grupo del directorio a un rol:

| Grupo LDAP | Rol |
|---|---|
| `redlba-admins` | `admin` |
| `redlba-soporte` | `helpdesk` |
| `redlba-usuarios` | `user` |

- El mapeo se aplica en cada login; si alguien sale del grupo, pierde el rol en su siguiente sesión
  (o de inmediato si un administrador fuerza `POST /api/admin/users/:id/refresh`).
- Un usuario puede tener un rol directo además de los heredados: se suman permisos.
- Si un grupo mapeado no existe en LDAP, la vinculación queda inactiva pero no se borra.

## 5. Comprobación en el código

```ts
app.get("/api/admin/users", { preHandler: [requireAuth, requirePermission("users.read")] }, handler);
```

- `requireAuth`: sesión válida, usuario activo, no bloqueado.
- `requirePermission(p)` (o `requireAny(ps...)`): intersección con los permisos efectivos.
- Los módulos declaran las rutas con los mismos guards; no hay chequeos ad hoc.
- Un 403 devuelve `{ error: "forbidden", required: "users.write" }` y queda en auditoría si es una
  mutación.

## 6. Reglas de protección

1. Nadie puede quitarse a sí mismo el rol `owner` (evita dejar el servidor sin dueño).
2. El último usuario activo con `roles.write` no puede ser desactivado ni degradado.
3. Las contraseñas nunca se devuelven por API; el restablecimiento genera un evento de auditoría sin
   registrar el valor.
4. Las sesiones de un usuario desactivado se revocan inmediatamente.
5. El admin local de emergencia (`ADMIN_USER`) siempre conserva `owner`, aunque el directorio esté
   caído; sirve para recuperar el control.

## 7. Visibilidad de perfiles

Cada usuario elige qué muestra su ficha (`profile_visibility`: `public` | `organization` | `private`):

- `public`: nombre, cargo y correo visibles para cualquier cuenta.
- `organization` (por defecto): añade departamento, teléfono y grupos.
- `private`: solo nombre y correo; el resto únicamente para administradores.

Los campos internos (DN, notas, estado) solo los ve quien tenga `users.write`.
