export interface User {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  department: string | null;
  phone: string | null;
  bio: string | null;
  avatarUrl: string | null;
  profileVisibility: 'public' | 'organization' | 'private';
  source: 'local' | 'ldap';
  status: 'active' | 'disabled' | 'orphaned';
  roles: string[];
  permissions: string[];
  isAdmin: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  groups?: string[];
}

export interface ModuleInfo {
  key: string;
  name: string;
  description: string | null;
  icon: string;
  path: string;
  url: string;
  hostname: string | null;
  enabled: boolean;
  adminOnly: boolean;
  sort: number;
  settings?: Record<string, unknown>;
  searchable?: boolean;
}

export interface AppInfo {
  id: string;
  name: string;
  url: string;
  description: string | null;
  icon: string;
  color: string | null;
  permission: string | null;
  sort: number;
  enabled: boolean;
}

export interface Site {
  name: string;
  tagline: string;
  domain: string;
  baseUrl: string;
  version?: string;
  supportEmail: string;
  hosts?: { portal: string; admin: string; search: string; mail: string } | null;
}

export interface Bootstrap {
  site: Site;
  currentModule: string | null;
  adminHost?: boolean;
  modules: ModuleInfo[];
  authenticated: boolean;
  user: User | null;
  ldap: { configured: boolean; mode: string };
}

export interface SearchResult {
  id: string;
  title: string;
  subtitle?: string;
  href: string;
  badge?: string;
  icon?: string;
  module: string;
}

export interface Person {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  title: string | null;
  department?: string | null;
  phone?: string | null;
  bio?: string | null;
  avatarUrl: string | null;
  groups?: string[];
  status?: string;
  lastLoginAt?: string | null;
  source?: string;
}

export interface Mailbox {
  id?: string;
  user_id?: string | null;
  address: string;
  quota_mb?: number;
  quotaMb?: number;
  status: 'active' | 'suspended' | string;
  driver?: string;
  username?: string | null;
  display_name?: string | null;
}

export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
  usage: { users: number; rules: number };
}

export interface PermissionInfo {
  key: string;
  group: string;
  description: string;
}

export interface Binding {
  id: string;
  subject_type: 'user' | 'group';
  subject_value: string;
  role_key: string;
  role_name: string;
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  source: string;
  members: Array<{ id: string; username: string; display_name: string }>;
  roles: Array<{ key: string; name: string }>;
}

export interface AuditEvent {
  id: number;
  at: string;
  actor_username: string | null;
  action: string;
  target: string | null;
  result: string;
  detail: string | null;
  ip: string | null;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent?: string | null;
}

export interface LdapHealth {
  ok: boolean;
  configured: boolean;
  latencyMs: number;
  error?: string;
}
