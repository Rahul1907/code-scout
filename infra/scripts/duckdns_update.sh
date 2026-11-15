#!/usr/bin/env bash
# DuckDNS dynamic DNS updater script for CodeScout
# Usage: ./duckdns_update.sh [DOMAIN] [TOKEN]
# If arguments are not passed, reads DUCKDNS_DOMAIN and DUCKDNS_TOKEN from environment or /opt/code-scout/.env

set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/code-scout/.env}"
LOG_FILE="${LOG_FILE:-/var/log/duckdns.log}"

# Source env file if present
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  export $(grep -E '^(DUCKDNS_DOMAIN|DUCKDNS_TOKEN)=' "$ENV_FILE" | xargs -d '\n' || true)
fi

DOMAIN="${1:-${DUCKDNS_DOMAIN:-}}"
TOKEN="${2:-${DUCKDNS_TOKEN:-}}"

if [[ -z "$DOMAIN" || -z "$TOKEN" ]]; then
  echo "$(date --iso-8601=seconds) [ERROR] DUCKDNS_DOMAIN and DUCKDNS_TOKEN must be provided as arguments or env vars." | tee -a "$LOG_FILE" >&2
  exit 1
fi

# Strip .duckdns.org suffix if user provided full hostname
DOMAIN="${DOMAIN%.duckdns.org}"

# Update DuckDNS
RESPONSE=$(curl -sS --max-time 15 "https://www.duckdns.org/update?domains=${DOMAIN}&token=${TOKEN}&ip=")

TIMESTAMP=$(date --iso-8601=seconds)
if [[ "$RESPONSE" == *"OK"* ]]; then
  echo "${TIMESTAMP} [INFO] DuckDNS update succeeded for ${DOMAIN}: ${RESPONSE}" >> "$LOG_FILE"
else
  echo "${TIMESTAMP} [ERROR] DuckDNS update failed for ${DOMAIN}: ${RESPONSE}" | tee -a "$LOG_FILE" >&2
  exit 1
fi
