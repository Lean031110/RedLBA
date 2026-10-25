import { config } from '../config.js';
import { all } from '../core/db.js';
import { healthCheck, fetchDirectory } from '../core/ldap.js';

console.log(`URL:   ${config.ldap.url || '(sin configurar)'}`);
console.log(`Bind:  ${config.ldap.bindDn || '(sin configurar)'}`);
console.log(`Base:  ${config.ldap.baseDn}`);
console.log(`Users: ${config.ldap.usersBase}`);
console.log(`Groups:${config.ldap.groupsBase}`);

if (!config.ldap.configured) {
  console.error('\nFalta LDAP_URL o LDAP_BIND_DN. Revisa el .env.');
  process.exit(1);
}

const health = await healthCheck();
if (!health.ok) {
  console.error(`\n✗ Sin conexión: ${health.error}`);
  process.exit(1);
}
console.log(`\n✓ Bind correcto (${health.latencyMs} ms)`);

try {
  const directory = await fetchDirectory();
  console.log(`✓ ${directory.users.length} usuarios y ${directory.groups.length} grupos en el directorio`);
} catch (error) {
  console.error(`✗ Lectura fallida: ${(error as Error).message}`);
  process.exit(1);
}

const cached = all<{ count: number }>('SELECT COUNT(*) AS count FROM users');
console.log(`· Caché local: ${cached[0]?.count ?? 0} usuarios`);

const mappings = all<{ subject_value: string; key: string }>(
  `SELECT rb.subject_value, r.key FROM role_bindings rb JOIN roles r ON r.id = rb.role_id
    WHERE rb.subject_type = 'group'`,
);
console.log(
  mappings.length
    ? `· Grupos mapeados: ${mappings.map((row) => `${row.subject_value} → ${row.key}`).join(', ')}`
    : '· Sin grupos mapeados a roles (panel → Roles)',
);
