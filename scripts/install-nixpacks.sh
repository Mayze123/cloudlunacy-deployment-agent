#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------------------
# CloudLunacy Minimal Nixpacks Installer (curl only)
# ------------------------------------------------------------------------------

log() { echo -e "\033[1;32m[INFO]\033[0m  $*"; }
warn() { echo -e "\033[1;33m[WARN]\033[0m  $*"; }
error() { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; }

# 1) Bail if not requested
if [ "${INSTALL_NIXPACKS:-false}" != "true" ]; then
  log "Skipping Nixpacks installation (not requested)"
  exit 0
fi

# 2) Already installed?
if command -v nixpacks &> /dev/null; then
  log "Nixpacks already installed ($(nixpacks --version))"
  exit 0
fi

# 3) Must have curl
if ! command -v curl &> /dev/null; then
  error "curl is required to install Nixpacks"
  exit 1
fi

# 4) Install via official script
log "Installing Nixpacks via official installer…"
if curl -fsSL https://nixpacks.com/install.sh | bash; then
  if command -v nixpacks &> /dev/null; then
    log "✓ Nixpacks installed successfully ($(nixpacks --version))"
  else
    error "Installer ran but nixpacks not found on PATH"
    exit 1
  fi
else
  error "Failed to download or run the installer"
  exit 1
fi

# 5) Update CloudLunacy .env
env_file="/opt/cloudlunacy/.env"
[ ! -f "$env_file" ] && env_file="$(pwd)/.env"

if [ -f "$env_file" ]; then
  log "Updating $env_file to enable Nixpacks"
  # Toggle or append the two flags
  sed -i.bak -E \
    -e 's/^USE_NIXPACKS=.*/USE_NIXPACKS=true/' \
    -e 's/^NIXPACKS_SKIP_AUTO_INSTALL=.*/NIXPACKS_SKIP_AUTO_INSTALL=true/' \
    "$env_file" \
    || {
      printf "\nUSE_NIXPACKS=true\nNIXPACKS_SKIP_AUTO_INSTALL=true\n" >> "$env_file"
    }
  log "Configuration updated"
else
  warn "No .env found; please set USE_NIXPACKS=true manually"
fi

log "Done."
