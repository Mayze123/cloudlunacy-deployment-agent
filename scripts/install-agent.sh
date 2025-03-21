#!/bin/bash
# ------------------------------------------------------------------------------
# Installation Script for CloudLunacy Deployment Agent
# Version: 2.6.0 (Simplified without Traefik/TLS)
# Author: Mahamadou Taibou
# Date: 2024-12-01
#
# Description:
# This script installs and configures the CloudLunacy Deployment Agent on a VPS
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
  echo "Version: 2.6.0 (Simplified)"
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

# ------------------------------------------------------------------------------
# New Function: Install MongoDB as a Docker Container
# ------------------------------------------------------------------------------
install_mongo() {
  log "Installing MongoDB container with security enhancements..."

  # Check if a container named "mongodb-agent" exists
  if docker ps -a --format '{{.Names}}' | grep -q '^mongodb-agent$'; then
    log "MongoDB container already exists. Removing it to re-create with proper settings..."
    docker rm -f mongodb-agent || {
      log_error "Failed to remove existing MongoDB container"
      exit 1
    }
  fi

  # Create a secure MongoDB configuration directory
  MONGO_CONFIG_DIR="/opt/cloudlunacy/mongodb"
  mkdir -p $MONGO_CONFIG_DIR

  # Create MongoDB configuration file with security settings
  cat > $MONGO_CONFIG_DIR/mongod.conf << EOL
security:
  authorization: enabled
net:
  bindIp: 0.0.0.0
  port: 27017
  maxIncomingConnections: 100
setParameter:
  failIndexKeyTooLong: false
  authenticationMechanisms: SCRAM-SHA-1,SCRAM-SHA-256
operationProfiling:
  slowOpThresholdMs: 100
  mode: slowOp
EOL

  # Get the server's public IP
  PUBLIC_IP=$(hostname -I | awk '{print $1}')
  log "Using server IP: ${PUBLIC_IP} for MongoDB container"

  # Start MongoDB container without trying to mount the config file
  # We'll use environment variables instead for basic security configuration
  log "Creating and starting MongoDB container with security settings..."
  docker run -d \
    --name mongodb-agent \
    -p ${MONGO_PORT}:27017 \
    -e MONGO_INITDB_ROOT_USERNAME=admin \
    -e MONGO_INITDB_ROOT_PASSWORD=adminpassword \
    mongo:latest \
    --auth || {
    log_error "Failed to start MongoDB container"
    exit 1
  }

  # Wait for MongoDB to start up
  log "Waiting for MongoDB to start up..."
  sleep 5

  # Verify MongoDB is running
  if docker ps | grep -q "mongodb-agent"; then
    log "MongoDB container is running successfully."
  else
    log_error "MongoDB container failed to start properly."
    docker logs mongodb-agent
    exit 1
  fi
}

fetch_certificates() {
  log "Fetching TLS certificates from front server..."

  # Create certificates directory
  mkdir -p "${CERTS_DIR}"
  chmod 700 "${CERTS_DIR}"

  # Get JWT token from the saved file
  JWT_FILE="${BASE_DIR}/.agent_jwt.json"
  if [ ! -f "$JWT_FILE" ]; then
    log_error "JWT file not found. Cannot fetch certificates."
    return 1
  fi

  TOKEN=$(jq -r '.token' "$JWT_FILE")
  if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    log_error "Invalid JWT token. Cannot fetch certificates."
    return 1
  fi

  # Fetch CA certificate
  log "Fetching CA certificate..."
  CA_CERT_RESPONSE=$(curl -s "${FRONT_API_URL}/api/certificates/mongodb-ca")
  if [ $? -ne 0 ] || [ -z "$CA_CERT_RESPONSE" ]; then
    log_error "Failed to fetch CA certificate"
    return 1
  fi

  # Save CA certificate
  echo "$CA_CERT_RESPONSE" > "${CERTS_DIR}/ca.crt"

  # Fetch agent certificates
  log "Fetching agent certificates..."
  CERT_RESPONSE=$(curl -s -H "Authorization: Bearer $TOKEN" "${FRONT_API_URL}/api/certificates/agent/${SERVER_ID}")

  # Debug output
  log "Certificate response: $(echo "$CERT_RESPONSE" | grep -v serverKey | grep -v serverCert)"

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

  # Extract certificates from JSON response
  SERVER_KEY=$(echo "$CERT_RESPONSE" | jq -r '.certificates.serverKey')
  SERVER_CERT=$(echo "$CERT_RESPONSE" | jq -r '.certificates.serverCert')

  if [ "$SERVER_KEY" = "null" ] || [ "$SERVER_CERT" = "null" ] || [ -z "$SERVER_KEY" ] || [ -z "$SERVER_CERT" ]; then
    log_error "Invalid certificate data in response"
    return 1
  fi

  # Save certificates
  echo "$SERVER_KEY" > "${CERTS_DIR}/server.key"
  echo "$SERVER_CERT" > "${CERTS_DIR}/server.crt"

  # Create combined PEM file for MongoDB
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

install_mongo_with_tls() {
  log "Installing MongoDB container with TLS support..."

  # Create a secure MongoDB configuration directory
  MONGO_CONFIG_DIR="/opt/cloudlunacy/mongodb"
  mkdir -p $MONGO_CONFIG_DIR
  mkdir -p $MONGO_CONFIG_DIR/certs

  # Copy certificates to MongoDB config directory
  cp $CERTS_DIR/ca.crt $MONGO_CONFIG_DIR/certs/
  cp $CERTS_DIR/server.key $MONGO_CONFIG_DIR/certs/
  cp $CERTS_DIR/server.crt $MONGO_CONFIG_DIR/certs/

  # Create combined PEM file for MongoDB
  cat $CERTS_DIR/server.key $CERTS_DIR/server.crt > $MONGO_CONFIG_DIR/certs/server.pem

  # Set proper permissions on the PEM file and adjust ownership.
  chmod 600 $MONGO_CONFIG_DIR/certs/server.pem
  # Change ownership to UID and GID 999 (default mongodb user in the official image)
  chown -R 999:999 $MONGO_CONFIG_DIR/certs

  # Check if a container named "mongodb-agent" exists and remove it if needed
  if docker ps -a --format '{{.Names}}' | grep -q '^mongodb-agent$'; then
    log "MongoDB container already exists. Removing it to re-create with proper settings..."
    docker rm -f mongodb-agent || {
      log_error "Failed to remove existing MongoDB container"
      exit 1
    }
  fi

  # Create MongoDB configuration file with TLS settings
  cat > $MONGO_CONFIG_DIR/mongod.conf << EOL
security:
  authorization: enabled
net:
  bindIp: 0.0.0.0
  port: 27017
  maxIncomingConnections: 100
  tls:
    mode: requireTLS
    certificateKeyFile: /etc/mongodb/certs/server.pem
    CAFile: /etc/mongodb/certs/ca.crt
    allowConnectionsWithoutCertificates: true
setParameter:
  authenticationMechanisms: SCRAM-SHA-1,SCRAM-SHA-256
operationProfiling:
  slowOpThresholdMs: 100
  mode: slowOp
EOL

  # Get the server's public IP
  PUBLIC_IP=$(hostname -I | awk '{print $1}')
  log "Using server IP: ${PUBLIC_IP} for MongoDB container"

  # Start MongoDB container with TLS configuration
  log "Creating and starting MongoDB container with TLS settings..."
  docker run -d \
    --name mongodb-agent \
    -p ${MONGO_PORT}:27017 \
    -v "${MONGO_CONFIG_DIR}/mongod.conf:/etc/mongod.conf" \
    -v "${MONGO_CONFIG_DIR}/certs:/etc/mongodb/certs" \
    -e MONGO_INITDB_ROOT_USERNAME=admin \
    -e MONGO_INITDB_ROOT_PASSWORD=adminpassword \
    mongo:latest \
    --config /etc/mongod.conf \
    --tlsMode=requireTLS \
    --tlsCertificateKeyFile=/etc/mongodb/certs/server.pem \
    --tlsCAFile=/etc/mongodb/certs/ca.crt \
    --tlsAllowConnectionsWithoutCertificates \
    --auth || {
    log_error "Failed to start MongoDB container"
    exit 1
  }

  # Wait for MongoDB to start up
  log "Waiting for MongoDB to start up..."
  sleep 5

  # Verify MongoDB is running
  if docker ps | grep -q "mongodb-agent"; then
    log "MongoDB container is running successfully with TLS."
  else
    log_error "MongoDB container failed to start properly."
    docker logs mongodb-agent
    exit 1
  fi
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

  RESPONSE=$(curl -s -X POST "${FRONT_API_URL}/api/agent/register" \
    -H "Content-Type: application/json" \
    -H "X-Agent-IP: ${LOCAL_IP}" \
    -d "{\"agentId\": \"${SERVER_ID}\" }")

  if echo "$RESPONSE" | grep -q "token"; then
    log "Agent registered successfully. Response: $RESPONSE"

    # Extract MongoDB URL from response if available
    MONGO_URL=$(echo "$RESPONSE" | grep -o '"mongodbUrl":"[^"]*"' | cut -d'"' -f4 || echo "")
    if [ -n "$MONGO_URL" ]; then
      log "MongoDB will be accessible at: $MONGO_URL"
    fi

    # Save the JWT to a file (separate from any static AGENT_API_TOKEN)
    JWT_FILE="/opt/cloudlunacy/.agent_jwt.json"
    echo "$RESPONSE" | jq . > "$JWT_FILE"
    chmod 600 "$JWT_FILE"
    # Change ownership to the cloudlunacy user
    chown $USERNAME:$USERNAME "$JWT_FILE"
    log "JWT file permissions updated for $USERNAME user"
  else
    log "Agent registration failed. Response: $RESPONSE"
    log_error "Agent registration failed. Response: $RESPONSE"
    exit 1
  fi
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
MONGO_MANAGER_USERNAME=admin
MONGO_MANAGER_PASSWORD=adminpassword
MONGO_DOMAIN=mongodb.cloudlunacy.uk
APP_DOMAIN=apps.cloudlunacy.uk
MONGO_USE_TLS=true
MONGO_CERT_PATH=${CERTS_DIR}/server.crt
MONGO_KEY_PATH=${CERTS_DIR}/server.key
MONGO_CA_PATH=${CERTS_DIR}/ca.crt
EOL

  chown "$USERNAME:$USERNAME" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "Environment configuration completed successfully."
}

setup_user_directories() {
  log "Creating dedicated user and directories..."
  if id "$USERNAME" &> /dev/null; then
    log "User '$USERNAME' already exists."
  else
    useradd -m -d "$BASE_DIR" -r -s /bin/bash "$USERNAME"
    log "User '$USERNAME' created."
  fi

  mkdir -p "$BASE_DIR"
  chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"
  chmod -R 750 "$BASE_DIR"

  log "Directories created at $BASE_DIR."
}

download_agent() {
  log "Cloning the CloudLunacy Deployment Agent repository..."

  # Remove existing directory if it exists
  if [ -d "$BASE_DIR" ]; then
    log "Directory $BASE_DIR already exists. Removing it for a fresh clone..."
    rm -rf "$BASE_DIR" || {
      log_error "Failed to remove directory $BASE_DIR"
      exit 1
    }
  fi

  # Clone the repository as root (since root can write to /opt)
  git clone https://github.com/Mayze123/cloudlunacy-deployment-agent.git "$BASE_DIR" \
    || {
      log_error "Failed to clone repository"
      exit 1
    }

  # Change ownership of the cloned repository to the dedicated user
  chown -R "$USERNAME":"$USERNAME" "$BASE_DIR" \
    || {
      log_error "Failed to set ownership on $BASE_DIR"
      exit 1
    }

  log "Agent repository is freshly cloned at $BASE_DIR."
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
Description=CloudLunacy Deployment Agent
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=$USERNAME
Group=docker
WorkingDirectory=$BASE_DIR
EnvironmentFile=$BASE_DIR/.env
ExecStart=/usr/bin/node --trace-warnings $BASE_DIR/agent.js
Restart=always
RestartSec=10
StandardOutput=append:$LOG_DIR/app.log
StandardError=append:$LOG_DIR/error.log

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
    log "CloudLunacy Deployment Agent is running successfully."
  else
    log_error "Service failed to start. Check logs with: journalctl -u cloudlunacy"
    return 1
  fi
}

main() {
  check_root
  display_info
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

  # Install MongoDB with TLS support
  install_mongo_with_tls

  # Configure environment with TLS settings
  configure_env

  # Setup service and verify installation
  setup_service
  verify_installation

  log "Installation completed successfully!"
}

main "$@"
