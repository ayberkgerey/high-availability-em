#!/usr/bin/env bash
# =============================================================================
# PeopleDesk – EC2 installer for Amazon Linux 2023
#
# Usage (from the repository root on the instance):
#   sudo AWS_REGION=eu-central-1 AWS_SECRET_NAME=peopledesk/aurora ./deployment/install.sh
#
# Optional variables (environment):
#   AWS_REGION        Region of the secret. Auto-detected from instance metadata if empty.
#   AWS_SECRET_NAME   Secrets Manager secret holding the Aurora credentials (recommended).
#   DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME  Only if NOT using Secrets Manager.
#   PORT              App port (default 3000; must match the ALB target group port).
#   DB_SSL            true|false (default true – TLS to Aurora with the RDS CA bundle).
#   INSTALL_DB_CLIENT true|false (default true – installs the MariaDB client for schema.sql).
#
# Re-running the script upgrades the code and restarts the service. An existing
# /etc/employee-management/app.env is preserved unless FORCE_ENV=true.
# =============================================================================
set -euo pipefail

APP_NAME="employee-management"
APP_USER="nodeapp"
APP_DIR="/opt/${APP_NAME}"
ENV_DIR="/etc/${APP_NAME}"
ENV_FILE="${ENV_DIR}/app.env"
CERT_DIR="${APP_DIR}/certs"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
NODE_MAJOR=20

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PORT="${PORT:-3000}"
DB_SSL="${DB_SSL:-true}"
INSTALL_DB_CLIENT="${INSTALL_DB_CLIENT:-true}"
FORCE_ENV="${FORCE_ENV:-false}"

log()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || fail "Run as root: sudo $0"
[[ -f "${SOURCE_DIR}/backend/package.json" ]] || fail "backend/package.json not found under ${SOURCE_DIR}"
[[ -f "${SOURCE_DIR}/frontend/index.html" ]] || fail "frontend/index.html not found under ${SOURCE_DIR}"

# --- 1. OS packages -----------------------------------------------------------
log "Installing OS packages"
dnf install -y -q rsync tar >/dev/null
if [[ "${INSTALL_DB_CLIENT}" == "true" ]]; then
  dnf install -y -q mariadb105 >/dev/null || warn "MariaDB client not installed (optional)"
fi

# --- 2. Node.js 20 ---------------------------------------------------------------
current_major="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
if [[ -z "${current_major}" || "${current_major}" -lt "${NODE_MAJOR}" ]]; then
  log "Installing Node.js ${NODE_MAJOR}"
  if dnf list -q "nodejs${NODE_MAJOR}" >/dev/null 2>&1; then
    # Amazon Linux 2023 ships versioned Node.js packages.
    dnf install -y -q "nodejs${NODE_MAJOR}" "nodejs${NODE_MAJOR}-npm" >/dev/null
    alternatives --set node "/usr/bin/node-${NODE_MAJOR}" 2>/dev/null || ln -sf "/usr/bin/node-${NODE_MAJOR}" /usr/bin/node
    [[ -x /usr/bin/npm ]] || ln -sf "/usr/bin/npm-${NODE_MAJOR}" /usr/bin/npm
  else
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    dnf install -y -q nodejs >/dev/null
  fi
fi
node -v | grep -qE "^v(2[0-9]|[3-9][0-9])\." || fail "Node.js >= ${NODE_MAJOR} is required, found $(node -v 2>/dev/null || echo none)"
log "Using Node.js $(node -v) / npm $(npm -v)"

# --- 3. Service user and directories --------------------------------------------
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  log "Creating system user ${APP_USER}"
  useradd --system --no-create-home --shell /sbin/nologin "${APP_USER}"
fi

log "Copying application to ${APP_DIR}"
mkdir -p "${APP_DIR}" "${CERT_DIR}" "${ENV_DIR}"
rsync -a --delete \
  --exclude 'node_modules' --exclude '.env' --exclude '.git' \
  "${SOURCE_DIR}/backend" "${SOURCE_DIR}/frontend" "${SOURCE_DIR}/database" "${APP_DIR}/"

# --- 4. Production dependencies ---------------------------------------------------
log "Installing production dependencies"
cd "${APP_DIR}/backend"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
else
  npm install --omit=dev --no-audit --no-fund --loglevel=error
fi

# --- 5. Aurora TLS CA bundle ----------------------------------------------------
if [[ "${DB_SSL}" == "true" ]]; then
  log "Downloading the Amazon RDS CA bundle"
  curl -fsSL -o "${CERT_DIR}/rds-global-bundle.pem" \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    || warn "Could not download RDS CA bundle; mysql2's built-in 'Amazon RDS' profile will be used"
fi

# --- 6. Region auto-detection (IMDSv2) ------------------------------------------
if [[ -z "${AWS_REGION:-}" ]]; then
  token="$(curl -fsS -m 2 -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
  if [[ -n "${token}" ]]; then
    AWS_REGION="$(curl -fsS -m 2 -H "X-aws-ec2-metadata-token: ${token}" \
      http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || true)"
  fi
  if [[ -n "${AWS_REGION:-}" ]]; then
    log "Detected AWS region ${AWS_REGION}"
  fi
fi

# --- 7. Environment file ---------------------------------------------------------
if [[ ! -f "${ENV_FILE}" || "${FORCE_ENV}" == "true" ]]; then
  log "Writing ${ENV_FILE}"
  ca_path=""
  [[ -f "${CERT_DIR}/rds-global-bundle.pem" ]] && ca_path="${CERT_DIR}/rds-global-bundle.pem"
  umask 027
  cat > "${ENV_FILE}" <<EOF
# PeopleDesk runtime configuration (read by systemd). Do not commit.
NODE_ENV=production
PORT=${PORT}
LOG_LEVEL=${LOG_LEVEL:-info}

# AWS Secrets Manager (preferred). Credentials come from the EC2 instance role.
AWS_REGION=${AWS_REGION:-}
AWS_SECRET_NAME=${AWS_SECRET_NAME:-}

# Direct configuration / fallbacks for fields missing in the secret.
# DB_HOST must be the Aurora CLUSTER endpoint.
DB_HOST=${DB_HOST:-}
DB_PORT=${DB_PORT:-3306}
DB_USER=${DB_USER:-}
DB_PASSWORD=${DB_PASSWORD:-}
DB_NAME=${DB_NAME:-employee_management}

DB_SSL=${DB_SSL}
DB_SSL_CA_PATH=${ca_path}

DB_POOL_SIZE=${DB_POOL_SIZE:-10}
DB_CONNECT_TIMEOUT_MS=${DB_CONNECT_TIMEOUT_MS:-5000}
DB_QUERY_RETRIES=${DB_QUERY_RETRIES:-3}
EOF
else
  log "Keeping existing ${ENV_FILE} (set FORCE_ENV=true to regenerate)"
fi

if ! grep -qE '^AWS_SECRET_NAME=.+' "${ENV_FILE}" && ! grep -qE '^DB_HOST=.+' "${ENV_FILE}"; then
  warn "Neither AWS_SECRET_NAME nor DB_HOST is set in ${ENV_FILE}; /ready will report 503 until configured."
fi

# --- 8. Permissions ---------------------------------------------------------------
chown -R root:root "${APP_DIR}"
chmod -R a+rX "${APP_DIR}"
chown root:"${APP_USER}" "${ENV_DIR}" "${ENV_FILE}"
chmod 750 "${ENV_DIR}"
chmod 640 "${ENV_FILE}"

# --- 9. systemd service -------------------------------------------------------
log "Installing systemd unit"
install -m 0644 "${SCRIPT_DIR}/employee-management.service" "${SERVICE_FILE}"
systemctl daemon-reload
systemctl enable "${APP_NAME}" >/dev/null 2>&1
systemctl restart "${APP_NAME}"

# --- 10. Verify --------------------------------------------------------------------
app_port="$(grep -E '^PORT=' "${ENV_FILE}" | cut -d= -f2)"
app_port="${app_port:-3000}"
log "Waiting for the application on port ${app_port}"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${app_port}/health" >/dev/null 2>&1; then
    log "Liveness  /health: OK"
    if curl -fsS "http://127.0.0.1:${app_port}/ready" >/dev/null 2>&1; then
      log "Readiness /ready : OK (Aurora reachable)"
    else
      warn "Readiness /ready : database not reachable yet – check security groups, secret and endpoint"
    fi
    log "Done. Logs: journalctl -u ${APP_NAME} -f"
    exit 0
  fi
  sleep 1
done

systemctl --no-pager status "${APP_NAME}" || true
fail "Application did not become healthy. Inspect: journalctl -u ${APP_NAME} -n 100"
