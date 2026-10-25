import { registerModule } from '../core/module-registry.js';
import { searchModule } from './search.js';
import { directoryModule } from './directory.js';
import { appsModule } from './apps.js';
import { mailModule } from './mail.js';
import { auditModule } from './audit.js';
import { noticesModule } from './notices.js';
import { filesModule } from './files.js';

const definitions = [
  directoryModule,
  searchModule,
  appsModule,
  mailModule,
  auditModule,
  noticesModule,
  filesModule,
];

for (const definition of definitions) {
  registerModule(definition);
}

export { definitions };
