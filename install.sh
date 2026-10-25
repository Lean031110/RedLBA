#!/usr/bin/env bash
# RedLBA · instalador para Ubuntu/Debian
#
#   sudo ./install.sh --dominio tudominio.com --auto
#
# Qué hace:
#   1. Detecta Ubuntu/Debian y los servicios ya instalados (Caddy, nginx, bind9,
#      dnsmasq, postfix, dovecot, slapd, docker).
#   2. Crea .env con claves y subdominios (portal/admin/buscar/correo).
#   3. Genera la configuración de DNS, proxy inverso y correo.
#   4. Si el servicio está instalado y tiene su configuración por defecto, la
#      aplica (con copia de seguridad). Si ya está personalizado, NO lo toca:
#      deja el fichero generado en deploy/generated/ y una guía paso a paso.
#   5. Instala dependencias, compila y crea la unidad de systemd.
#
# Opciones:
#   --dominio <d>   Dominio raíz (obligatorio en modo automático)
#   --auto          No pregunta nada: usa valores por defecto
#   --aplicar       Escribe también en /etc (con copia .bak.redlba)
#   --sin-internet  No descarga nada: usa lo que ya está en el servidor
#   --puerto <n>    Puerto de la app (por defecto 8080)
#   --ayuda         Muestra esta ayuda

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
GENERATED="$ROOT/deploy/generated"
DOMAIN=""
AUTO=0
APPLY=0
ONLINE=1
PORT=8080
REPORT="$GENERATED/INFORME-INSTALACION.md"
STAMP="$(date '+%Y-%m-%d %H:%M')"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[1;32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
err()  { printf '  \033[1;31m✖\033[0m %s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dominio)    DOMAIN="${2:-}"; shift 2 ;;
    --puerto)     PORT="${2:-8080}"; shift 2 ;;
    --auto)       AUTO=1; shift ;;
    --aplicar)    APPLY=1; shift ;;
    --sin-internet) ONLINE=0; shift ;;
    --ayuda|-h)   sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "Opción desconocida: $1 (usa --ayuda)"; exit 2 ;;
  esac
done

mkdir -p "$GENERATED"
SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"

# Copia de seguridad antes de tocar un fichero del sistema.
backup() {
  local file="$1"
  [ -f "$file" ] || return 0
  [ -f "$file.bak.redlba" ] || $SUDO cp -a "$file" "$file.bak.redlba"
}

have() { command -v "$1" >/dev/null 2>&1; }

# write_file <destino> <contenido-via-stdin>  (respeta --aplicar y dry-run)
install_file() {
  local dest="$1"
  if [ "$APPLY" -eq 1 ] && [[ "$dest" == /etc/* ]]; then
    backup "$dest"
    $SUDO mkdir -p "$(dirname "$dest")"
    cat | $SUDO tee "$dest" >/dev/null
    ok "escrito $dest"
  else
    local target="$GENERATED/sistema${dest}"
    mkdir -p "$(dirname "$target")"
    cat > "$target"
    ok "generado deploy/generated/sistema${dest} (usa --aplicar para instalarlo en $dest)"
  fi
}

# ---------------------------------------------------------------- sistema
log "Comprobando el sistema"

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-}"
else
  OS_ID=""
fi

case "$OS_ID" in
  ubuntu|debian) ok "Sistema operativo: ${PRETTY_NAME:-$OS_ID}" ;;
  "")            warn "No se pudo detectar el sistema operativo; se continuará asumiendo Ubuntu." ;;
  *)             warn "Sistema no soportado oficialmente: $OS_ID. RedLBA está probado en Ubuntu." ;;
esac

if [ "$ONLINE" -eq 1 ]; then
  if [ "$APPLY" -eq 1 ] && have apt-get; then
    log "Actualizando índices de paquetes"
    $SUDO apt-get update -qq || warn "No se pudo actualizar apt; se continúa con los índices actuales."
  fi
fi

# Node.js
if ! have node || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]; then
  if [ "$ONLINE" -eq 1 ] && have apt-get && [ "$APPLY" -eq 1 ]; then
    log "Instalando Node.js 22 desde el repositorio del sistema"
    if $SUDO apt-get install -y -qq nodejs npm >/dev/null 2>&1; then
      ok "Node.js instalado: $(node -v 2>/dev/null || echo '?')"
    else
      warn "No se pudo instalar nodejs con apt."
    fi
  fi
fi

if have node; then
  ok "Node.js $(node -v)"
else
  err "Node.js 22 o superior es obligatorio."
  echo "   Guía: sudo apt install nodejs npm   (o instala Node 22 desde nodejs.org)"
  echo "   Después vuelve a ejecutar este instalador."
  exit 1
fi

# ------------------------------------------------------- servicios detectados
log "Detectando servicios instalados"

SVC_CADDY=0;    have caddy    && SVC_CADDY=1
SVC_NGINX=0;    have nginx    && SVC_NGINX=1
SVC_BIND=0;     [ -d /etc/bind ] || have named-checkconf && SVC_BIND=1
SVC_DNSMASQ=0;  have dnsmasq  && SVC_DNSMASQ=1
SVC_POSTFIX=0;  have postfix  && SVC_POSTFIX=1
SVC_DOVECOT=0;  have dovecot  && SVC_DOVECOT=1
SVC_SLAPD=0;    have slapd    && SVC_SLAPD=1
SVC_DOCKER=0;   have docker   && SVC_DOCKER=1

[ "$SVC_CADDY"   -eq 1 ] && ok "Proxy inverso: Caddy"   || warn "Caddy no instalado (se generará la configuración)"
[ "$SVC_NGINX"   -eq 1 ] && ok "nginx encontrado (alternativa a Caddy)"
[ "$SVC_BIND"    -eq 1 ] && ok "DNS: bind9"             || true
[ "$SVC_DNSMASQ" -eq 1 ] && ok "DNS: dnsmasq"          || true
[ "$SVC_BIND" -eq 0 ] && [ "$SVC_DNSMASQ" -eq 0 ] && warn "No se detectó bind9 ni dnsmasq: configuración DNS generada como plantilla"
[ "$SVC_POSTFIX" -eq 1 ] && ok "Correo MTA: postfix"    || warn "postfix no instalado (solo se generará la guía)"
[ "$SVC_DOVECOT" -eq 1 ] && ok "Correo MDA: dovecot"   || warn "dovecot no instalado (solo se generará la guía)"
[ "$SVC_SLAPD"   -eq 1 ] && ok "Directorio: slapd"     || warn "slapd no instalado (se usará el OpenLDAP de docker o LDAP remoto)"
[ "$SVC_DOCKER"  -eq 1 ] && ok "Docker disponible"     || true

# --------------------------------------------------------------- identidad
if [ -z "$DOMAIN" ]; then
  if [ "$AUTO" -eq 1 ]; then
    DOMAIN="redlba.local"
    warn "Sin --dominio: se usa $DOMAIN (cámbialo en .env)"
  else
    printf 'Dominio raíz del servidor [tudominio.com]: '
    read -r DOMAIN
    DOMAIN="${DOMAIN:-redlba.local}"
  fi
fi
DOMAIN="${DOMAIN#.}"
DOMAIN="${DOMAIN%.}"
BASE_DN="$(echo "$DOMAIN" | awk -F. '{for(i=NF;i>=1;i--){printf "dc=%s%s",$i,(i>1?".":"")}}')"
SERVER_IP="${REDLBA_SERVER_IP:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
SERVER_IP="${SERVER_IP:-127.0.0.1}"

if [ -f "$ROOT/.env" ]; then
  ok ".env existente: se conserva"
else
  SECRET_KEY="${SECRET_KEY:-}"
  if [ -z "$SECRET_KEY" ]; then
    if have openssl; then SECRET_KEY="$(openssl rand -hex 32)"
    else SECRET_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"; fi
  fi
  log "Creando .env para $DOMAIN"
  cat > "$ROOT/.env" <<EOF
# RedLBA · generado por install.sh el $STAMP
NODE_ENV=production
PORT=$PORT
HOST=0.0.0.0
SECRET_KEY=$SECRET_KEY

REDLBA_DOMAIN=$DOMAIN
REDLBA_BASE_URL=https://portal.$DOMAIN
COOKIE_DOMAIN=$DOMAIN
TRUST_PROXY=true

# Subdominios (el instalador crea los registros DNS)
REDLBA_SUBDOMAINS=true
PORTAL_SUBDOMAIN=portal
ADMIN_SUBDOMAIN=admin
SEARCH_SUBDOMAIN=buscar
MAIL_SUBDOMAIN=correo

# Directorio
AUTH_MODE=hybrid
LDAP_URL=ldap://127.0.0.1:389
LDAP_BASE_DN=$BASE_DN
LDAP_USERS_OU=ou=people
LDAP_GROUPS_OU=ou=groups
LDAP_BIND_DN=cn=admin,$BASE_DN

# Correo (Postfix + Dovecot locales)
MAIL_DRIVER=ldap
MAIL_DOMAIN=$DOMAIN
IMAP_HOST=mail.$DOMAIN
IMAP_PORT=993
SMTP_HOST=127.0.0.1
SMTP_PORT=25
EOF
  ok ".env creado en $ROOT/.env"
fi

# ------------------------------------------------------------------- DNS
log "Configurando DNS de los subdominios"

DNS_HOSTS="portal admin buscar correo mail"
zone_name="$DOMAIN"

{
  echo "; RedLBA · zona generada por install.sh ($STAMP)"
  echo "\$TTL    3600"
  echo "@       IN      SOA     ns1.$zone_name. hostmaster.$zone_name. ("
  echo "                        $(date +%Y%m%d)01 ; serial"
  echo "                        3600        ; refresh"
  echo "                        900         ; retry"
  echo "                        604800      ; expire"
  echo "                        3600 )      ; minimum"
  echo "@       IN      NS      ns1.$zone_name."
  echo "@       IN      A       $SERVER_IP"
  echo "ns1     IN      A       $SERVER_IP"
  for h in $DNS_HOSTS; do
    echo "$h     IN      A       $SERVER_IP"
  done
} > "$GENERATED/db.$zone_name"
ok "zona generada: deploy/generated/db.$zone_name"

if [ "$SVC_BIND" -eq 1 ]; then
  install_file "/etc/bind/db.redlba" < "$GENERATED/db.$zone_name"
  install_file "/etc/bind/named.conf.redlba" <<EOF
zone "$zone_name" {
    type master;
    file "/etc/bind/db.redlba";
};
EOF
  if [ "$APPLY" -eq 1 ]; then
    if ! grep -q "named.conf.redlba" /etc/bind/named.conf 2>/dev/null; then
      echo 'include "/etc/bind/named.conf.redlba";' | $SUDO tee -a /etc/bind/named.conf >/dev/null
    fi
    $SUDO systemctl reload named 2>/dev/null || $SUDO systemctl restart bind9 2>/dev/null || warn "Recarga manual de bind9 necesaria"
    ok "bind9 recargado con la zona $zone_name"
  fi
elif [ "$SVC_DNSMASQ" -eq 1 ]; then
  {
    echo "# RedLBA · generado por install.sh ($STAMP)"
    for h in $DNS_HOSTS; do
      echo "address=/$h.$zone_name/$SERVER_IP"
    done
  } > "$GENERATED/redlba-dnsmasq.conf"
  install_file "/etc/dnsmasq.d/redlba.conf" < "$GENERATED/redlba-dnsmasq.conf"
  if [ "$APPLY" -eq 1 ] && $SUDO systemctl reload dnsmasq 2>/dev/null; then
    ok "dnsmasq recargado"
  fi
else
  warn "Sin servidor DNS local: plantilla lista en deploy/generated/db.$zone_name"
fi

# ---------------------------------------------------------- proxy inverso
log "Configurando el proxy inverso"

if [ "$SVC_CADDY" -eq 1 ]; then
  if [ -f /etc/caddy/Caddyfile ] && ! grep -q "RedLBA" /etc/caddy/Caddyfile; then
    warn "/etc/caddy/Caddyfile ya existe y no es de RedLBA: no se modifica"
    warn "Añade el bloque de deploy/Caddyfile y ejecuta: sudo caddy reload --config /etc/caddy/Caddyfile"
  else
    REDLBA_DOMAIN="$DOMAIN" \
      sed -e "s/{\$REDLBA_DOMAIN}/$DOMAIN/g" \
          -e "s/redlba:8080/127.0.0.1:$PORT/g" \
          "$ROOT/deploy/Caddyfile" \
      | install_file "/etc/caddy/Caddyfile"
    if [ "$APPLY" -eq 1 ] && $SUDO systemctl reload caddy 2>/dev/null; then
      ok "caddy recargado"
    fi
  fi
else
  sed -e "s/{\$REDLBA_DOMAIN}/$DOMAIN/g" -e "s/redlba:8080/127.0.0.1:$PORT/g" \
    "$ROOT/deploy/Caddyfile" > "$GENERATED/Caddyfile"
  warn "Caddy no instalado: configuración en deploy/generated/Caddyfile"
fi

if [ "$SVC_NGINX" -eq 1 ]; then
  cat > "$GENERATED/nginx-redlba.conf" <<EOF
# RedLBA · sitio de nginx ($STAMP)
# Copia a /etc/nginx/sites-available/redlba y habilita con:
#   sudo ln -s /etc/nginx/sites-available/redlba /etc/nginx/sites-enabled/
#   sudo nginx -t && sudo systemctl reload nginx
server {
    listen 80;
    server_name portal.$DOMAIN admin.$DOMAIN buscar.$DOMAIN correo.$DOMAIN $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        client_max_body_size 64m;
    }
}
EOF
  warn "nginx encontrado: sitio generado en deploy/generated/nginx-redlba.conf (no se modifica nginx automáticamente)"
fi

# ------------------------------------------------------------------ correo
log "Configurando el correo (Postfix + Dovecot)"

MAIL_GUIDE="$GENERATED/GUIA-CORREO.md"
{
  echo "# Configuración del correo para RedLBA · $STAMP"
  echo
  echo "Los buzones viven en LDAP (ou=people,$(echo "$DOMAIN" | awk -F. '{for(i=NF;i>=1;i--){printf "dc=%s%s",$i,(i>1?".":"")}}'))."
  echo "RedLBA crea las cuentas con el atributo \`userPassword\` ({SSHA}) y \`(mail\`PostalAddress)."
  echo
  if [ "$SVC_POSTFIX" -eq 1 ]; then
    echo "## Postfix (detectado)"
    echo "Fichero generado: \`deploy/generated/sistema/etc/postfix/redlba-ldap.cf\`"
    echo
    echo '```'
    echo "1. sudo cp deploy/generated/sistema/etc/postfix/redlba-ldap.cf /etc/postfix/ldap-aliases.cf"
    echo "2. Añade a /etc/postfix/main.cf:"
    echo "   virtual_transport = ldap:/etc/postfix/ldap-aliases.cf"
    echo "   myhostname = mail.$DOMAIN"
    echo "   mydomain = $DOMAIN"
    echo "   mydestination = \$myhostname, localhost.\$mydomain, localhost, $DOMAIN"
    echo "   smtpd_recipient_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination"
    echo "3. sudo postfix check && sudo systemctl reload postfix"
    echo '```'
  else
    echo "## Postfix (NO instalado)"
    echo '```'
    echo "sudo apt install postfix dovecot-imapd dovecot-ldap"
    echo '```'
    echo "Luego aplica los apartados siguientes."
  fi
  echo
  echo "## Dovecot"
  echo '```'
  echo "# /etc/dovecot/conf.d/10-ldap.conf"
  echo "pass_attrs = userPassword"
  echo "pass_driver = ldap"
  echo "userdb_driver = static"
  echo "mail_location = maildir:/var/vmail/%d/%n"
  echo "ssl = required"
  echo "ssl_cert = </etc/ssl/certs/ssl-cert-snakeoil.pem"
  echo "ssl_key = </etc/ssl/private/ssl-cert-snakeoil.key"
  echo '```'
  echo
  echo "## Webmail"
  echo "RedLBA trae un webmail integrado en correo.\$DOMAIN. Configura en \`.env\`:"
  echo '```'
  echo "IMAP_HOST=mail.$DOMAIN"
  echo "IMAP_PORT=993"
  echo "SMTP_HOST=127.0.0.1"
  echo "SMTP_PORT=25"
  echo '```'
} > "$MAIL_GUIDE"
ok "guía del correo: $MAIL_GUIDE"

install_file "/etc/postfix/redlba-ldap.cf" <<EOF
# RedLBA · transporte LDAP de Postfix ($STAMP)
server_host = ldap://127.0.0.1
bind = yes
bind_dn = cn=admin,$BASE_DN
bind_pw = CAMBIA_ESTA_CLAVE
search_base = ou=people,$BASE_DN
result_attribute = uid
domain = $DOMAIN
EOF

# ------------------------------------------------------------------ LDAP
LDAP_GUIDE="$GENERATED/GUIA-LDAP.md"
{
  echo "# Directorio LDAP para RedLBA · $STAMP"
  echo
  if [ "$SVC_SLAPD" -eq 1 ]; then
    echo "slapd está instalado. Si ya tiene un directorio, solo falta la unidad de servicio:"
    echo '```'
    echo "LDAP_URL=ldap://127.0.0.1:389"
    echo "LDAP_BASE_DN=$BASE_DN"
    echo "LDAP_BIND_DN=cn=admin,$BASE_DN"
    echo "LDAP_BIND_PASSWORD=..."
    echo '```'
    echo "Valida con: \`npm --workspace server run ldap:check\`"
  else
    echo "slapd no está instalado. Dos opciones:"
    echo
    echo "**A · OpenLDAP en Docker (recomendado para empezar)**"
    echo '```'
    echo "docker compose --profile ldap up -d openldap"
    echo "docker compose exec openldap ldapadd -x -D cn=admin,dc=redlba,dc=local -w secret -f /ldif/bootstrap.ldif"
    echo '```'
    echo
    echo "**B · slapd del sistema**"
    echo '```'
    echo "sudo apt install slapd ldap-utils"
    echo "sudo dpkg-reconfigure slapd   # dominio: $DOMAIN, organización, contraseña del admin"
    echo "sudo ldapadd -x -D cn=admin,$BASE_DN -W -f deploy/ldap/bootstrap.ldif"
    echo '```'
    echo
    echo "Después ejecuta la sincronización: \`npm --workspace server run ldap:sync\`"
  fi
} > "$LDAP_GUIDE"
ok "guía del directorio: $LDAP_GUIDE"

# ------------------------------------------------------------- aplicación
log "Instalando y compilando RedLBA"

if [ ! -d "$ROOT/node_modules" ]; then
  if [ "$ONLINE" -eq 1 ]; then
    npm ci --no-audit --no-fund >/dev/null || { err "npm ci falló"; exit 1; }
    ok "dependencias instaladas"
  else
    err "No hay node_modules y --sin-internet impide descargarlas."
    echo "   Copia el proyecto con node_modules ya instalados o ejecuta: npm ci"
    exit 1
  fi
else
  ok "dependencias ya presentes"
fi

npm run build >/dev/null || { err "La compilación falló"; exit 1; }
ok "aplicación compilada"

# --------------------------------------------------------------- servicio
UNIT="/etc/systemd/system/redlba.service"
install_file "$UNIT" <<EOF
[Unit]
Description=RedLBA · portal, identidad y módulos de intranet
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT
EnvironmentFile=$ROOT/.env
ExecStart=$(command -v node) $ROOT/server/dist/index.js
Restart=on-failure
RestartSec=3
User=$(id -un)
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

if [ "$APPLY" -eq 1 ]; then
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now redlba 2>/dev/null || warn "No se pudo iniciar el servicio (revísalo con: systemctl status redlba)"
  ok "servicio redlba instalado y arrancado"
fi

# ---------------------------------------------------------------- informe
log "Generando el informe"

{
  echo "# Informe de instalación de RedLBA"
  echo
  echo "- Fecha: $STAMP"
  echo "- Dominio: $DOMAIN"
  echo "- Puerto: $PORT"
  echo "- Aplicación: $ROOT"
  echo "- Sistema: ${PRETTY_NAME:-desconocido}"
  echo "- Servicios detectados: Caddy=$SVC_CADDY nginx=$SVC_NGINX bind9=$SVC_BIND dnsmasq=$SVC_DNSMASQ postfix=$SVC_POSTFIX dovecot=$SVC_DOVECOT slapd=$SVC_SLAPD docker=$SVC_DOCKER"
  echo
  echo "## Pendiente para el administrador"
  echo
  echo "1. **Registros DNS** · crea estos registros A hacia la IP del servidor:"
  echo
  for h in $DNS_HOSTS; do echo "   - \`$h.$DOMAIN\`"; done
  echo "   - \`$DOMAIN\` (redirige a portal)"
  echo
  echo "2. **Correo** · sigue $MAIL_GUIDE"
  echo
  echo "3. **Directorio LDAP** · sigue $LDAP_GUIDE"
  echo
  echo "4. **TLS** · con Caddy es automático; si usas nginx, añade certbot:"
  echo "   \`sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx\`"
  echo
  echo "5. **Arranque** · \`sudo systemctl enable --now redlba\`"
  echo
  echo "6. **Verificación** · \`curl -s https://portal.$DOMAIN/api/health\`"
  echo
  echo "## Prueba rápida"
  echo '```'
  echo "npm start"
  echo "curl -s localhost:$PORT/api/health"
  echo '```'
} > "$REPORT"

echo
log "Instalación terminada"
ok "Informe: ${REPORT#$ROOT/}"
ok "Guías:   ${MAIL_GUIDE#$ROOT/} · ${LDAP_GUIDE#$ROOT/}"
if [ "$APPLY" -eq 0 ]; then
  warn "Modo seguro: nada se ha escrito en /etc. Repite con --aplicar para instalar la configuración generada."
fi
echo
