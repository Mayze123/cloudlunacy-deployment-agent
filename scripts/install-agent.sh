#!/bin/bash
# ------------------------------------------------------------------------------
# Installation Script for CloudLunacy Deployment Agent with MongoDB
# Version: 2.6.0 (Simplified without Traefik/TLS)
# Author: Mahamadou Taibou
# Date: 2024-12-01
#
# Description:
# This script installs and configures the CloudLunacy Deployment Agent on a VPS.
# Key changes from previous version:
#   - Removed all Traefik-related configurations
#   - Simplified MongoDB setup without TLS
#   - Removed certificate management dependencies
# ------------------------------------------------------------------------------

set -euo pipefail
IFS=$'\n\t'

# ----------------------------
# Configuration Variables
# ----------------------------
USERNAME="cloudlunacy"
BASE_DIR="/opt/cloudlunacy"
MONGODB_DIR="$BASE_DIR/mongodb"
MONGO_ENV_FILE="$MONGODB_DIR/.env"

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

generate_mongo_credentials() {
  log "Generating MongoDB credentials..."
  MONGO_INITDB_ROOT_USERNAME=$(openssl rand -hex 12)
  MONGO_INITDB_ROOT_PASSWORD=$(openssl rand -hex 24)
  MONGO_MANAGER_USERNAME="manager"
  MONGO_MANAGER_PASSWORD=$(openssl rand -hex 24)

  cat << EOF > "$MONGO_ENV_FILE"
MONGO_INITDB_ROOT_USERNAME=${MONGO_INITDB_ROOT_USERNAME}
MONGO_INITDB_ROOT_PASSWORD=${MONGO_INITDB_ROOT_PASSWORD}
MONGO_MANAGER_USERNAME=${MONGO_MANAGER_USERNAME}
MONGO_MANAGER_PASSWORD=${MONGO_MANAGER_PASSWORD}
EOF

  chown "$USERNAME":"$USERNAME" "$MONGO_ENV_FILE"
  chmod 600 "$MONGO_ENV_FILE"
  set +u
  source "$MONGO_ENV_FILE"
  set -u
}

setup_mongodb() {
  log "Setting up MongoDB with authentication sequence..."

  mkdir -p "$MONGODB_DIR"
  chown "$USERNAME":"$USERNAME" "$MONGODB_DIR"

  # Step 1: Start MongoDB without auth for initial setup
  log "Step 1: Starting MongoDB without auth..."
  cat << COMPOSE > "$MONGODB_DIR/docker-compose.mongodb.yml"
version: '3.8'
services:
  mongodb:
    image: mongo:6.0
    container_name: mongodb
    restart: unless-stopped
    command: mongod --bind_ip_all
    volumes:
      - mongo_data:/data/db
    networks:
      - internal
    healthcheck:
      test: [ "CMD", "mongosh", "--eval", "db.adminCommand('ping')" ]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 20s
volumes:
  mongo_data:
networks:
  internal:
COMPOSE

  cd "$MONGODB_DIR"
  sudo -u "$USERNAME" docker-compose -f docker-compose.mongodb.yml down -v
  sudo -u "$USERNAME" docker-compose -f docker-compose.mongodb.yml up -d

  # Wait for MongoDB to be healthy
  log "Waiting for MongoDB to be healthy..."
  local max_attempts=10
  local attempt=1
  while [ $attempt -le $max_attempts ]; do
    if docker ps --filter "name=mongodb" --format "{{.Status}}" | grep -q "healthy"; then
      log "MongoDB container is healthy"
      break
    fi
    log "Waiting for MongoDB to be healthy (attempt $attempt/$max_attempts)..."
    sleep 5
    attempt=$((attempt + 1))
  done

  # Generate credentials (if not already generated)
  generate_mongo_credentials

  # Step 2: Create root user
  log "Step 2: Creating root user..."
  docker exec mongodb mongosh --quiet << EOF
db.getSiblingDB('admin').createUser({
  user: "${MONGO_INITDB_ROOT_USERNAME}",
  pwd: "${MONGO_INITDB_ROOT_PASSWORD}",
  roles: ['root']
});
EOF

  # Step 3: Restart MongoDB with authentication enabled
  log "Step 3: Restarting MongoDB with auth..."
  cat << COMPOSE > "$MONGODB_DIR/docker-compose.mongodb.yml"
version: '3.8'
services:
  mongodb:
    image: mongo:6.0
    container_name: mongodb
    restart: unless-stopped
    environment:
      MONGO_INITDB_ROOT_USERNAME: "${MONGO_INITDB_ROOT_USERNAME}"
      MONGO_INITDB_ROOT_PASSWORD: "${MONGO_INITDB_ROOT_PASSWORD}"
    command: mongod --auth --bind_ip_all
    volumes:
      - mongo_data:/data/db
    healthcheck:
      test: [ "CMD", "mongosh", "-u", "${MONGO_INITDB_ROOT_USERNAME}", "-p", "${MONGO_INITDB_ROOT_PASSWORD}", "--eval", "db.adminCommand('ping')" ]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 20s
volumes:
  mongo_data:
COMPOSE

  sudo -u "$USERNAME" docker-compose --env-file "$MONGO_ENV_FILE" -f docker-compose.mongodb.yml down -v
  sudo -u "$USERNAME" docker-compose --env-file "$MONGO_ENV_FILE" -f docker-compose.mongodb.yml up -d

  # Verify secure connection
  log "Verifying secure MongoDB connection..."
  for i in {1..5}; do
    if
      docker exec mongodb mongosh --quiet \
        -u "${MONGO_INITDB_ROOT_USERNAME}" \
        -p "${MONGO_INITDB_ROOT_PASSWORD}" \
        --authenticationDatabase admin \ 
      --eval "db.adminCommand('ping')"
    then
      log "MongoDB setup completed successfully"
      return 0
    fi
    log "Connection attempt $i failed, retrying..."
    sleep 5
  done

  log_error "Failed to verify secure MongoDB connection"
  docker logs mongodb
  return 1
}

create_mongo_management_user() {
  log "Creating/updating MongoDB management user..."

  # Load environment variables
  if [ ! -f "$MONGO_ENV_FILE" ]; then
    log_error "Missing MongoDB environment file"
    return 1
  fi
  source "$MONGO_ENV_FILE"

  # Wait for MongoDB to be fully ready
  log "Waiting for MongoDB to stabilize..."
  sleep 15 # Increased initial wait time
  if ! docker exec mongodb mongosh --quiet \
    -u "${MONGO_INITDB_ROOT_USERNAME}" \
    -p "${MONGO_INITDB_ROOT_PASSWORD}" \
    --authenticationDatabase admin \
    --eval "db.adminCommand('ping')" > /dev/null 2>&1; then
    log_error "MongoDB not responding to root user"
    docker logs mongodb
    return 1
  fi

  # Create management user with full privileges
  log "Creating management user..."
  docker exec mongodb mongosh --quiet \
    -u "${MONGO_INITDB_ROOT_USERNAME}" \
    -p "${MONGO_INITDB_ROOT_PASSWORD}" \
    --authenticationDatabase admin << EOF
use admin
db.createUser({
    user: "${MONGO_MANAGER_USERNAME}",
    pwd: "${MONGO_MANAGER_PASSWORD}",
    roles: [
        {role: 'userAdminAnyDatabase', db: 'admin'},
        {role: 'readWriteAnyDatabase', db: 'admin'},
        {role: 'clusterMonitor', db: 'admin'},
        {role: 'dbAdminAnyDatabase', db: 'admin'},
        {role: 'root', db: 'admin'}
    ]
})
EOF

  # Verify user creation
  local verify_attempts=5
  for ((i = 1; i <= verify_attempts; i++)); do
    log "Verification attempt $i/$verify_attempts"
    if docker exec mongodb mongosh --quiet \
      -u "${MONGO_MANAGER_USERNAME}" \
      -p "${MONGO_MANAGER_PASSWORD}" \
      --authenticationDatabase admin \
      --eval "db.adminCommand('ping')"; then
      log "Management user verified successfully"

      # Remove temporary root role
      docker exec mongodb mongosh --quiet \
        -u "${MONGO_INITDB_ROOT_USERNAME}" \
        -p "${MONGO_INITDB_ROOT_PASSWORD}" \
        --authenticationDatabase admin << EOF
use admin
db.updateUser("${MONGO_MANAGER_USERNAME}", {
    roles: [
        {role: 'userAdminAnyDatabase', db: 'admin'},
        {role: 'readWriteAnyDatabase', db: 'admin'},
        {role: 'clusterMonitor', db: 'admin'},
        {role: 'dbAdminAnyDatabase', db: 'admin'}
    ]
})
EOF
      return 0
    fi
    log "Attempt $i failed, retrying in 5 seconds..."
    sleep 5
  done

  log_error "Permanent failure: Management user authentication failed"
  log_error "Final verification attempt output:"
  docker exec mongodb mongosh --quiet \
    -u "${MONGO_MANAGER_USERNAME}" \
    -p "${MONGO_MANAGER_PASSWORD}" \
    --authenticationDatabase admin \
    --eval "db.adminCommand('ping')"
  return 1
}

configure_env() {
  log "Configuring environment variables..."
  ENV_FILE="$BASE_DIR/.env"

  cat > "$ENV_FILE" << EOL
BACKEND_URL="${BACKEND_URL:-https://your-default-backend-url}"
AGENT_API_TOKEN="${AGENT_TOKEN}"
SERVER_ID="${SERVER_ID}"
MONGO_MANAGER_USERNAME="${MONGO_MANAGER_USERNAME}"
MONGO_MANAGER_PASSWORD="${MONGO_MANAGER_PASSWORD}"
MONGO_HOST="localhost"
MONGO_PORT=27017
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
  log "Verifying installation..."
  sleep 5
  if systemctl is-active --quiet cloudlunacy; then
    log "CloudLunacy Deployment Agent is running successfully."
  else
    log_error "Service failed to start. Check logs with: journalctl -u cloudlunacy"
    return 1
  fi
}

display_mongodb_credentials() {
  log "MongoDB Management User Credentials:"
  echo "----------------------------------------"
  echo "Username: $MONGO_MANAGER_USERNAME"
  echo "Password: $MONGO_MANAGER_PASSWORD"
  echo "Host: localhost"
  echo "Port: 27017"
  echo "----------------------------------------"
}

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
  setup_mongodb
  create_mongo_management_user
  configure_env
  download_agent
  install_agent_dependencies
  setup_docker_permissions
  setup_service
  verify_installation
  display_mongodb_credentials

  log "Installation completed successfully!"
}

main "$@"
