#!/bin/bash
# ------------------------------------------------------------------------------
# Installation Script for CloudLunacy Deployment Agent with MongoDB (Front Server Mode)
# Version: 3.0.0
# Author: Mahamadou Taibou (modified by you)
# Date: 2024-11-24 (modified for front server integration)
#
# Description:
# This script installs and configures the CloudLunacy Deployment Agent on a VPS.
# It performs the following tasks:
#   - Detects the operating system and version
#   - Updates system packages
#   - Installs necessary dependencies (Docker, Node.js, Git, jq, lsof)
#   - Sets up MongoDB in two phases:
#       Phase 1: No auth -> root user is created
#       Phase 2: Enable auth (without TLS) -> health check passes with credentials
#   - Creates a dedicated user with correct permissions
#   - Downloads the latest version of the Deployment Agent from GitHub
#   - Installs Node.js dependencies
#   - Configures environment variables
#   - Sets up the Deployment Agent as a systemd service
#   - Provides post-installation verification and feedback
#
# Usage:
#   sudo ./install-agent.sh <AGENT_TOKEN> <SERVER_ID> <EMAIL> [BACKEND_BASE_URL]
#
# Arguments:
#   AGENT_TOKEN      - Unique token for agent authentication
#   SERVER_ID        - Unique identifier for the server
#   EMAIL            - (Not used in this version, kept for backward compatibility)
#   BACKEND_BASE_URL - (Optional) Backend base URL; defaults to https://your-default-backend-url
# ------------------------------------------------------------------------------

set -euo pipefail
# Uncomment the following line to enable debugging
#set -x
IFS=$'\n\t'

# ----------------------------
# Configuration Variables
# ----------------------------
# For front server mode, DOMAIN represents the (sub)domain that will be used
# by the front server to route traffic.
DOMAIN="mongodb.cloudlunacy.uk"
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
  echo "Version: 3.0.0 (Front Server Mode)"
  echo "Author: Mahamadou Taibou (modified)"
  echo "Date: 2024-11-24"
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
  if [ "$#" -lt 3 ] || [ "$#" -gt 5 ]; then
    log_error "Invalid number of arguments."
    echo "Usage: $0 <AGENT_TOKEN> <SERVER_ID> <EMAIL> [BACKEND_BASE_URL]"
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
  log "Checking for Docker containers using port 80..."
  CONTAINER_ID=$(docker ps -q --filter "publish=80")
  if [ -n "$CONTAINER_ID" ]; then
    log "Stopping container using port 80 (ID: $CONTAINER_ID)..."
    docker stop "$CONTAINER_ID"
    docker rm "$CONTAINER_ID"
    log "Container stopped and removed."
  else
    log "No Docker containers are using port 80."
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
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS_TYPE $(lsb_release -cs) stable" \
          | tee /etc/apt/sources.list.d/docker.list > /dev/null
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

install_mongosh() {
  log "Pulling MongoDB Shell Docker image..."
  docker pull mongodb/mongodb-community-server:6.0-ubi8
  log "MongoDB Shell Docker image pulled."
}

# ----------------------------
# MongoDB Setup (Two-Phase, Without TLS)
# ----------------------------
generate_mongo_credentials() {
  log "Generating MongoDB credentials..."

  # Create random credentials
  MONGO_INITDB_ROOT_USERNAME=$(openssl rand -hex 12)
  MONGO_INITDB_ROOT_PASSWORD=$(openssl rand -hex 24)
  MONGO_MANAGER_USERNAME="manager"
  MONGO_MANAGER_PASSWORD=$(openssl rand -hex 24)

  # Write them to the Mongo .env file
  cat << EOF > "$MONGO_ENV_FILE"
MONGO_INITDB_ROOT_USERNAME=$MONGO_INITDB_ROOT_USERNAME
MONGO_INITDB_ROOT_PASSWORD=$MONGO_INITDB_ROOT_PASSWORD
MONGO_MANAGER_USERNAME=$MONGO_MANAGER_USERNAME
MONGO_MANAGER_PASSWORD=$MONGO_MANAGER_PASSWORD
EOF

  chown "$USERNAME":"$USERNAME" "$MONGO_ENV_FILE"
  chmod 600 "$MONGO_ENV_FILE"

  # Source them so subsequent commands can use them
  set +u
  source "$MONGO_ENV_FILE"
  set -u
}

setup_mongodb() {
  log "Setting up MongoDB with authentication sequence..."

  mkdir -p "$MONGODB_DIR"
  chown "$USERNAME":"$USERNAME" "$MONGODB_DIR"

  # Phase 1: Start MongoDB without auth
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
      internal:
        aliases:
          - $DOMAIN
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
    external: true
COMPOSE

  cd "$MONGODB_DIR"
  sudo -u "$USERNAME" docker-compose -f docker-compose.mongodb.yml down -v
  sudo -u "$USERNAME" docker-compose -f docker-compose.mongodb.yml up -d

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

  # Generate credentials and source them
  generate_mongo_credentials

  # Phase 2: Create root user (without auth) then restart with auth enabled
  log "Step 2: Creating root user..."
  # For this phase, generate new random credentials for root user
  MONGO_INITDB_ROOT_USERNAME=$(openssl rand -hex 12)
  MONGO_INITDB_ROOT_PASSWORD=$(openssl rand -hex 24)
  if ! docker exec mongodb mongosh --eval "
        db.getSiblingDB('admin').createUser({
            user: '$MONGO_INITDB_ROOT_USERNAME',
            pwd: '$MONGO_INITDB_ROOT_PASSWORD',
            roles: ['root']
        })
    "; then
    log_error "Failed to create root user"
    docker logs mongodb
    return 1
  fi

  # Save root credentials to the env file
  cat << EOF > "$MONGO_ENV_FILE"
MONGO_INITDB_ROOT_USERNAME=$MONGO_INITDB_ROOT_USERNAME
MONGO_INITDB_ROOT_PASSWORD=$MONGO_INITDB_ROOT_PASSWORD
EOF

  chown "$USERNAME":"$USERNAME" "$MONGO_ENV_FILE"
  chmod 600 "$MONGO_ENV_FILE"

  log "Step 3: Restarting MongoDB with auth..."
  cat << COMPOSE > "$MONGODB_DIR/docker-compose.mongodb.yml"
version: '3.8'
services:
  mongodb:
    image: mongo:6.0
    container_name: mongodb
    restart: unless-stopped
    environment:
      MONGO_INITDB_ROOT_USERNAME: "\${MONGO_INITDB_ROOT_USERNAME}"
      MONGO_INITDB_ROOT_PASSWORD: "\${MONGO_INITDB_ROOT_PASSWORD}"
    command: mongod --auth --bind_ip_all
    ports:
      - "27017:27017"
    volumes:
      - mongo_data:/data/db
    networks:
      internal:
        aliases:
          - $DOMAIN
    healthcheck:
      test: [ "CMD", "mongosh", "--host", "localhost", "-u", "\${MONGO_INITDB_ROOT_USERNAME}", "-p", "\${MONGO_INITDB_ROOT_PASSWORD}", "--eval", "db.adminCommand('ping')" ]
      interval: 5s
      timeout: 5s
      retries: 3
      start_period: 10s
volumes:
  mongo_data:
networks:
  internal:
    external: true
COMPOSE

  sudo -u "$USERNAME" docker-compose --env-file "$MONGO_ENV_FILE" -f docker-compose.mongodb.yml down -v
  sudo -u "$USERNAME" docker-compose --env-file "$MONGO_ENV_FILE" -f docker-compose.mongodb.yml up -d

  log "Waiting for secure MongoDB to be healthy..."
  attempt=1
  while [ $attempt -le $max_attempts ]; do
    if docker ps --filter "name=mongodb" --format "{{.Status}}" | grep -q "healthy"; then
      log "Secure MongoDB container is healthy"
      break
    fi
    log "Waiting for secure MongoDB to be healthy (attempt $attempt/$max_attempts)..."
    docker logs --tail 10 mongodb
    sleep 10
    attempt=$((attempt + 1))
  done
  if [ $attempt -gt $max_attempts ]; then
    log_error "Secure MongoDB failed to become healthy"
    docker logs mongodb
    return 1
  fi

  log "Verifying secure MongoDB connection..."
  for i in {1..5}; do
    if docker exec mongodb mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --eval "db.adminCommand('ping')"; then
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

  if [ ! -f "$MONGO_ENV_FILE" ]; then
    log_error "MongoDB environment file not found at $MONGO_ENV_FILE"
    return 1
  fi

  set +u
  source "$MONGO_ENV_FILE"
  set -u

  if [ -z "${MONGO_INITDB_ROOT_USERNAME:-}" ] || [ -z "${MONGO_INITDB_ROOT_PASSWORD:-}" ]; then
    log_error "Root credentials not found in environment file"
    return 1
  fi

  local max_retries=3
  local retry_count=0
  while [ $retry_count -lt $max_retries ]; do
    if docker exec mongodb mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --eval "db.adminCommand('ping')"; then
      break
    fi
    log "Waiting for MongoDB to be ready (attempt $((retry_count + 1))/$max_retries)..."
    sleep 10
    retry_count=$((retry_count + 1))
  done
  if [ $retry_count -eq $max_retries ]; then
    log_error "Failed to connect to MongoDB after $max_retries attempts"
    return 1
  fi

  # Set management user constants (manager is fixed)
  MONGO_MANAGER_USERNAME="manager"
  # Generate a new password regardless of whether we are creating or updating
  MONGO_MANAGER_PASSWORD=$(openssl rand -hex 24)

  user_exists=$(docker exec mongodb mongosh --quiet \
    -u "$MONGO_INITDB_ROOT_USERNAME" \
    -p "$MONGO_INITDB_ROOT_PASSWORD" \
    --eval "db.getSiblingDB('admin').getUser('$MONGO_MANAGER_USERNAME')" \
    --quiet)

  if [ "$user_exists" = "null" ] || [ -z "$user_exists" ]; then
    log "Creating new management user..."
    if ! docker exec mongodb mongosh --quiet \
      -u "$MONGO_INITDB_ROOT_USERNAME" \
      -p "$MONGO_INITDB_ROOT_PASSWORD" \
      --eval "db.getSiblingDB('admin').createUser({
                user: '$MONGO_MANAGER_USERNAME',
                pwd: '$MONGO_MANAGER_PASSWORD',
                roles: [
                    {role: 'userAdminAnyDatabase', db: 'admin'},
                    {role: 'readWriteAnyDatabase', db: 'admin'},
                    {role: 'clusterMonitor', db: 'admin'}
                ]
            })"; then
      log_error "Failed to create management user"
      return 1
    fi
  else
    log "Updating existing management user password..."
    if ! docker exec mongodb mongosh --quiet \
      -u "$MONGO_INITDB_ROOT_USERNAME" \
      -p "$MONGO_INITDB_ROOT_PASSWORD" \
      --eval "db.getSiblingDB('admin').updateUser('$MONGO_MANAGER_USERNAME', {
                pwd: '$MONGO_MANAGER_PASSWORD',
                roles: [
                    {role: 'userAdminAnyDatabase', db: 'admin'},
                    {role: 'readWriteAnyDatabase', db: 'admin'},
                    {role: 'clusterMonitor', db: 'admin'}
                ]
            })"; then
      log_error "Failed to update management user"
      return 1
    fi
  fi

  log "Updating environment file with credentials..."
  {
    echo "MONGO_INITDB_ROOT_USERNAME=$MONGO_INITDB_ROOT_USERNAME"
    echo "MONGO_INITDB_ROOT_PASSWORD=$MONGO_INITDB_ROOT_PASSWORD"
    echo "MONGO_MANAGER_USERNAME=$MONGO_MANAGER_USERNAME"
    echo "MONGO_MANAGER_PASSWORD=$MONGO_MANAGER_PASSWORD"
  } > "$MONGO_ENV_FILE"

  chown "$USERNAME":"$USERNAME" "$MONGO_ENV_FILE"
  chmod 600 "$MONGO_ENV_FILE"

  log "Verifying management user access..."
  if ! docker exec mongodb mongosh --quiet -u "$MONGO_MANAGER_USERNAME" -p "$MONGO_MANAGER_PASSWORD" --eval "db.adminCommand('ping')"; then
    log_error "Failed to verify management user access"
    return 1
  fi

  log "Management user setup completed successfully"
  return 0
}

adjust_firewall_settings() {
  log "Adjusting firewall settings..."
  TRUSTED_IP="128.140.53.203"
  if command -v ufw > /dev/null 2>&1; then
    ufw allow from $TRUSTED_IP to any port 27017 proto tcp
    log "Allowed port 27017 for trusted IP $TRUSTED_IP."
  else
    iptables -A INPUT -p tcp -s $TRUSTED_IP --dport 27017 -j ACCEPT
    log "Allowed port 27017 for trusted IP $TRUSTED_IP via iptables."
  fi
  log "Firewall settings adjusted."
}

configure_env() {
  log "Configuring environment variables..."
  ENV_FILE="$BASE_DIR/.env"

  mkdir -p "$BASE_DIR"

  if [ ! -f "$MONGO_ENV_FILE" ]; then
    log_error "MongoDB environment file not found at $MONGO_ENV_FILE"
    return 1
  fi

  set +u
  source "$MONGO_ENV_FILE"
  set -u

  if [ -z "${MONGO_MANAGER_USERNAME:-}" ] || [ -z "${MONGO_MANAGER_PASSWORD:-}" ]; then
    log_error "MongoDB manager credentials not found in environment file"
    return 1
  fi

  log "Verifying MongoDB manager credentials..."
  if ! docker exec mongodb mongosh --quiet \
    -u "${MONGO_MANAGER_USERNAME}" \
    -p "${MONGO_MANAGER_PASSWORD}" \
    --eval "db.adminCommand('ping')" &> /dev/null; then
    log_error "Failed to verify MongoDB manager credentials"
    return 1
  fi

  log "MongoDB manager credentials verified successfully"

  cat > "$ENV_FILE" << EOL
BACKEND_URL="${BACKEND_URL:-https://your-default-backend-url}"
AGENT_API_TOKEN="${AGENT_TOKEN}"
SERVER_ID="${SERVER_ID}"
MONGO_MANAGER_USERNAME="${MONGO_MANAGER_USERNAME}"
MONGO_MANAGER_PASSWORD="${MONGO_MANAGER_PASSWORD}"
MONGO_HOST="$DOMAIN"
MONGO_PORT=27017
NODE_ENV=production
EOL

  chown "$USERNAME:$USERNAME" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  if [ ! -s "$ENV_FILE" ]; then
    log_error "Environment file is empty or not created properly"
    return 1
  fi

  local required_vars=("MONGO_MANAGER_USERNAME" "MONGO_MANAGER_PASSWORD" "MONGO_HOST")
  for var in "${required_vars[@]}"; do
    if ! grep -q "^${var}=" "$ENV_FILE"; then
      log_error "Missing required variable ${var} in environment file"
      return 1
    fi
  done

  log "Environment configuration completed successfully"
  return 0
}

display_mongodb_credentials() {
  log "MongoDB Management User Credentials:"
  log "----------------------------------------"
  echo "Management Username: $MONGO_MANAGER_USERNAME"
  echo "Management Password: $MONGO_MANAGER_PASSWORD"
  echo "MongoDB Host: $DOMAIN"
  echo "MongoDB Port: 27017"
  log "----------------------------------------"
  log "These credentials are stored securely in $MONGO_ENV_FILE"
  log "Do not share them publicly."
}

setup_user_directories() {
  log "Creating dedicated user and directories..."
  if id "$USERNAME" &> /dev/null; then
    log "User '$USERNAME' already exists."
    usermod -d "$BASE_DIR" "$USERNAME"
  else
    useradd -m -d "$BASE_DIR" -r -s /bin/bash "$USERNAME"
    log "User '$USERNAME' created."
  fi

  mkdir -p "$BASE_DIR"
  chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"
  chmod -R 750 "$BASE_DIR"

  mkdir -p "$BASE_DIR"/{logs,ssh,config,bin,deployments}
  chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"/{logs,ssh,config,bin,deployments}

  log "Directories created at $BASE_DIR."
}

download_agent() {
  log "Cloning the CloudLunacy Deployment Agent repository..."
  if [ -d "$BASE_DIR" ]; then
    rm -rf "$BASE_DIR"
  fi
  mkdir -p "$BASE_DIR"
  chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"

  sudo -u "$USERNAME" git clone https://github.com/Mayze123/cloudlunacy-deployment-agent.git "$BASE_DIR"
  chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"
  log "Agent cloned to $BASE_DIR."
}

install_agent_dependencies() {
  log "Installing agent dependencies..."
  cd "$BASE_DIR"
  rm -rf node_modules package-lock.json
  NPM_CACHE_DIR="$BASE_DIR/.npm-cache"
  mkdir -p "$NPM_CACHE_DIR"
  chown -R "$USERNAME":"$USERNAME" "$NPM_CACHE_DIR"
  if [ -f "package.json" ]; then
    sudo -u "$USERNAME" HOME="$BASE_DIR" npm install --cache "$NPM_CACHE_DIR" --no-fund --no-audit
  else
    sudo -u "$USERNAME" HOME="$BASE_DIR" npm init -y
    sudo -u "$USERNAME" HOME="$BASE_DIR" npm install axios dotenv winston mongodb joi shelljs ws handlebars js-yaml --cache "$NPM_CACHE_DIR" --no-fund --no-audit
  fi
  log "Agent dependencies installed."
}

setup_docker_permissions() {
  log "Setting up Docker permissions..."
  usermod -aG docker "$USERNAME"
  chown -R "$USERNAME":docker "$BASE_DIR"
  chmod -R 775 "$BASE_DIR/deployments"
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

  touch "$LOG_DIR/app.log" "$LOG_DIR/error.log"
  chown "$USERNAME:$USERNAME" "$LOG_DIR/app.log" "$LOG_DIR/error.log"
  chmod 640 "$LOG_DIR/app.log" "$LOG_DIR/error.log"

  log "Verifying Node.js application..."
  if ! sudo -u "$USERNAME" bash -c "cd $BASE_DIR && NODE_ENV=production node -e 'require(\"./agent.js\")'" 2> "$LOG_DIR/verify.log"; then
    log_error "Node.js application verification failed. Check $LOG_DIR/verify.log for details"
    cat "$LOG_DIR/verify.log"
    return 1
  fi

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
RuntimeDirectory=cloudlunacy
RuntimeDirectoryMode=0750

Environment="HOME=$BASE_DIR"
Environment="NODE_ENV=production"
Environment="DEBUG=*"
Environment="NODE_DEBUG=*"
EnvironmentFile=$BASE_DIR/.env

ExecStart=/usr/bin/node --trace-warnings $BASE_DIR/agent.js
ExecStartPre=/usr/bin/node -c $BASE_DIR/agent.js

StandardOutput=append:$LOG_DIR/app.log
StandardError=append:$LOG_DIR/error.log

Restart=always
RestartSec=10
StartLimitInterval=200
StartLimitBurst=5

ProtectSystem=full
ReadWriteDirectories=$BASE_DIR $LOG_DIR
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  chmod 644 "$SERVICE_FILE"

  ENV_CHECK=($BASE_DIR/.env)
  REQUIRED_VARS=("BACKEND_URL" "AGENT_API_TOKEN" "SERVER_ID" "MONGO_MANAGER_USERNAME" "MONGO_MANAGER_PASSWORD" "MONGO_HOST")
  log "Verifying environment variables..."
  for var in "${REQUIRED_VARS[@]}"; do
    if ! grep -q "^${var}=" "$BASE_DIR/.env"; then
      log_error "Missing required environment variable: $var"
      return 1
    fi
  done

  systemctl daemon-reload
  systemctl stop cloudlunacy 2> /dev/null || true
  sleep 2

  log "Starting CloudLunacy service..."
  systemctl start cloudlunacy
  sleep 5

  if ! systemctl is-active --quiet cloudlunacy; then
    log_error "Service failed to start. Diagnostics:"
    echo "Node.js Version:"
    node --version
    echo "Environment File Contents (sanitized):"
    grep -v "PASSWORD\|TOKEN" "$BASE_DIR/.env" || true
    echo "Service Status:"
    systemctl status cloudlunacy
    echo "Service Logs:"
    tail -n 50 "$LOG_DIR/error.log"
    echo "Node.js Application Logs:"
    tail -n 50 "$LOG_DIR/app.log"
    return 1
  fi

  systemctl enable cloudlunacy

  log "CloudLunacy service setup completed successfully"
  return 0
}

verify_installation() {
  log "Verifying CloudLunacy Deployment Agent installation..."
  sleep 5
  if ! systemctl is-active --quiet cloudlunacy; then
    log_error "CloudLunacy Deployment Agent failed to start. Debug information:"
    log_error "------- Node.js Version -------"
    node --version
    log_error "------- Agent.js Status -------"
    ls -l /opt/cloudlunacy/agent.js
    log_error "------- Service Status -------"
    systemctl status cloudlunacy
    log_error "------- Detailed Service Logs -------"
    journalctl -u cloudlunacy -n 50 --no-pager
    log_error "------- Environment File Contents -------"
    cat "$BASE_DIR/.env"
    log_error "------- MongoDB CA File Status -------"
    ls -la /etc/ssl/mongo/ 2> /dev/null || echo "CA file not used in this configuration."
    log_error "------- Agent Log File -------"
    if [ -f "$BASE_DIR/logs/agent.log" ]; then
      tail -n 50 "$BASE_DIR/logs/agent.log"
    else
      echo "Agent log file not found at $BASE_DIR/logs/agent.log"
    fi
    return 1
  fi
  log "CloudLunacy Deployment Agent is running successfully."
}

completion_message() {
  echo -e "\033[0;35m
   ____                            _         _       _   _                 _
  / ___|___  _ __   __ _ _ __ __ _| |_ _   _| | __ _| |_(_) ___  _ __  ___| |
 | |   / _ \\| '_ \\ / _\ | '__/ _\ | __| | | | |/ _\` | __| |/ _ \\| '_ \\/ __| |
 | |__| (_) | | | | (_| | | | (_| | |_| |_| | | (_| | |_| | (_) | | | \\__ \\_|
  \\____\\___/|_| |_|\\__, |_|  \\__,_|\\__|\\__,_|_|\\__,_|\\__|_|\\___/|_| |_|___(_)
                       |___/
\033[0m"
  echo -e "\nYour CloudLunacy Deployment Agent is ready to use."
  PUBLIC_IP=$(curl -s https://api.ipify.org || true)
  if [ -z "$PUBLIC_IP" ]; then
    PUBLIC_IP="your_server_ip"
    echo -e "Could not retrieve public IP address. Please replace 'your_server_ip' with your actual IP."
  fi
  echo -e "Your front server will now handle subdomain routing and certificate management."
  echo -e "Logs are located at: $BASE_DIR/logs/agent.log"
  echo -e "It's recommended to back up your environment file:"
  echo -e "cp $BASE_DIR/.env $BASE_DIR/.env.backup"
}

cleanup_on_error() {
  log_error "Installation encountered an error. Cleaning up..."
  rm -rf "$BASE_DIR"
  exit 1
}

trap cleanup_on_error ERR

main() {
  check_root
  display_info
  check_args "$@"

  AGENT_TOKEN="$1"
  SERVER_ID="$2"
  EMAIL="$3"
  BACKEND_BASE_URL="${4:-https://your-default-backend-url}"
  BACKEND_URL="${BACKEND_BASE_URL}"

  # 1) Basic environment detection & updates
  detect_os
  update_system
  install_dependencies

  # 2) Install Docker and Node.js
  install_docker
  install_node

  # 3) Set up dedicated user and environment
  setup_user_directories
  configure_env

  # 4) Install mongosh and set up Docker permissions
  install_mongosh
  setup_docker_permissions

  # 5) Download agent code and install dependencies
  download_agent
  install_agent_dependencies
  stop_conflicting_containers

  # 6) Clean up any existing MongoDB containers
  log "Cleaning up any existing MongoDB containers..."
  docker rm -f mongodb 2> /dev/null || true
  docker volume rm -f $(docker volume ls -q --filter name=mongo_data) 2> /dev/null || true

  # 7) Set up MongoDB (two-phase: create root user then restart with auth)
  setup_mongodb
  create_mongo_management_user

  # 8) Adjust firewall settings and finish environment configuration
  adjust_firewall_settings

  # 9) Set up the CloudLunacy Deployment Agent as a systemd service
  setup_service

  # 10) Verify installation and show completion message
  verify_installation
  completion_message
  display_mongodb_credentials
}

main "$@"
