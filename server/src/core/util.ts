import { randomBytes, randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('hex');
export const nowIso = (): string => new Date().toISOString();

/** Normaliza para búsquedas: minúsculas, sin acentos ni espacios sobrantes. */
export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function text(value: unknown, maxLength = 300): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

export function integer(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (match) => `!${match}`);
}

export function csvCell(value: unknown): string {
  const stringValue = value === null || value === undefined ? '' : String(value);
  return `"${stringValue.replace(/"/g, '""')}"`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** Escapa valores para filtros LDAP (RFC 4515). */
export function ldapEscape(value: string): string {
  return value.replace(/[\\*()\0]/g, (char) => {
    const code = char.charCodeAt(0).toString(16).padStart(2, '0');
    return `\\${code}`;
  });
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function hostOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.split(',')[0]?.trim().toLowerCase().replace(/:\d+$/, '');
}
