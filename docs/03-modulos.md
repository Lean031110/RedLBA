# 03 · Módulos y dominios propios

## 1. Concepto

Todo lo que no sea el núcleo (identidad, sesiones, panel) es un **módulo**. Un módulo se puede
activar o desactivar sin tocar código ni reiniciar el contenedor, y puede publicarse en un dominio
distinto al del portal. El buscador es el ejemplo canónico: `buscar.redlba.tld` en vez de
`portal.redlba.tld/buscar`.

## 2. Módulos incluidos

| Clave | Nombre | Por defecto | Dominio sugerido | Qué hace |
|---|---|---|---|---|
| `directory` | Directorio | activo | `gente.` | Listado y perfiles de personas del servidor. |
| `search` | Buscador | activo | `buscar.` | Búsqueda unificada (personas, apps, módulos). |
| `apps` | Aplicaciones | activo | — | Catálogo de los sitios del servidor en el portal. |
| `mail` | Correo | inactivo | `correo.` | Buzones, alias, cuotas y **webmail integrado** (IMAP/SMTP). |
| `audit` | Auditoría | activo (admin) | — | Registro de acciones y accesos. |
| `notices` | Tablón | activo | — | Avisos y comunicados de la intranet, sin internet. |
| `files` | Archivos | activo | `nube.` | Carpetas personales y compartidas con subida, descarga y cuota. |

Los módulos marcados `adminOnly` solo aparecen en el panel de administración.

## 3. Estado y configuración

Cada módulo tiene una fila en la tabla `modules`:

```json
{
  "key": "search",
  "name": "Buscador",
  "enabled": true,
  "hostname": "buscar.redlba.tld",
  "path": "/buscar",
  "icon": "search",
  "sort": 20,
  "settings": { "providers": ["directory", "apps", "modules"], "minChars": 2 }
}
```

- `enabled=false` ⇒ no se sirve su API (404), no aparece en el menú y no aporta resultados.
- `hostname` vacío ⇒ se sirve bajo el portal en `path`.
- `hostname` con valor ⇒ en ese host la SPA abre el módulo directamente y la API acepta ese origen.
- `settings` es libre: cada módulo define sus claves y las valida con Zod.

El panel (**Administración → Módulos**) expone: interruptor, nombre visible, dominio, ruta, orden,
icono y un editor JSON de `settings` con validación.

## 4. Cómo se resuelve el módulo de una petición

```
Host: buscar.redlba.tld
  → ¿algún módulo habilitado tiene ese hostname?  → search
  → /api/bootstrap devuelve { currentModule: "search", modules: [...] }
  → la SPA pinta la vista del buscador a pantalla completa
```

```
Host: portal.redlba.tld  (o desconocido)
  → currentModule = "portal"
  → dashboard con buscador embebido (si el módulo está activo), apps y accesos rápidos
```

Los enlaces del menú se generan en el backend (`moduleUrl()`), así que si mañana cambias
`buscar.redlba.tld` por `buscador.redlba.tld` solo actualizas una fila.

## 5. Ciclo de vida de una petición a un módulo

```
GET /api/m/search/query?q=ana
  1. sesión válida               (auth)
  2. módulo habilitado           (module guard)
  3. permiso search.use          (rbac)
  4. handler del módulo
  5. auditoría si es mutación
```

Las tres primeras capas son comunes: ningún módulo implementa seguridad por su cuenta.

## 6. Crear un módulo nuevo

1. Crea `server/src/modules/mi-modulo/index.ts`:

```ts
import type { RedlbaModule } from "../../core/module-registry.js";

export const miModulo: RedlbaModule = {
  key: "mi-modulo",
  name: "Mi módulo",
  description: "Qué hace, en una línea",
  icon: "puzzle",
  defaultPath: "/mi-modulo",
  register(app, ctx) {
    app.get("/api/m/mi-modulo/ping", async () => ({ pong: true }));
  },
  async search(_ctx, q) {
    return [{ id: "x", title: `Resultado para ${q}`, module: "mi-modulo" }];
  },
};
```

2. Regístralo en `server/src/modules/index.ts`.
3. Crea su fila con `npm run module:add mi-modulo` (o desde el panel, *Módulos → Sincronizar*).
4. Añade la vista en `web/src/views/` y engánchala en el router por `currentModule`.

No hace falta tocar autenticación, permisos, auditoría ni configuración de dominios: lo hereda.

## 7. Módulo de ejemplo: el buscador

```
Proveedor        Aporta
directory        Personas (nombre, correo, cargo, departamento) — respeta visibilidad del perfil
apps             Aplicaciones del catálogo, filtradas por permisos del usuario
modules          Módulos activos accesibles ("ir a Correo")
```

- Query mínimo: `settings.minChars` (2 por defecto). Máximo 10 resultados por proveedor.
- Búsqueda `case`/`accent-insensitive` en SQLite mediante `LIKE` sobre columnas normalizadas
  (`search_text`), sin dependencias externas.
- Cada resultado incluye `module`, `href` y `badge` para que la UI lo pinte igual sea cual sea el
  proveedor.
- Proveedor `files` implementado: recorre el almacenamiento local (`FILES_DIR`) de tu carpeta y de
  `shared/`, y no escala a `..` ni a carpetas de otras personas.

## 8. Dominios: reglas prácticas

- Un módulo por dominio. No se comparten hostnames entre módulos (el panel lo valida).
- El hostname debe pertenecer a `REDLBA_DOMAIN` o a un dominio declarado en `ALLOWED_MODULE_DOMAINS`
  (separados por coma). Así se evita servir el portal en dominios ajenos por error.
- Caddy: con la ruta comodín `*.{$REDLBA_DOMAIN}` no hay que reiniciar nada al añadir un módulo. Si
  usas dominios externos, añádelos al Caddyfile o pide el snippet en el panel.
- Cookies: al estar en el dominio padre, la sesión funciona igual en todos los subdominios.
