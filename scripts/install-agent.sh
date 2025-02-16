#!/bin/bash
# ------------------------------------------------------------------------------
# Installation Script for CloudLunacy Deployment Agent
# Version: 2.6.0 (Simplified without Traefik/TLS)
# Author: Mahamadou Taibou
# Date: 2024-12-01
#
# Description:
# This script installs and configures the CloudLunacy Deployment Agent on a VPS.
# ------------------------------------------------------------------------------

set -euo pipefail
IFS=$'\n\t'

# ----------------------------
# Configuration Variables
# ----------------------------
USERNAME="cloudlunacy"
BASE_DIR="/opt/cloudlunacy"
# Use the front server's IP as the default API URL.
: "${FRONT_API_URL:=http://138.199.165.36:3005}"
: "${NODE_PORT:=3005}"
: "${MONGO_PORT:=27017}"


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
  log "Installing MongoDB container..."
  # Check if a container named "mongodb-agent" exists
  if docker ps -a --format '{{.Names}}' | grep -q '^mongodb-agent$'; then
    log "MongoDB container already exists. Removing it to re-create with proper port mapping..."
    docker rm -f mongodb-agent || { log_error "Failed to remove existing MongoDB container"; exit 1; }
  fi

  log "Creating and starting MongoDB container..."
  docker run -d \
    --name mongodb-agent \
    -p ${MONGO_PORT}:27017 \
    -e MONGO_INITDB_ROOT_USERNAME=admin \
    -e MONGO_INITDB_ROOT_PASSWORD=adminpassword \
    mongo:latest || { log_error "Failed to start MongoDB container"; exit 1; }
  
  log "MongoDB container is running."
}

# ------------------------------------------------------------------------------
# Register Agent with the Front Server
# ------------------------------------------------------------------------------
register_agent() {
  log "Registering agent with front server..."
  # Get primary IP address of the VPS
  LOCAL_IP=$(hostname -I | awk '{print $1}')
  
  RESPONSE=$(curl -s -X POST "${FRONT_API_URL}/api/agent/register" \
    -H "Content-Type: application/json" \
    -d "{\"agentToken\": \"${AGENT_TOKEN}\", \"serverId\": \"${SERVER_ID}\", \"mongoIp\": \"${LOCAL_IP}\" }")
  
  if echo "$RESPONSE" | grep -q "token"; then
    log "Agent registered successfully. Response: $RESPONSE"
  else
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
  if [ -d "$BASE_DIR/.git" ]; then
    log "Repository already exists in $BASE_DIR. Forcing update of repository..."
    cd "$BASE_DIR" || { log_error "Failed to change directory to $BASE_DIR"; exit 1; }
    sudo -u "$USERNAME" git fetch --all || { log_error "Failed to fetch repository updates"; exit 1; }
    sudo -u "$USERNAME" git reset --hard origin/main || { log_error "Failed to reset repository"; exit 1; }
  else
    sudo -u "$USERNAME" git clone https://github.com/Mayze123/cloudlunacy-deployment-agent.git "$BASE_DIR" \
      || { log_error "Failed to clone repository"; exit 1; }
  fi
  log "Agent repository is up to date at $BASE_DIR."
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
  configure_env
  download_agent
  install_agent_dependencies
  setup_docker_permissions
  install_mongo
  setup_service
  verify_installation
  register_agent

  log "Installation completed successfully!"
}

main "$@"
