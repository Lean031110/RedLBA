import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, setCsrfToken } from './api';
import type { Bootstrap, ModuleInfo, User } from './types';

interface MeResponse {
  user: User;
  csrfToken: string;
  permissions: string[];
  groups: string[];
}

interface AuthValue {
  boot: Bootstrap | null;
  user: User | null;
  loading: boolean;
  error: string | null;
  modules: ModuleInfo[];
  currentModule: string | null;
  adminHost: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await api.get<Bootstrap>('/api/bootstrap');
      if (next.authenticated) {
        try {
          const me = await api.get<MeResponse>('/api/auth/me');
          setCsrfToken(me.csrfToken);
          setUser(me.user);
          next.user = me.user;
        } catch {
          setUser(null);
          next.authenticated = false;
        }
      } else {
        setUser(null);
      }
      setBoot(next);
      setError(null);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const login = useCallback(
    async (username: string, password: string) => {
      const response = await api.post<{ user: User; csrfToken: string }>('/api/auth/login', {
        username,
        password,
      });
      setCsrfToken(response.csrfToken);
      setUser(response.user);
      await reload();
    },
    [reload],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* la sesión ya no existía */
    } finally {
      setCsrfToken('');
      setUser(null);
      setBoot((current) => (current ? { ...current, authenticated: false, user: null } : current));
    }
  }, []);

  const can = useCallback(
    (permission: string) => {
      if (!user) return false;
      return user.permissions.includes('*') || user.permissions.includes(permission);
    },
    [user],
  );

  const value = useMemo<AuthValue>(
    () => ({
      boot,
      user,
      loading,
      error,
      modules: boot?.modules ?? [],
      currentModule: boot?.currentModule ?? null,
      adminHost: Boolean(boot?.adminHost),
      login,
      logout,
      reload,
      can,
    }),
    [boot, user, loading, error, login, logout, reload, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return context;
}
