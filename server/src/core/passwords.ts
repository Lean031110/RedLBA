import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/** Hash local: scrypt$N$r$p$saltB64$hashB64 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64!, 'base64');
    const expected = Buffer.from(hashB64!, 'base64');
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Hash compatible con OpenLDAP por defecto: {SSHA} base64(sha1(pass + salt) + salt). */
export function sshaPassword(password: string): string {
  const salt = randomBytes(8);
  const digest = createHash('sha1').update(password).update(salt).digest();
  return `{SSHA}${Buffer.concat([digest, salt]).toString('base64')}`;
}

export function verifySsha(password: string, stored: string): boolean {
  if (!stored.startsWith('{SSHA}')) return false;
  try {
    const raw = Buffer.from(stored.slice(6), 'base64');
    const digest = raw.subarray(0, 20);
    const salt = raw.subarray(20);
    const actual = createHash('sha1').update(password).update(salt).digest();
    return actual.length === digest.length && timingSafeEqual(actual, digest);
  } catch {
    return false;
  }
}

const COMMON_PASSWORDS = new Set([
  '123456', '12345678', '123456789', '1234567890', 'password', 'contrasena', 'contraseña',
  'qwerty', 'qwerty123', 'abc123', 'iloveyou', 'admin', 'admin123', 'administrador',
  'welcome', 'bienvenido', 'monkey', 'dragon', 'letmein', 'football', 'baseball', 'master',
  'sunshine', 'princess', 'login', 'passw0rd', 'p@ssw0rd', 'hola123', 'secreto', 'cambiar',
  'cambiame', 'redlba', 'server', 'servidor', 'usuario', 'usuario123', 'test1234', '111111',
  '000000', '654321', '1q2w3e4r', 'zaq12wsx', 'asdfghjk', 'micontrasena', 'temporal',
]);

export interface PasswordPolicyResult {
  ok: boolean;
  message?: string;
}

export function checkPasswordPolicy(
  password: string,
  username?: string,
  minLength = 10,
): PasswordPolicyResult {
  if (password.length < minLength) {
    return { ok: false, message: `La contraseña debe tener al menos ${minLength} caracteres.` };
  }
  if (password.length > 200) {
    return { ok: false, message: 'La contraseña es demasiado larga.' };
  }
  const lower = password.toLowerCase();
  if (username && lower.includes(username.toLowerCase())) {
    return { ok: false, message: 'La contraseña no puede contener el nombre de usuario.' };
  }
  if (COMMON_PASSWORDS.has(lower)) {
    return { ok: false, message: 'Esa contraseña es demasiado común. Elige otra.' };
  }
  if (/^(.)\1+$/.test(password)) {
    return { ok: false, message: 'La contraseña no puede ser un carácter repetido.' };
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9\W]/.test(password)) {
    return { ok: false, message: 'Combina letras con números o símbolos.' };
  }
  return { ok: true };
}

/** Contraseña temporal legible para entregar a un usuario. */
export function generateTempPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const symbols = '!@#$%&*';
  const bytes = randomBytes(14);
  let out = '';
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length];
  }
  return `${out}${symbols[bytes[0]! % symbols.length]}${(bytes[1]! % 90) + 10}`;
}
