import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../core/db.js';

const backupDir = path.join(path.dirname(config.dbPath), 'backups');
mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(backupDir, `redlba-${stamp}.db`);

db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

const size = statSync(target).size;
console.log(`Copia creada: ${target} (${(size / 1024).toFixed(1)} KB)`);
console.log('Guarda también el .env y el LDIF del directorio (slapcat).');
