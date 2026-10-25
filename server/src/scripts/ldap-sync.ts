import { config } from '../config.js';
import { syncDirectory } from '../core/identity.js';
import { healthCheck } from '../core/ldap.js';
import '../modules/index.js';

if (!config.ldap.configured) {
  console.error('LDAP no está configurado (LDAP_URL / LDAP_BIND_DN).');
  process.exit(1);
}

const health = await healthCheck();
if (!health.ok) {
  console.error(`No se pudo contactar con LDAP: ${health.error}`);
  process.exit(1);
}

console.log(`LDAP ok (${health.latencyMs} ms). Sincronizando ${config.ldap.usersBase}…`);
try {
  const result = await syncDirectory();
  console.log(
    `Sincronizado: ${result.users} usuarios, ${result.groups} grupos, ${result.orphaned} huérfanos.`,
  );
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exit(1);
}
