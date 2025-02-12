#!/bin/bash
# ------------------------------------------------------------------------------
# Installation Script for CloudLunacy Deployment Agent and MongoDB with TLS
# Version: 2.7.0 (Updated with MongoDB TLS deployment)
# Author: Mahamadou Taibou (Updated)
# Date: 2025-02-12
#
# Description:
# This script installs and configures the CloudLunacy Deployment Agent on a VPS
# and deploys a MongoDB instance with TLS enabled via Docker Compose.
# Each VPS gets its own MongoDB instance running on its own subdomain.
# ------------------------------------------------------------------------------
set -euo pipefail
IFS=$'\n\t'

# ----------------------------
# Configuration Variables
# ----------------------------
USERNAME="cloudlunacy"
BASE_DIR="/opt/cloudlunacy"

# ----------------------------
# Function Definitions
# ----------------------------

display_info() {
  echo "-------------------------------------------------"
  echo "CloudLunacy Deployment Agent & MongoDB Installation Script"
  echo "Version: 2.7.0 (Updated with MongoDB TLS deployment)"
  echo "Author: Mahamadou Taibou"
  echo "Date: 2025-02-12"
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

  # Install Docker Compose if not available
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

configure_env() {
  log "Configuring environment variables..."
  ENV_FILE="$BASE_DIR/.env"

  cat > "$ENV_FILE" << EOL
BACKEND_URL="${BACKEND_URL:-https://your-default-backend-url}"
AGENT_API_TOKEN="${AGENT_TOKEN}"
SERVER_ID="${SERVER_ID}"
NODE_ENV=production
EOL

  chown "$USERNAME:$USERNAME" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "Environment configuration completed successfully"
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
  sudo -u "$USERNAME" git clone https://github.com/Mayze123/cloudlunacy-deployment-agent.git "$BASE_DIR"
  chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"
  log "Agent cloned to $BASE_DIR."
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
  log "Verifying CloudLunacy Deployment Agent installation..."
  sleep 5
  if systemctl is-active --quiet cloudlunacy; then
    log "CloudLunacy Deployment Agent is running successfully."
  else
    log_error "Agent service failed to start. Check logs with: journalctl -u cloudlunacy"
    return 1
  fi
}

# ----------------------------
# New Function: Setup MongoDB with TLS via Docker Compose
# ----------------------------
setup_mongodb() {
  log "Setting up MongoDB instance with TLS..."
  
  # Define MongoDB directories and files
  MONGODB_BASE_DIR="/opt/cloudlunacy/mongodb"
  MONGODB_COMPOSE_FILE="$MONGODB_BASE_DIR/docker-compose.yml"
  MONGODB_CERT_DIR="/etc/ssl/mongodb"
  
  # Determine the MongoDB subdomain (default: hostname appended with .mongodb.cloudlunacy.uk)
  MONGODB_SUBDOMAIN="${MONGODB_SUBDOMAIN:-$(hostname)}.mongodb.cloudlunacy.uk"
  log "MongoDB will be accessible at: $MONGODB_SUBDOMAIN (ensure your DNS wildcard *.mongodb.cloudlunacy.uk points to this VPS)"
  
  # Create the certificate directory if it does not exist
  if [ ! -d "$MONGODB_CERT_DIR" ]; then
    mkdir -p "$MONGODB_CERT_DIR"
    chmod 700 "$MONGODB_CERT_DIR"
    log "Created certificate directory: $MONGODB_CERT_DIR"
  fi

  # Generate a self-signed TLS certificate if one is not already provided
  if [ ! -f "$MONGODB_CERT_DIR/mongodb.pem" ]; then
    log "TLS certificate not found. Generating a self-signed certificate for $MONGODB_SUBDOMAIN..."
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
      -keyout "$MONGODB_CERT_DIR/mongodb.key" \
      -out "$MONGODB_CERT_DIR/mongodb.crt" \
      -subj "/CN=$MONGODB_SUBDOMAIN"
    # Combine the key and certificate into a single PEM file
    cat "$MONGODB_CERT_DIR/mongodb.key" "$MONGODB_CERT_DIR/mongodb.crt" > "$MONGODB_CERT_DIR/mongodb.pem"
    rm "$MONGODB_CERT_DIR/mongodb.key" "$MONGODB_CERT_DIR/mongodb.crt"
    chmod 600 "$MONGODB_CERT_DIR/mongodb.pem"
    log "Self-signed certificate generated at $MONGODB_CERT_DIR/mongodb.pem"
  else
    log "Existing TLS certificate found at $MONGODB_CERT_DIR/mongodb.pem"
  fi

  # Create the MongoDB base directory for data and compose file
  if [ ! -d "$MONGODB_BASE_DIR" ]; then
    mkdir -p "$MONGODB_BASE_DIR"
    log "Created MongoDB base directory: $MONGODB_BASE_DIR"
  fi

  # Check if a CA certificate exists and set the option accordingly (optional)
  TLS_CA_OPTION=""
  if [ -f "$MONGODB_CERT_DIR/ca.pem" ]; then
    TLS_CA_OPTION="--tlsCAFile /etc/ssl/mongodb/ca.pem"
    log "Found CA certificate at $MONGODB_CERT_DIR/ca.pem; it will be used in MongoDB configuration."
  fi

  # Create the docker-compose file for MongoDB
  log "Creating docker-compose file for MongoDB..."
  cat > "$MONGODB_COMPOSE_FILE" << EOF
version: '3.8'
services:
  mongodb:
    image: mongo:latest
    container_name: mongodb
    restart: unless-stopped
    ports:
      - "27017:27017"
    volumes:
      - ${MONGODB_BASE_DIR}/data:/data/db
      - ${MONGODB_CERT_DIR}:${MONGODB_CERT_DIR}:ro
    command: >
      mongod --tlsMode requireTLS
             --tlsCertificateKeyFile ${MONGODB_CERT_DIR}/mongodb.pem ${TLS_CA_OPTION}
EOF

  log "MongoDB docker-compose file created at $MONGODB_COMPOSE_FILE"

  # Deploy MongoDB using Docker Compose
  log "Deploying MongoDB container..."
  cd "$MONGODB_BASE_DIR"
  docker-compose up -d

  # Verify that the MongoDB container is running
  sleep 5
  if docker ps --filter "name=mongodb" --filter "status=running" | grep mongodb > /dev/null; then
    log "MongoDB is running successfully."
  else
    log_error "MongoDB container failed to start. Check logs with: docker logs mongodb"
  fi
}

# ----------------------------
# Main Function
# ----------------------------
main() {
  check_root
  display_info
  check_args "$@"

  AGENT_TOKEN="$1"
  SERVER_ID="$2"
  BACKEND_BASE_URL="${3:-https://your-default-backend-url}"
  BACKEND_URL="${BACKEND_BASE_URL}"

  detect_os
  update_system
  install_dependencies
  install_docker
  setup_user_directories
  stop_conflicting_containers
  configure_env
  download_agent
  install_agent_dependencies
  setup_docker_permissions
  setup_service
  verify_installation

  # Deploy MongoDB with TLS
  setup_mongodb

  log "Installation completed successfully!"
}

main "$@"