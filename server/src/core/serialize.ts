import type { AuthContext } from './auth.js';
import type { AppRow, UserRow } from './db.js';
import { groupsOf } from './identity.js';
import { hasPermission } from './rbac.js';

export interface PublicPerson {
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

export function personFor(user: UserRow, viewer: AuthContext): PublicPerson {
  const privileged = hasPermission(viewer.access, 'users.write');
  const isSelf = viewer.user.id === user.id;
  const base: PublicPerson = {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    email: user.email,
    title: user.title,
    avatarUrl: user.avatar_url,
  };

  if (privileged || isSelf) {
    return {
      ...base,
      department: user.department,
      phone: user.phone,
      bio: user.bio,
      groups: groupsOf(user.id),
      status: user.status,
      lastLoginAt: user.last_login_at,
      source: user.source,
    };
  }

  if (user.profile_visibility === 'private') {
    return base;
  }

  base.department = user.department;
  if (user.profile_visibility === 'organization') {
    base.phone = user.phone;
    base.bio = user.bio;
    base.groups = groupsOf(user.id);
  }
  return base;
}

export function appFor(row: AppRow) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    description: row.description,
    icon: row.icon,
    color: row.color,
    permission: row.permission,
    sort: row.sort,
    enabled: Boolean(row.enabled),
  };
}
