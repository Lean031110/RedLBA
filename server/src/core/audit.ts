import { config } from '../config.js';
import { all, get, run, type UserRow } from './db.js';
import { nowIso } from './util.js';

export interface AuditInput {
  actor?: Pick<UserRow, 'id' | 'username'> | null;
  action: string;
  target?: string | null;
  result?: 'ok' | 'fail';
  detail?: unknown;
  ip?: string | null;
}

export function record(input: AuditInput): void {
  try {
    run(
      `INSERT INTO audit_events (at, actor_id, actor_username, action, target, result, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      nowIso(),
      input.actor?.id ?? null,
      input.actor?.username ?? null,
      input.action,
      input.target ?? null,
      input.result ?? 'ok',
      input.detail === undefined ? null : JSON.stringify(input.detail).slice(0, 4000),
      input.ip ?? null,
    );
  } catch (error) {
    console.error('[audit] no se pudo registrar el evento', error);
  }
}

export interface AuditQuery {
  q?: string;
  actor?: string;
  action?: string;
  result?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function queryEvents(query: AuditQuery): { total: number; events: unknown[] } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (query.q) {
    clauses.push('(action LIKE ? OR target LIKE ? OR actor_username LIKE ? OR detail LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like, like);
  }
  if (query.actor) {
    clauses.push('actor_username = ?');
    params.push(query.actor);
  }
  if (query.action) {
    clauses.push('action LIKE ?');
    params.push(`${query.action}%`);
  }
  if (query.result) {
    clauses.push('result = ?');
    params.push(query.result);
  }
  if (query.from) {
    clauses.push('at >= ?');
    params.push(query.from);
  }
  if (query.to) {
    clauses.push('at <= ?');
    params.push(query.to);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);

  const total = get<{ count: number }>(`SELECT COUNT(*) AS count FROM audit_events ${where}`, ...params);
  const events = all(
    `SELECT * FROM audit_events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );

  return { total: total?.count ?? 0, events };
}

/** Elimina eventos antiguos según AUDIT_RETENTION_DAYS. */
export function pruneEvents(): number {
  const cutoff = new Date(Date.now() - config.auditRetentionDays * 86400_000).toISOString();
  const result = run('DELETE FROM audit_events WHERE at < ?', cutoff);
  return result.changes;
}
