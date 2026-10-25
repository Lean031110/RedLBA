import { config } from '../config.js';
import { attachAuth } from '../core/auth.js';
import { record } from '../core/audit.js';
import { all, get, run, type UserRow } from '../core/db.js';
import { findUserById } from '../core/identity.js';
import { createAlias, deleteMailbox, provisionMailbox, updateMailbox } from '../core/mail.js';
import { hasPermission } from '../core/rbac.js';
import { integer, isEmail, newId, nowIso, text, truthy } from '../core/util.js';
import type { RedlbaModule } from '../core/module-registry.js';
import { registerWebmailRoutes } from './webmail.js';

interface MailboxRow {
  id: string;
  user_id: string | null;
  address: string;
  quota_mb: number;
  status: 'active' | 'suspended';
  driver: string;
  created_at: string;
  updated_at: string;
  username?: string | null;
  display_name?: string | null;
}

function listMailboxes(query = ''): MailboxRow[] {
  const like = `%${query}%`;
  return all<MailboxRow>(
    `SELECT m.*, u.username, u.display_name FROM mailboxes m
       LEFT JOIN users u ON u.id = m.user_id
      ${query ? 'WHERE m.address LIKE ? OR u.display_name LIKE ?' : ''}
      ORDER BY m.address ASC`,
    ...(query ? [like, like] : []),
  );
}

export const mailModule: RedlbaModule = {
  key: 'mail',
  name: 'Correo',
  description: 'Buzones, alias y cuotas de las cuentas del servidor.',
  icon: 'mail',
  defaultPath: '/mail',

  register(app, runtime) {
    registerWebmailRoutes(app);

    app.get<{ Querystring: { q?: string } }>('/mailboxes', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      if (!hasPermission(auth.access, 'mail.read')) {
        return reply.code(403).send({ error: 'forbidden', required: 'mail.read' });
      }
      return {
        driver: (await import('../core/mail.js')).mailDriver(),
        domain: config.mail.domain,
        defaults: { quotaMb: config.mail.defaultQuotaMb },
        mailboxes: listMailboxes(req.query.q?.trim() ?? ''),
      };
    });

    app.post('/mailboxes', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      if (!hasPermission(auth.access, 'mail.manage')) {
        return reply.code(403).send({ error: 'forbidden', required: 'mail.manage' });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const user = findUserById(text(body.userId, 60) ?? '');
      if (!user) return reply.code(400).send({ error: 'invalid', message: 'Usuario no válido.' });

      const address = (text(body.address, 160) ?? `${user.username}@${config.mail.domain}`).toLowerCase();
      if (!isEmail(address)) {
        return reply.code(400).send({ error: 'invalid', message: 'Dirección de correo no válida.' });
      }
      const existing = get<{ id: string }>('SELECT id FROM mailboxes WHERE address = ?', address);
      if (existing) {
        return reply.code(409).send({ error: 'conflict', message: 'Ese buzón ya existe.' });
      }

      const quotaMb = Math.min(Math.max(integer(body.quotaMb, config.mail.defaultQuotaMb), 256), 1024 * 1024);
      const maxMailboxes = Number(runtime.settings.maxMailboxes ?? 0);
      if (maxMailboxes > 0) {
        const count = get<{ count: number }>('SELECT COUNT(*) AS count FROM mailboxes WHERE user_id = ?', user.id);
        if ((count?.count ?? 0) >= maxMailboxes) {
          return reply
            .code(409)
            .send({ error: 'limit', message: `Límite de ${maxMailboxes} buzón(es) por usuario.` });
        }
      }

      const result = await provisionMailbox(user, address, quotaMb);
      const id = newId();
      run(
        `INSERT INTO mailboxes (id, user_id, address, quota_mb, status, driver, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
        id,
        user.id,
        address,
        quotaMb,
        result.driver,
        nowIso(),
        nowIso(),
      );

      record({
        actor: auth.user,
        action: 'mailbox.create',
        target: address,
        detail: { driver: result.driver, warnings: result.warnings },
        ip: req.ip,
      });

      return {
        mailbox: listMailboxes(address).find((row) => row.address === address),
        password: result.password,
        warnings: result.warnings,
      };
    });

    app.patch<{ Params: { address: string } }>('/mailboxes/:address', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      if (!hasPermission(auth.access, 'mail.manage')) {
        return reply.code(403).send({ error: 'forbidden', required: 'mail.manage' });
      }

      const address = req.params.address.toLowerCase();
      const existing = get<MailboxRow>('SELECT * FROM mailboxes WHERE address = ?', address);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      const body = (req.body ?? {}) as Record<string, unknown>;
      const quotaMb =
        body.quotaMb === undefined ? existing.quota_mb : Math.min(Math.max(integer(body.quotaMb, existing.quota_mb), 256), 1024 * 1024);
      const status =
        body.status === 'suspended' || body.status === 'active'
          ? (body.status as 'active' | 'suspended')
          : existing.status;

      await updateMailbox(address, { quotaMb, status });
      run(
        'UPDATE mailboxes SET quota_mb = ?, status = ?, updated_at = ? WHERE address = ?',
        quotaMb,
        status,
        nowIso(),
        address,
      );
      record({ actor: auth.user, action: 'mailbox.update', target: address, detail: { quotaMb, status }, ip: req.ip });

      return { mailbox: listMailboxes(address).find((row) => row.address === address) };
    });

    app.delete<{ Params: { address: string } }>('/mailboxes/:address', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      if (!hasPermission(auth.access, 'mail.manage')) {
        return reply.code(403).send({ error: 'forbidden', required: 'mail.manage' });
      }
      const address = req.params.address.toLowerCase();
      const existing = get<MailboxRow>('SELECT * FROM mailboxes WHERE address = ?', address);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      await deleteMailbox(address);
      run('DELETE FROM mailboxes WHERE address = ?', address);
      record({ actor: auth.user, action: 'mailbox.delete', target: address, ip: req.ip });
      return { ok: true };
    });

    app.get('/aliases', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      if (!hasPermission(auth.access, 'mail.read')) return reply.code(403).send({ error: 'forbidden' });
      return {
        aliases: all('SELECT * FROM mail_aliases ORDER BY address ASC').map((row) => {
          const alias = row as { id: string; address: string; targets: string; created_at: string };
          return { ...alias, targets: JSON.parse(alias.targets) as string[] };
        }),
        enabled: config.mail.aliasesEnabled,
      };
    });

    app.post('/aliases', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      if (!hasPermission(auth.access, 'mail.manage')) {
        return reply.code(403).send({ error: 'forbidden', required: 'mail.manage' });
      }
      if (!config.mail.aliasesEnabled) {
        return reply.code(400).send({ error: 'disabled', message: 'Los alias están desactivados.' });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const address = (text(body.address, 160) ?? '').toLowerCase();
      const targets = Array.isArray(body.targets)
        ? body.targets.filter((item): item is string => typeof item === 'string' && isEmail(item))
        : [];
      if (!isEmail(address) || targets.length === 0) {
        return reply.code(400).send({ error: 'invalid', message: 'Dirección y al menos un destino válidos.' });
      }
      if (get('SELECT id FROM mail_aliases WHERE address = ?', address)) {
        return reply.code(409).send({ error: 'conflict', message: 'Ese alias ya existe.' });
      }

      await createAlias(address, targets);
      run(
        'INSERT INTO mail_aliases (id, address, targets, created_at) VALUES (?, ?, ?, ?)',
        newId(),
        address,
        JSON.stringify(targets),
        nowIso(),
      );
      record({ actor: auth.user, action: 'alias.create', target: address, detail: { targets }, ip: req.ip });
      return { ok: true };
    });

    app.delete<{ Params: { id: string } }>('/aliases/:id', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      if (!hasPermission(auth.access, 'mail.manage')) {
        return reply.code(403).send({ error: 'forbidden', required: 'mail.manage' });
      }
      run('DELETE FROM mail_aliases WHERE id = ?', req.params.id);
      record({ actor: auth.user, action: 'alias.delete', target: req.params.id, ip: req.ip });
      return { ok: true };
    });

    app.get('/status', async (req, reply) => {
      const auth = attachAuth(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });

      // Cada usuario ve únicamente su propio buzón: no requiere mail.read.
      const mine = all<MailboxRow>(
        'SELECT * FROM mailboxes WHERE user_id = ? ORDER BY address',
        auth.user.id,
      );
      const settings = runtime.settings as {
        webmailUrl?: string;
        imapHost?: string;
        smtpHost?: string;
      };

      return {
        mailboxes: mine,
        driver: config.mail.driver,
        settings: {
          webmailUrl: settings.webmailUrl ?? '',
          imapHost: settings.imapHost ?? `mail.${config.mail.domain}`,
          smtpHost: settings.smtpHost ?? `mail.${config.mail.domain}`,
          domain: config.mail.domain,
        },
      };
    });
  },
};

export function mailboxCount(): number {
  return get<{ count: number }>('SELECT COUNT(*) AS count FROM mailboxes')?.count ?? 0;
}

export function userMailboxes(user: UserRow) {
  return all('SELECT * FROM mailboxes WHERE user_id = ? ORDER BY address', user.id);
}

export function truthyEnabled(value: unknown): boolean {
  return truthy(value);
}
