#!/bin/bash
# ------------------------------------------------------------------------------
# Installation Script for CloudLunacy Deployment Agent
# Version: 2.7.0 (Configured for HAProxy)
# Author: Mahamadou Taibou
# Date: 2024-12-01
#
# Description:
# This script installs and configures the CloudLunacy Deployment Agent on a VPS
# with HAProxy support for TLS termination
# ------------------------------------------------------------------------------

set -euo pipefail
IFS=$'\n\t'

# ----------------------------
# Configuration Variables
# ----------------------------
USERNAME="cloudlunacy"
BASE_DIR="/opt/cloudlunacy"
CERTS_DIR="${BASE_DIR}/certs"
# Use the front server's IP as the default API URL.
: "${FRONT_API_URL:=http://138.199.165.36:3005}"
: "${NODE_PORT:=3005}"
: "${MONGO_PORT:=27017}"
: "${MONGO_USE_TLS:=true}"

# ----------------------------
# Function Definitions
# ----------------------------

display_info() {
  echo "-------------------------------------------------"
  echo "CloudLunacy Deployment Agent Installation Script"
  echo "Version: 2.7.0 (HAProxy Support)"
  echo "Author: Mahamadou Taibou"
  echo "Date: 2024-12-01"
  echo "-------------------------------------------------"
}

log() {
  echo -e "\033[1;32m[INFO]\033[0m $1"
}

log_warn() {
  echo -e "\033[1;33m[WARNING]\033[0m $1"
}

log_error() {
  echo -e "\033[1;31m[ERROR]\033[0m $1"
}

check_args() {
  if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
    log_error "Invalid number of arguments."
    echo "Usage: $0 <AGENT_TOKEN> <SERVER_ID> [BACKEND_BASE_URL]"
    exit 1
  fi
}

check_root() {
  if [ "$(id -u)" -ne 0 ]; then
    log_error "This script must be run as root. Please run it with sudo."
    exit 1
  fi
}

detect_os() {
  OS_TYPE=$(grep -w "ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
  OS_VERSION=$(grep -w "VERSION_ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
}

update_system() {
  log "Updating system packages..."
  case "$OS_TYPE" in
    ubuntu | debian | raspbian)
      apt-get update -y && apt-get upgrade -y
      ;;
    centos | fedora | rhel | ol | rocky | almalinux | amzn)
      if command -v dnf > /dev/null 2>&1; then
        dnf upgrade -y
      else
        yum update -y
      fi
      ;;
    *)
      log_error "Unsupported OS: $OS_TYPE $OS_VERSION"
      exit 1
      ;;
  esac
  log "System packages updated."
}

install_dependencies() {
  log "Installing dependencies (curl, wget, git, jq, lsof)..."
  case "$OS_TYPE" in
    ubuntu | debian | raspbian)
      apt-get install -y curl wget git jq lsof
      ;;
    centos | fedora | rhel | ol | rocky | almalinux | amzn)
      if command -v dnf > /dev/null 2>&1; then
        dnf install -y curl wget git jq lsof
      else
        yum install -y curl wget git jq lsof
      fi
      ;;
    *)
      log_error "Unsupported OS: $OS_TYPE $OS_VERSION"
      exit 1
      ;;
  esac
  log "Dependencies installed."
}

stop_conflicting_containers() {
  log "Checking for Docker containers using port 27017..."
  CONTAINER_ID=$(docker ps -q --filter "publish=27017")
  if [ -n "$CONTAINER_ID" ]; then
    log "Stopping container using port 27017 (ID: $CONTAINER_ID)..."
    docker stop "$CONTAINER_ID"
    docker rm "$CONTAINER_ID"
    log "Container stopped and removed."
  else
    log "No Docker containers are using port 27017."
  fi
}

install_docker() {
  log "Checking Docker installation..."
  if command -v docker > /dev/null 2>&1; then
    log "Docker is already installed."
  else
    log "Docker not found. Installing Docker..."
    case "$OS_TYPE" in
      ubuntu | debian)
        apt-get remove -y docker docker-engine docker.io containerd runc || true
        apt-get update -y
        apt-get install -y \
          ca-certificates \
          curl \
          gnupg \
          lsb-release
        mkdir -p /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/$OS_TYPE/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        echo \
          "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS_TYPE \
                    $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
        apt-get update -y
        apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
        ;;
      centos | rhel | fedora | rocky | almalinux)
        yum remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine || true
        yum install -y yum-utils
        yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
        yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
        systemctl start docker
        ;;
      *)
        log_error "Docker installation not supported on this OS."
        exit 1
        ;;
    esac

    systemctl enable docker
    systemctl start docker
    log "Docker installed successfully."
  fi

  # Install Docker Compose
  log "Checking Docker Compose installation..."
  if command -v docker-compose > /dev/null 2>&1; then
    log "Docker Compose is already installed."
  else
    log "Installing Docker Compose..."
    DOCKER_COMPOSE_VERSION="2.24.1"
    curl -L "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)" \
      -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    ln -sf /usr/local/bin/docker-compose /usr/bin/docker-compose
    log "Docker Compose installed successfully."
  fi
}

install_node() {
  log "Checking Node.js installation..."
  if command -v node > /dev/null 2>&1; then
    log "Node.js is already installed."
    return
  fi

  log "Node.js not found. Installing Node.js..."
  NODE_VERSION="18.x"
  case "$OS_TYPE" in
    ubuntu | debian | raspbian)
      curl -fsSL https://deb.nodesource.com/setup_$NODE_VERSION | bash -
      apt-get install -y nodejs
      ;;
    centos | rhel | fedora | rocky | almalinux)
      curl -fsSL https://rpm.nodesource.com/setup_$NODE_VERSION | bash -
      yum install -y nodejs
      ;;
    *)
      log_error "Node.js installation not supported on this OS."
      exit 1
      ;;
  esac

  log "Node.js installed successfully."
}

setup_user_directories() {
  log "Creating dedicated user..."
  if id "$USERNAME" &> /dev/null; then
    log "User '$USERNAME' already exists."
  else
    useradd -m -d "$BASE_DIR" -r -s /bin/bash "$USERNAME"
    log "User '$USERNAME' created."
  fi

  # Create just the base directory if it doesn't exist
  if [ ! -d "$BASE_DIR" ]; then
    mkdir -p "$BASE_DIR"
    log "Base directory created at $BASE_DIR."
  fi

  # Set initial ownership of the base directory
  chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"
  chmod 750 "$BASE_DIR"
}

download_agent() {
  log "Cloning the CloudLunacy Deployment Agent repository..."

  # Check if the directory exists
  if [ -d "$BASE_DIR" ]; then
    log "Directory $BASE_DIR already exists. Preserving data directories while refreshing repository..."

    # Create a temporary directory for the fresh clone
    TEMP_DIR=$(mktemp -d)

    # Clone into temporary directory
    git clone https://github.com/Mayze123/cloudlunacy-deployment-agent.git "$TEMP_DIR" \
      || {
        log_error "Failed to clone repository"
        rm -rf "$TEMP_DIR"
        exit 1
      }

    # Backup important directories and files
    log "Backing up data directories and configuration files..."
    mkdir -p "/tmp/cloudlunacy-backup"

    # Preserve these directories if they exist
    for DIR in "mongodb" "redis" "certs" "logs" "deployments"; do
      if [ -d "$BASE_DIR/$DIR" ]; then
        log "Preserving $DIR directory..."
        cp -R "$BASE_DIR/$DIR" "/tmp/cloudlunacy-backup/"
      fi
    done

    # Also preserve .env and .agent_jwt.json if they exist
    for FILE in ".env" ".agent_jwt.json"; do
      if [ -f "$BASE_DIR/$FILE" ]; then
        log "Preserving $FILE file..."
        cp "$BASE_DIR/$FILE" "/tmp/cloudlunacy-backup/"
      fi
    done

    # Remove current directory contents but preserve the directory itself
    rm -rf "$BASE_DIR"/* "$BASE_DIR"/.[!.]* 2> /dev/null || true

    # Copy fresh clone to the base directory
    cp -R "$TEMP_DIR"/* "$TEMP_DIR"/.[!.]* "$BASE_DIR"/ 2> /dev/null || true

    # Restore the backed-up directories and files
    log "Restoring data directories and configuration files..."
    for DIR in "mongodb" "redis" "certs" "logs" "deployments"; do
      if [ -d "/tmp/cloudlunacy-backup/$DIR" ]; then
        log "Restoring $DIR directory..."
        mkdir -p "$BASE_DIR/$DIR"
        cp -R "/tmp/cloudlunacy-backup/$DIR"/* "$BASE_DIR/$DIR"/ 2> /dev/null || true
      fi
    done

    # Restore configuration files
    for FILE in ".env" ".agent_jwt.json"; do
      if [ -f "/tmp/cloudlunacy-backup/$FILE" ]; then
        log "Restoring $FILE file..."
        cp "/tmp/cloudlunacy-backup/$FILE" "$BASE_DIR/"
      fi
    done

    # Cleanup
    rm -rf "$TEMP_DIR" "/tmp/cloudlunacy-backup"

    log "Repository refreshed while preserving data directories."
  else
    # If the directory doesn't exist, simply clone the repository
    git clone https://github.com/Mayze123/cloudlunacy-deployment-agent.git "$BASE_DIR" \
      || {
        log_error "Failed to clone repository"
        exit 1
      }

    log "Repository freshly cloned at $BASE_DIR."
  fi

  # Create necessary directories if they don't exist
  mkdir -p "$BASE_DIR/mongodb/data/db"
  mkdir -p "$BASE_DIR/redis/data"
  mkdir -p "$CERTS_DIR"
  mkdir -p "$BASE_DIR/logs"
  mkdir -p "$BASE_DIR/deployments"

  # Change ownership of the cloned repository to the dedicated user
  chown -R "$USERNAME":"$USERNAME" "$BASE_DIR" \
    || {
      log_error "Failed to set ownership on $BASE_DIR"
      exit 1
    }
}

install_agent_dependencies() {
  log "Installing agent dependencies..."
  cd "$BASE_DIR"
  sudo -u "$USERNAME" npm install
  log "Agent dependencies installed."
}

setup_docker_permissions() {
  log "Setting up Docker permissions..."
  usermod -aG docker "$USERNAME"
  chmod 666 /var/run/docker.sock
  log "Docker permissions configured successfully."
}

setup_service() {
  log "Setting up CloudLunacy Deployment Agent as a systemd service..."
  SERVICE_FILE="/etc/systemd/system/cloudlunacy.service"
  LOG_DIR="/var/log/cloudlunacy"

  mkdir -p "$LOG_DIR"
  chown -R "$USERNAME:$USERNAME" "$LOG_DIR"
  chmod 750 "$LOG_DIR"

  cat > "$SERVICE_FILE" << EOF
[Unit]
Description=CloudLunacy Agent Service
After=network.target

[Service]
User=$USERNAME
Group=$USERNAME
WorkingDirectory=$BASE_DIR
ExecStart=/usr/bin/node --trace-warnings $BASE_DIR/src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable cloudlunacy
  systemctl start cloudlunacy
  log "CloudLunacy service setup completed successfully"
}

verify_installation() {
  log "Verifying installation..."
  sleep 5
  if systemctl is-active --quiet cloudlunacy; then
    log "CloudLunacy Deployment Agent is running successfully with HAProxy support."
  else
    log_error "Service failed to start. Check logs with: journalctl -u cloudlunacy"
    return 1
  fi
}

# ------------------------------------------------------------------------------
# Fix Permissions
# ------------------------------------------------------------------------------
fix_permissions() {
  log "Fixing permissions for existing CloudLunacy installation..."

  # Ensure all required directories exist without removing any data
  mkdir -p "$BASE_DIR/mongodb/data/db"
  mkdir -p "$BASE_DIR/redis/data"
  mkdir -p "$CERTS_DIR"
  mkdir -p "$BASE_DIR/logs"
  mkdir -p "$BASE_DIR/deployments"

  # Set ownership for all directories
  chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"
  chmod -R 750 "$BASE_DIR"

  # Special permissions for certificates directory
  if [ -d "$CERTS_DIR" ]; then
    chmod 700 "$CERTS_DIR"
    if [ -f "$CERTS_DIR/server.key" ]; then
      chmod 600 "$CERTS_DIR/server.key"
    fi
    if [ -f "$CERTS_DIR/server.pem" ]; then
      chmod 600 "$CERTS_DIR/server.pem"
    fi
  fi

  # Ensure ENV file has proper permissions
  if [ -f "$BASE_DIR/.env" ]; then
    chmod 600 "$BASE_DIR/.env"
  fi

  # Ensure JWT file has proper permissions
  if [ -f "$BASE_DIR/.agent_jwt.json" ]; then
    chmod 600 "$BASE_DIR/.agent_jwt.json"
  fi

  # Add the user to the docker group
  usermod -aG docker "$USERNAME"
  chmod 666 /var/run/docker.sock

  log "Permissions fixed successfully. You may need to restart the CloudLunacy service:"
  log "systemctl restart cloudlunacy"
}

main() {
  check_root
  display_info

  # Check if only fixing permissions
  if [ "$#" -eq 1 ] && [ "$1" = "--fix-permissions" ]; then
    fix_permissions
    exit 0
  fi

  check_args "$@"

  AGENT_TOKEN="$1"
  SERVER_ID="$2"
  BACKEND_BASE_URL="${3:-$BACKEND_URL}"
  BACKEND_URL="${BACKEND_BASE_URL}"

  detect_os
  update_system
  install_dependencies
  install_docker
  install_node
  setup_user_directories
  stop_conflicting_containers
  download_agent
  install_agent_dependencies
  setup_docker_permissions

  # Register agent first to get JWT token
  register_agent

  # Fetch certificates using the JWT token
  fetch_certificates

  # Configure environment with HAProxy TLS settings
  configure_env

  # Setup service and verify installation
  setup_service
  verify_installation

  log "Installation completed successfully with HAProxy support!"
}

# ------------------------------------------------------------------------------
# Register Agent with the Front Server
# ------------------------------------------------------------------------------
register_agent() {
  log "Registering agent with front server..."
  # Get primary IP address of the VPS
  LOCAL_IP=$(hostname -I | awk '{print $1}')
  log "register_agent ~ FRONT_API_URL, $FRONT_API_URL"
  log "register_agent ~ LOCAL_IP:, $LOCAL_IP"

  # Hostname as agent name, or use SERVER_ID if hostname is not available
  AGENT_NAME=$(hostname || echo "${SERVER_ID}-agent")

  RESPONSE=$(curl -s -X POST "${FRONT_API_URL}/api/agents/register" \
    -H "Content-Type: application/json" \
    -d "{
      \"agentId\": \"${SERVER_ID}\",
      \"agentKey\": \"${AGENT_TOKEN}\",
      \"agentName\": \"${AGENT_NAME}\",
      \"targetIp\": \"${LOCAL_IP}\"
    }")

  if echo "$RESPONSE" | grep -q "token"; then
    log "Agent registered successfully with front server. Response: $RESPONSE"

    # Extract the JWT token from the response
    JWT_TOKEN=$(echo "$RESPONSE" | jq -r '.token')

    if [ -z "$JWT_TOKEN" ] || [ "$JWT_TOKEN" = "null" ]; then
      log_error "Failed to extract JWT token from registration response"
      log_error "Response: $RESPONSE"
      exit 1
    fi

    log "JWT token extracted successfully from registration response"

    # Extract MongoDB URL from response if available
    MONGO_URL=$(echo "$RESPONSE" | grep -o '"mongodbUrl":"[^"]*"' | cut -d'"' -f4 || echo "")
    if [ -n "$MONGO_URL" ]; then
      log "MongoDB will be accessible via HAProxy at: $MONGO_URL"
    fi

    # Save the JWT to a file (separate from any static AGENT_API_TOKEN)
    JWT_FILE="/opt/cloudlunacy/.agent_jwt.json"
    echo "$RESPONSE" | jq . > "$JWT_FILE"
    chmod 600 "$JWT_FILE"
    # Change ownership to the cloudlunacy user
    chown $USERNAME:$USERNAME "$JWT_FILE"
    log "JWT file permissions updated for $USERNAME user"
  else
    log "Agent registration failed with front server. Response: $RESPONSE"
    log_error "Agent registration failed with front server. Response: $RESPONSE"
    exit 1
  fi
}

# ------------------------------------------------------------------------------
# Fetch TLS Certificates
# ------------------------------------------------------------------------------
fetch_certificates() {
  log "Fetching certificates from HAProxy front server..."

  # First authenticate to get JWT token if not already available
  if [ -z "${JWT_TOKEN:-}" ]; then
    log "No JWT token available, authenticating with HAProxy front server..."
    AUTH_RESPONSE=$(curl -s -X POST "${FRONT_API_URL}/api/agents/authenticate" \
      -H "Content-Type: application/json" \
      -d "{\"agentId\":\"${SERVER_ID}\",\"agentKey\":\"${AGENT_TOKEN}\"}")

    if [ $? -ne 0 ] || [ -z "$AUTH_RESPONSE" ]; then
      log_error "Authentication request failed"
      return 1
    fi

    # Extract JWT token
    JWT_TOKEN=$(echo "$AUTH_RESPONSE" | jq -r '.token')

    if [ -z "$JWT_TOKEN" ] || [ "$JWT_TOKEN" = "null" ]; then
      log_error "Failed to extract JWT token from response"
      log_error "Response: $AUTH_RESPONSE"
      return 1
    fi

    log "JWT token obtained successfully through authentication"
  else
    log "Using JWT token from previous registration"
  fi

  # Fetch certificates using the new HAProxy Data Plane API endpoint
  CERT_RESPONSE=$(curl -s -H "Authorization: Bearer $JWT_TOKEN" "${FRONT_API_URL}/api/config/${SERVER_ID}")

  # Debug: Print the certificate response structure
  log "Certificate response structure:"
  echo "$CERT_RESPONSE" | jq .

  # Check if response is valid JSON
  if ! echo "$CERT_RESPONSE" | jq . > /dev/null 2>&1; then
    log_error "Invalid JSON response from certificate endpoint"
    log_error "Raw response: $CERT_RESPONSE"
    return 1
  fi

  # Check if the response indicates success
  SUCCESS=$(echo "$CERT_RESPONSE" | jq -r '.success')
  if [ "$SUCCESS" != "true" ]; then
    ERROR_MSG=$(echo "$CERT_RESPONSE" | jq -r '.message')
    log_error "Certificate request failed: $ERROR_MSG"
    return 1
  fi

  # Check if certificates exist in the expected structure
  if echo "$CERT_RESPONSE" | jq -e '.certificates' > /dev/null 2>&1; then
    # Extract certificates from the standard format
    log "Using standard certificate format"

    # Debug: Check what fields are actually in the certificates object
    log "Certificate fields available:"
    echo "$CERT_RESPONSE" | jq -r '.certificates | keys[]'

    # Save raw certificate data to temporary files to bypass any JSON parsing issues
    TEMP_DIR=$(mktemp -d)
    echo "$CERT_RESPONSE" | jq -r '.certificates.caCert' > "$TEMP_DIR/ca.crt"
    echo "$CERT_RESPONSE" | jq -r '.certificates.serverCert' > "$TEMP_DIR/server.crt"
    echo "$CERT_RESPONSE" | jq -r '.certificates.serverKey' > "$TEMP_DIR/server.key"

    # Check if the temporary files have content
    CA_SIZE=$(wc -c < "$TEMP_DIR/ca.crt")
    CERT_SIZE=$(wc -c < "$TEMP_DIR/server.crt")
    KEY_SIZE=$(wc -c < "$TEMP_DIR/server.key")

    log "Certificate file sizes: CA=$CA_SIZE bytes, Cert=$CERT_SIZE bytes, Key=$KEY_SIZE bytes"

    # Load from temporary files
    CA_CERT=$(cat "$TEMP_DIR/ca.crt")
    SERVER_CERT=$(cat "$TEMP_DIR/server.crt")
    SERVER_KEY=$(cat "$TEMP_DIR/server.key")

    # Clean up
    rm -rf "$TEMP_DIR"
  elif echo "$CERT_RESPONSE" | jq -e '.config.certificates' > /dev/null 2>&1; then
    # Alternative structure: might be under config.certificates
    log "Using alternative certificate format (under config)"

    # Save raw certificate data to temporary files
    TEMP_DIR=$(mktemp -d)
    echo "$CERT_RESPONSE" | jq -r '.config.certificates.caCert' > "$TEMP_DIR/ca.crt"
    echo "$CERT_RESPONSE" | jq -r '.config.certificates.serverCert' > "$TEMP_DIR/server.crt"
    echo "$CERT_RESPONSE" | jq -r '.config.certificates.serverKey' > "$TEMP_DIR/server.key"

    # Load from temporary files
    CA_CERT=$(cat "$TEMP_DIR/ca.crt")
    SERVER_CERT=$(cat "$TEMP_DIR/server.crt")
    SERVER_KEY=$(cat "$TEMP_DIR/server.key")

    # Clean up
    rm -rf "$TEMP_DIR"
  else
    # Try to find any certificate-like fields in the response
    log_warn "Certificate structure is non-standard, attempting to locate certificate data..."

    # Debug: Show all possible paths
    log "All possible certificate paths:"
    echo "$CERT_RESPONSE" | jq -r 'paths | select(.[-1] | tostring | test("cert|key|ca"; "i")) | join(".")'

    # Save the full response for manual inspection
    TEMP_RESPONSE_FILE=$(mktemp)
    echo "$CERT_RESPONSE" > "$TEMP_RESPONSE_FILE"
    log "Full response saved to: $TEMP_RESPONSE_FILE for manual inspection"

    # Extract using direct paths (from the debug output)
    CA_CERT=$(echo "$CERT_RESPONSE" | jq -r '.certificates.caCert')
    SERVER_CERT=$(echo "$CERT_RESPONSE" | jq -r '.certificates.serverCert')
    SERVER_KEY=$(echo "$CERT_RESPONSE" | jq -r '.certificates.serverKey')
  fi

  # Check if we have valid certificates
  if [[ "$CA_CERT" != "null" && "$CA_CERT" == *"BEGIN CERTIFICATE"* && "$CA_CERT" == *"END CERTIFICATE"* ]]; then
    log "CA certificate extracted successfully ($(echo "$CA_CERT" | wc -c) bytes)"
    CA_CERT_PRESENT="Yes"
  else
    log_error "CA certificate missing or invalid"
    log_error "CA cert value starts with: $(echo "$CA_CERT" | head -c 20)..."
    CA_CERT_PRESENT="No"
  fi

  if [[ "$SERVER_CERT" != "null" && "$SERVER_CERT" == *"BEGIN CERTIFICATE"* && "$SERVER_CERT" == *"END CERTIFICATE"* ]]; then
    log "Server certificate extracted successfully ($(echo "$SERVER_CERT" | wc -c) bytes)"
    SERVER_CERT_PRESENT="Yes"
  else
    log_error "Server certificate missing or invalid"
    log_error "Server cert value starts with: $(echo "$SERVER_CERT" | head -c 20)..."
    SERVER_CERT_PRESENT="No"
  fi

  if [[ "$SERVER_KEY" != "null" && "$SERVER_KEY" == *"BEGIN PRIVATE KEY"* && "$SERVER_KEY" == *"END PRIVATE KEY"* ]]; then
    log "Server key extracted successfully ($(echo "$SERVER_KEY" | wc -c) bytes)"
    SERVER_KEY_PRESENT="Yes"
  else
    log_error "Server key missing or invalid"
    log_error "Server key value starts with: $(echo "$SERVER_KEY" | head -c 20)..."
    SERVER_KEY_PRESENT="No"
  fi

  # If any certificates are missing, report error and exit
  if [[ "$CA_CERT_PRESENT" == "No" || "$SERVER_CERT_PRESENT" == "No" || "$SERVER_KEY_PRESENT" == "No" ]]; then
    log_error "Invalid certificate data in response"
    log_error "CA cert present: $CA_CERT_PRESENT"
    log_error "Server cert present: $SERVER_CERT_PRESENT"
    log_error "Server key present: $SERVER_KEY_PRESENT"

    # Try alternative extraction directly from the saved response
    if [ -n "$TEMP_RESPONSE_FILE" ]; then
      log "Attempting direct certificate extraction from saved response..."

      # Extract using grep/sed for more resilient extraction
      CA_CERT=$(grep -ozP '(?<="caCert":")[^"]*(?=")' "$TEMP_RESPONSE_FILE" | sed 's/\\n/\n/g')
      SERVER_CERT=$(grep -ozP '(?<="serverCert":")[^"]*(?=")' "$TEMP_RESPONSE_FILE" | sed 's/\\n/\n/g')
      SERVER_KEY=$(grep -ozP '(?<="serverKey":")[^"]*(?=")' "$TEMP_RESPONSE_FILE" | sed 's/\\n/\n/g')

      log "Direct extraction results:"
      log "CA cert size: $(echo "$CA_CERT" | wc -c) bytes"
      log "Server cert size: $(echo "$SERVER_CERT" | wc -c) bytes"
      log "Server key size: $(echo "$SERVER_KEY" | wc -c) bytes"

      # Recheck if certificates are valid now
      if [[ "$CA_CERT" == *"BEGIN CERTIFICATE"* && "$SERVER_CERT" == *"BEGIN CERTIFICATE"* && "$SERVER_KEY" == *"BEGIN PRIVATE KEY"* ]]; then
        log "Direct extraction successful, proceeding with certificates"
      else
        return 1
      fi
    else
      return 1
    fi
  fi

  # Save certificates
  echo "$CA_CERT" > "${CERTS_DIR}/ca.crt"
  echo "$SERVER_CERT" > "${CERTS_DIR}/server.crt"
  echo "$SERVER_KEY" > "${CERTS_DIR}/server.key"

  # Create combined PEM file for services that need it
  cat "${CERTS_DIR}/server.key" "${CERTS_DIR}/server.crt" > "${CERTS_DIR}/server.pem"

  # Set proper permissions
  chmod 600 "${CERTS_DIR}/server.key"
  chmod 600 "${CERTS_DIR}/server.pem"
  chmod 644 "${CERTS_DIR}/server.crt"
  chmod 644 "${CERTS_DIR}/ca.crt"

  # Verify certificates
  log "Verifying certificates..."
  if openssl x509 -in "${CERTS_DIR}/server.crt" -noout -text > /dev/null 2>&1; then
    log "Server certificate is valid"
  else
    log_error "Server certificate verification failed"
    return 1
  fi

  log "Certificates fetched and saved successfully"
  return 0
}

configure_env() {
  log "Configuring environment variables..."
  ENV_FILE="$BASE_DIR/.env"

  # Generate a global JWT secret if not already set
  if [ -z "${JWT_SECRET:-}" ]; then
    JWT_SECRET=$(openssl rand -base64 32)
  fi

  cat > "$ENV_FILE" << EOL
BACKEND_URL="${BACKEND_URL}"
FRONT_API_URL="${FRONT_API_URL}"
AGENT_API_TOKEN="${AGENT_TOKEN}"
SERVER_ID="${SERVER_ID}"
NODE_ENV=production
JWT_SECRET=${JWT_SECRET}
APP_DOMAIN=apps.cloudlunacy.uk
AGENT_JWT=${JWT_TOKEN}
EOL

  chown "$USERNAME:$USERNAME" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "Environment configuration completed."
}

main "$@"
