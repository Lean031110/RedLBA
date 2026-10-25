import { config } from '../config.js';
import { healthCheck } from '../core/ldap.js';
import { ensureSeed, stats } from '../core/seed.js';
import { syncDirectory } from '../core/identity.js';
import '../modules/index.js';

console.log('[bootstrap] preparando datos iniciales…');
ensureSeed();

const summary = stats();
console.log(`[bootstrap] roles, módulos y ajustes listos.`);
console.log(
  `[bootstrap] ${summary.users} usuarios · ${summary.groups} grupos · ${summary.modules} módulos activos`,
);

if (config.auth.mode !== 'ldap' && config.auth.adminPassword) {
  console.log(`[bootstrap] cuenta local de administración: ${config.auth.adminUser}`);
}

if (config.ldap.configured) {
  const health = await healthCheck();
  if (health.ok) {
    console.log(`[bootstrap] LDAP accesible (${health.latencyMs} ms). Sincronizando directorio…`);
    try {
      const result = await syncDirectory();
      console.log(
        `[bootstrap] importados ${result.users} usuarios y ${result.groups} grupos (${result.orphaned} huérfanos).`,
      );
    } catch (error) {
      console.warn(`[bootstrap] no se pudo sincronizar: ${(error as Error).message}`);
    }
  } else {
    console.warn(`[bootstrap] LDAP no disponible: ${health.error}`);
    console.warn('[bootstrap] revisa LDAP_URL, LDAP_BIND_DN y LDAP_BIND_PASSWORD.');
  }
} else {
  console.log('[bootstrap] LDAP sin configurar: se usará la autenticación local.');
}

console.log('[bootstrap] listo. Arranca con: npm start');
