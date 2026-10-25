import { config } from '../config.js';
import type { UserRow } from './db.js';
import { updateAttributes } from './ldap.js';
import { generateTempPassword } from './passwords.js';

export interface MailboxInfo {
  address: string;
  quotaMb: number;
  status: 'active' | 'suspended';
  driver: string;
  password?: string;
  warnings: string[];
}

export function mailDriver(): string {
  if (config.mail.driver === 'mailcow' && config.mail.mailcowUrl && config.mail.mailcowApiKey) {
    return 'mailcow';
  }
  if (config.mail.driver === 'mailcow') return 'none';
  return config.mail.driver;
}

async function mailcow(path: string, body: unknown): Promise<{ ok: boolean; message?: string }> {
  try {
    const response = await fetch(`${config.mail.mailcowUrl}/api/v1/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.mail.mailcowApiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json().catch(() => ({}))) as Array<{ type?: string; msg?: string[] }>;
    if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
    const first = Array.isArray(data) ? data[0] : undefined;
    return {
      ok: first?.type !== 'error',
      message: first?.msg?.join(' '),
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function provisionMailbox(
  user: UserRow,
  address: string,
  quotaMb: number,
): Promise<MailboxInfo> {
  const driver = mailDriver();
  const warnings: string[] = [];
  const result: MailboxInfo = { address, quotaMb, status: 'active', driver, warnings };

  if (driver === 'ldap') {
    if (!user.ldap_dn) {
      warnings.push('El usuario no existe en LDAP: el buzón queda registrado pero no se aprovisionó.');
      return result;
    }
    await updateAttributes(user.ldap_dn, { mail: address });
    return result;
  }

  if (driver === 'mailcow') {
    const [localPart, domain] = address.split('@');
    const password = generateTempPassword();
    const response = await mailcow('add/mailbox', {
      local_part: localPart,
      domain: domain ?? config.mail.domain,
      name: user.display_name,
      quota: String(quotaMb),
      password,
      password2: password,
      active: '1',
      force_pw_update: '0',
    });
    if (!response.ok) {
      throw Object.assign(new Error(response.message ?? 'Mailcow rechazó la creación del buzón.'), {
        statusCode: 502,
      });
    }
    result.password = password;
    return result;
  }

  warnings.push('El driver de correo está desactivado: solo se registró el buzón en RedLBA.');
  return result;
}

export async function updateMailbox(
  address: string,
  patch: { quotaMb?: number; status?: 'active' | 'suspended' },
): Promise<void> {
  const driver = mailDriver();
  if (driver !== 'mailcow') return;

  const [localPart, domain] = address.split('@');
  const body: Record<string, unknown> = {
    items: [address],
  };
  if (patch.quotaMb !== undefined) body.quota = String(patch.quotaMb);
  if (patch.status) body.active = patch.status === 'active' ? '1' : '0';

  const response = await mailcow('edit/mailbox', {
    ...body,
    local_part: localPart,
    domain: domain ?? config.mail.domain,
  });
  if (!response.ok) {
    throw Object.assign(new Error(response.message ?? 'Mailcow rechazó la actualización.'), {
      statusCode: 502,
    });
  }
}

export async function deleteMailbox(address: string): Promise<void> {
  const driver = mailDriver();
  if (driver !== 'mailcow') return;
  const response = await mailcow('delete/mailbox', [address]);
  if (!response.ok) {
    throw Object.assign(new Error(response.message ?? 'Mailcow rechazó la baja.'), {
      statusCode: 502,
    });
  }
}

export async function createAlias(address: string, targets: string[]): Promise<void> {
  const driver = mailDriver();
  if (driver !== 'mailcow') return;
  const [localPart, domain] = address.split('@');
  const response = await mailcow('add/alias', {
    address,
    goto: targets.join(','),
    active: '1',
    domain: domain ?? config.mail.domain,
    local_part: localPart,
  });
  if (!response.ok) {
    throw Object.assign(new Error(response.message ?? 'Mailcow rechazó el alias.'), {
      statusCode: 502,
    });
  }
}
