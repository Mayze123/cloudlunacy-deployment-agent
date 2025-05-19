#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------------------
# Minimal Nixpacks Installer for CloudLunacy
# ------------------------------------------------------------------------------

log() { echo -e "\033[1;32m[INFO]\033[0m  $*"; }
warn() { echo -e "\033[1;33m[WARN]\033[0m  $*"; }
error() { echo -e "\033[1;31m[ERROR]\033[0m $*"; }

# 1) Bail out early if the user didn’t request it
if [ "${INSTALL_NIXPACKS:-false}" != "true" ]; then
  log "Skipping Nixpacks installation (not requested)"
  exit 0
fi

# 2) If already installed, nothing to do
if command -v nixpacks &> /dev/null; then
  log "Nixpacks already present ($(nixpacks --version))"
  exit 0
fi

# 3) Try the official curl installer
if command -v curl &> /dev/null; then
  log "Installing via official script…"
  tmp="$(mktemp)"
  if curl -fsSL https://nixpacks.com/install.sh -o "$tmp"; then
    chmod +x "$tmp"
    (id -u &> /dev/null && { sudo "$tmp" || "$tmp"; }) || "$tmp"
    rm -f "$tmp"
    if command -v nixpacks &> /dev/null; then
      log "✓ Installed via curl ($(nixpacks --version))"
      goto update
    else
      warn "curl script ran but nixpacks not found"
    fi
  else
    warn "Failed to download installer"
    rm -f "$tmp"
  fi
else
  warn "curl not available, skipping"
fi

# 4) Try Homebrew
if command -v brew &> /dev/null; then
  log "Installing via Homebrew…"
  if brew install nixpacks; then
    log "✓ Installed via brew ($(nixpacks --version))"
    goto update
  else
    warn "brew install failed"
  fi
else
  warn "Homebrew not detected"
fi

# 5) Fallback: Docker wrapper
if command -v docker &> /dev/null; then
  log "Creating Docker-based wrapper…"
  wrapper_dir="${HOME}/.local/bin"
  mkdir -p "$wrapper_dir"
  cat > "$wrapper_dir/nixpacks" << 'EOF'
#!/usr/bin/env bash
IMAGE="railwayapp/nixpacks:latest"
docker pull "$IMAGE" >/dev/null 2>&1 || true
exec docker run --rm -v "$(pwd)":/workspace -w /workspace "$IMAGE" "$@"
EOF
  chmod +x "$wrapper_dir/nixpacks"
  export PATH="$wrapper_dir:$PATH"
  if nixpacks --version &> /dev/null; then
    log "✓ Docker wrapper ready ($(nixpacks --version))"
    goto update
  else
    warn "Docker wrapper failed"
  fi
else
  warn "docker not available"
fi

error "All install methods failed; please install manually." && exit 1

:update
# 6) Update CloudLunacy .env to enable Nixpacks
env_file="/opt/cloudlunacy/.env"
[ ! -f "$env_file" ] && env_file="$(pwd)/.env"
if [ -f "$env_file" ]; then
  log "Updating $env_file to enable NIXPACKS"
  sed -i.bak -E 's/^USE_NIXPACKS=.*/USE_NIXPACKS=true/; s/^NIXPACKS_SKIP_AUTO_INSTALL=.*/NIXPACKS_SKIP_AUTO_INSTALL=true/' "$env_file" \
    || printf "\nUSE_NIXPACKS=true\nNIXPACKS_SKIP_AUTO_INSTALL=true\n" >> "$env_file"
  log "Configuration updated"
else
  warn "Could not find .env to update; please set USE_NIXPACKS=true yourself"
fi

log "Done." && exit 0
