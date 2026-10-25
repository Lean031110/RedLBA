import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Icon } from '../ui';

export function Login() {
  const { login, user, boot, error: bootError } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Rutas del servidor (p. ej. /oidc/authorize) se piden al backend, no al router. */
  const leave = (target: string) => {
    if (target.startsWith('/oidc/') || target.startsWith('/oidc')) {
      window.location.replace(target);
      return;
    }
    navigate(target, { replace: true });
  };

  const searchParams = new URLSearchParams(location.search);
  const redirectTo =
    (location.state as { from?: string } | null)?.from ?? searchParams.get('next') ?? '/';

  useEffect(() => {
    if (user) leave(redirectTo);
  }, [user]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username.trim(), password);
      leave(redirectTo);
    } catch (loginError) {
      setError((loginError as Error).message);
      setBusy(false);
    }
  };

  const siteName = boot?.site.name ?? 'RedLBA';
  const ldapMode = boot?.ldap.mode ?? 'hybrid';

  return (
    <div className="auth">
      <aside className="auth-brand">
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark">R</span>
          <span>
            <span className="brand-name" style={{ color: '#fff' }}>
              {siteName}
            </span>
            <div className="brand-sub" style={{ color: 'rgba(255,255,255,.45)' }}>
              {boot?.site.domain ?? 'servidor propio'}
            </div>
          </span>
        </div>

        <div>
          <h1 className="auth-headline">Una cuenta para todo tu servidor.</h1>
          <p className="auth-copy">
            Identidad centralizada, directorio de personas y acceso único a cada servicio.
            Autoalojado, sin depender de nadie.
          </p>
          <div className="auth-points">
            <div className="auth-point">
              <span className="bullet">
                <Icon name="check" />
              </span>
              LDAP como fuente de verdad de las cuentas
            </div>
            <div className="auth-point">
              <span className="bullet">
                <Icon name="check" />
              </span>
              Sesión compartida entre todos los subdominios
            </div>
            <div className="auth-point">
              <span className="bullet">
                <Icon name="check" />
              </span>
              Módulos que se activan y se mudan de dominio
            </div>
          </div>
        </div>

        <div className="auth-foot">
          RedLBA v{boot?.site.version ?? '0.1.0'} · hecho para servidores propios
        </div>
      </aside>

      <div className="auth-panel">
        <div className="auth-form">
          <div className="brand" style={{ paddingLeft: 0, marginBottom: 26 }}>
            <span className="brand-mark">R</span>
            <span>
              <span className="brand-name">{siteName}</span>
              <div className="brand-sub">Portal del servidor</div>
            </span>
          </div>

          <h2 className="auth-title">Iniciar sesión</h2>
          <p className="auth-sub">
            {ldapMode === 'local'
              ? 'Acceso con tu cuenta local del portal.'
              : 'Usa las credenciales de tu cuenta del directorio.'}
          </p>

          <form onSubmit={onSubmit}>
            <div className="field">
              <label className="label" htmlFor="username">
                Usuario
              </label>
              <input
                id="username"
                className="input"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="ana"
                required
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="password">
                Contraseña
              </label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••••"
                required
              />
            </div>

            {error ? <div className="alert alert-error">{error}</div> : null}
            {bootError ? <div className="alert alert-warn">{bootError}</div> : null}

            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
              {busy ? 'Entrando…' : 'Entrar'}
              {!busy ? <Icon name="arrowRight" /> : null}
            </button>
          </form>

          <div className="auth-links">
            <span>
              {ldapMode === 'local'
                ? 'Modo local: cuentas gestionadas en este portal.'
                : 'Conectado al directorio LDAP del servidor.'}
            </span>
            {boot?.site.supportEmail ? <span>Soporte: {boot.site.supportEmail}</span> : null}
            <span>¿Sin acceso? Pide a un administrador que restablezca tu contraseña.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
