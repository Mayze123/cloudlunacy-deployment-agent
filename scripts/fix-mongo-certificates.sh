#!/bin/bash
# ------------------------------------------------------------------------------
# MongoDB Certificate Verification and Fix Script
# ------------------------------------------------------------------------------

set -e

# Constants
AGENT_DIR="/opt/cloudlunacy"
CERTS_DIR="${AGENT_DIR}/certs"
CA_CERT="${CERTS_DIR}/ca.crt"
SERVER_CERT="${CERTS_DIR}/server.crt"
SERVER_KEY="${CERTS_DIR}/server.key"
SERVER_PEM="${CERTS_DIR}/server.pem"
LOG_FILE="${AGENT_DIR}/logs/certificate-fix.log"

# Make sure log directory exists
mkdir -p "${AGENT_DIR}/logs"

# Logging functions
log() {
  echo "[INFO] $1"
  echo "$(date '+%Y-%m-%d %H:%M:%S') [INFO] $1" >> "$LOG_FILE"
}

log_error() {
  echo "[ERROR] $1" >&2
  echo "$(date '+%Y-%m-%d %H:%M:%S') [ERROR] $1" >> "$LOG_FILE"
}

# Check if running as root
if [ "$(id -u)" -ne 0 ]; then
  log_error "This script must be run as root. Please run with sudo."
  exit 1
fi

# Check and create certificate directory if it doesn't exist
if [ ! -d "$CERTS_DIR" ]; then
  log "Creating certificates directory at $CERTS_DIR"
  mkdir -p "$CERTS_DIR"
fi

# Function to check certificate files
check_certificates() {
  local all_exist=true

  log "Checking certificate files..."

  # Check CA certificate
  if [ -f "$CA_CERT" ]; then
    local size=$(stat -c%s "$CA_CERT" 2> /dev/null || stat -f%z "$CA_CERT")
    log "CA Certificate exists (${size} bytes)"

    # Check if it's a valid certificate
    if openssl x509 -in "$CA_CERT" -noout -text > /dev/null 2>&1; then
      log "CA Certificate is valid"
    else
      log_error "CA Certificate is not valid"
      all_exist=false
    fi
  else
    log_error "CA Certificate does not exist at $CA_CERT"
    all_exist=false
  fi

  # Check Server certificate
  if [ -f "$SERVER_CERT" ]; then
    local size=$(stat -c%s "$SERVER_CERT" 2> /dev/null || stat -f%z "$SERVER_CERT")
    log "Server Certificate exists (${size} bytes)"

    if openssl x509 -in "$SERVER_CERT" -noout -text > /dev/null 2>&1; then
      log "Server Certificate is valid"
    else
      log_error "Server Certificate is not valid"
      all_exist=false
    fi
  else
    log_error "Server Certificate does not exist at $SERVER_CERT"
    all_exist=false
  fi

  # Check Server key
  if [ -f "$SERVER_KEY" ]; then
    local size=$(stat -c%s "$SERVER_KEY" 2> /dev/null || stat -f%z "$SERVER_KEY")
    log "Server Key exists (${size} bytes)"

    if openssl rsa -in "$SERVER_KEY" -check -noout > /dev/null 2>&1; then
      log "Server Key is valid"
    else
      log_error "Server Key is not valid"
      all_exist=false
    fi
  else
    log_error "Server Key does not exist at $SERVER_KEY"
    all_exist=false
  fi

  # Check Server PEM
  if [ -f "$SERVER_PEM" ]; then
    local size=$(stat -c%s "$SERVER_PEM" 2> /dev/null || stat -f%z "$SERVER_PEM")
    log "Server PEM exists (${size} bytes)"
  else
    log_error "Server PEM does not exist at $SERVER_PEM"
    all_exist=false
  fi

  return $all_exist
}

# Function to fix certificate permissions
fix_certificate_permissions() {
  log "Fixing certificate permissions..."

  chmod 700 "$CERTS_DIR"

  if [ -f "$CA_CERT" ]; then
    chmod 644 "$CA_CERT"
    log "Set permissions on CA certificate"
  fi

  if [ -f "$SERVER_CERT" ]; then
    chmod 644 "$SERVER_CERT"
    log "Set permissions on server certificate"
  fi

  if [ -f "$SERVER_KEY" ]; then
    chmod 600 "$SERVER_KEY"
    log "Set permissions on server key"
  fi

  if [ -f "$SERVER_PEM" ]; then
    chmod 600 "$SERVER_PEM"
    log "Set permissions on server PEM"
  fi

  # Set ownership to cloudlunacy user
  chown -R cloudlunacy:cloudlunacy "$CERTS_DIR"
  log "Set ownership of certificates directory to cloudlunacy user"
}

# Function to fetch certificates from the agent JWT file
fetch_certificates_from_jwt() {
  local jwt_file="${AGENT_DIR}/.agent_jwt.json"

  if [ ! -f "$jwt_file" ]; then
    log_error "Agent JWT file not found at $jwt_file"
    return 1
  fi

  log "Extracting certificates from JWT file..."

  # Extract certificates using jq
  if ! command -v jq &> /dev/null; then
    log "jq not found, installing..."
    apt-get update && apt-get install -y jq
  fi

  # Extract CA certificate
  if jq -r '.certificates.caCert' "$jwt_file" > "$CA_CERT"; then
    log "Extracted CA certificate from JWT file"
  else
    log_error "Failed to extract CA certificate from JWT file"
    return 1
  fi

  # Extract server certificate
  if jq -r '.certificates.serverCert' "$jwt_file" > "$SERVER_CERT"; then
    log "Extracted server certificate from JWT file"
  else
    log_error "Failed to extract server certificate from JWT file"
    return 1
  fi

  # Extract server key
  if jq -r '.certificates.serverKey' "$jwt_file" > "$SERVER_KEY"; then
    log "Extracted server key from JWT file"
  else
    log_error "Failed to extract server key from JWT file"
    return 1
  fi

  # Create combined PEM file
  cat "$SERVER_KEY" "$SERVER_CERT" > "$SERVER_PEM"
  log "Created combined PEM file"

  return 0
}

# Function to restart the CloudLunacy service
restart_service() {
  log "Restarting CloudLunacy service..."
  systemctl restart cloudlunacy

  # Check if service restarted successfully
  if systemctl is-active --quiet cloudlunacy; then
    log "CloudLunacy service restarted successfully"
    return 0
  else
    log_error "Failed to restart CloudLunacy service"
    return 1
  fi
}

# Main function
main() {
  log "Starting MongoDB certificate verification and fix script"

  # Check if certificates exist and are valid
  if ! check_certificates; then
    log "Certificate issues detected, attempting to fix..."

    # Try to extract certificates from JWT file
    if ! fetch_certificates_from_jwt; then
      log_error "Failed to fix certificates automatically"
      exit 1
    fi

    # Check certificates again
    if ! check_certificates; then
      log_error "Certificates are still invalid after fix attempt"
      exit 1
    fi
  fi

  # Fix certificate permissions regardless
  fix_certificate_permissions

  # Restart service to apply changes
  if restart_service; then
    log "Certificate verification and fix completed successfully"
  else
    log_error "Service restart failed"
    exit 1
  fi
}

# Run the main function
main
