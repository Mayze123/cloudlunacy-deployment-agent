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
: "${MONGO_DOMAIN:=mongodb.cloudlunacy.uk}"
: "${SHARED_NETWORK:=cloudlunacy-network}"
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

setup_docker_network() {
  log "Setting up Docker network..."
  # Check if network exists
  if docker network ls | grep -q "$SHARED_NETWORK"; then
    log "Network '$SHARED_NETWORK' already exists."
  else
    log "Creating Docker network '$SHARED_NETWORK'..."
    docker network create $SHARED_NETWORK
  fi
}

# ------------------------------------------------------------------------------
# Function: Install MongoDB with security enhancements but no TLS
# ------------------------------------------------------------------------------
install_mongo() {
  log "Installing MongoDB container with security enhancements..."
  # Check if a container named "mongodb-agent" exists
  if docker ps -a --format '{{.Names}}' | grep -q '^mongodb-agent$'; then
    log "MongoDB container already exists. Checking if it's running..."

    if docker ps --format '{{.Names}}' | grep -q '^mongodb-agent$'; then
      log "MongoDB container is already running. Skipping creation."
      return 0
    else
      log "MongoDB container exists but is not running. Starting it..."
      docker start mongodb-agent
      if [ $? -eq 0 ]; then
        log "MongoDB container started successfully."
        return 0
      else
        log_warn "Failed to start existing MongoDB container. Removing and recreating it..."
        docker rm -f mongodb-agent || {
          log_error "Failed to remove existing MongoDB container"
          exit 1
        }
      fi
    fi
  fi

  # Create a secure MongoDB configuration
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

  log "Creating and starting MongoDB container with security settings..."
  docker run -d \
    --name mongodb-agent \
    --network cloudlunacy-network \
    -p 27017:27017 \
    -e MONGO_INITDB_ROOT_USERNAME=admin \
    -e MONGO_INITDB_ROOT_PASSWORD=adminpassword \
    -v /opt/cloudlunacy/mongodb/mongod.conf:/mongodb/mongod.conf \
    mongo:latest --config /mongodb/mongod.conf

  log "MongoDB container is running on network $SHARED_NETWORK and exposed on port 27017"

  # Wait for MongoDB to initialize
  log "Waiting for MongoDB to initialize..."
  sleep 10

  # Verify MongoDB is running properly
  if docker exec mongodb-agent mongosh --eval "db.adminCommand('ping')" --quiet admin -u admin -p adminpassword &> /dev/null; then
    log "MongoDB initialization verified successfully."
  else
    log_warn "Initial MongoDB verification failed. MongoDB might need more time to initialize."
  fi
}

register_mongodb() {
  local token="$1"
  local ip="$2"
  local server_id="$3"

  log "Explicitly registering MongoDB with front server..."

  # Wait for MongoDB to be ready
  sleep 5

  # Perform MongoDB registration
  local mongo_response=$(curl -s -X POST "${FRONT_API_URL}/api/frontdoor/add-subdomain" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $token" \
    -d "{\"subdomain\": \"$server_id\", \"targetIp\": \"$ip\"}")

  if echo "$mongo_response" | grep -q "success"; then
    log "MongoDB registration successful. Response: $mongo_response"

    # Extract domain from response if available
    MONGO_URL=$(echo "$mongo_response" | grep -o '"domain":"[^"]*"' | cut -d'"' -f4 || echo "")
    if [ -n "$MONGO_URL" ]; then
      log "MongoDB will be accessible at: $MONGO_URL"
      echo "MONGODB_URL=$MONGO_URL" >> "$BASE_DIR/.env"
    fi
  else
    log_warn "MongoDB registration failed. Response: $mongo_response"
    # Continue despite failure - we don't want to stop the whole installation
  fi
}

# ------------------------------------------------------------------------------
# Register Agent with the Front Server
# ------------------------------------------------------------------------------
register_agent() {
  log "Registering agent with front server..."
  # Get primary IP address of the VPS
  LOCAL_IP=$(hostname -I | awk '{print $1}')
  log "register_agent ~ FRONT_API_URL: $FRONT_API_URL"
  log "register_agent ~ LOCAL_IP: $LOCAL_IP"
  log "register_agent ~ SERVER_ID: $SERVER_ID"

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
MONGO_HOST=mongodb-agent
MONGO_DOMAIN=mongodb.cloudlunacy.uk
APP_DOMAIN=apps.cloudlunacy.uk
SHARED_NETWORK=${SHARED_NETWORK}
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

create_ensure_network_script() {
  log "Creating script to ensure container connects to network..."
  SCRIPT_PATH="$BASE_DIR/ensure-network.sh"

  cat > "$SCRIPT_PATH" << 'EOF'
#!/bin/bash
# This script ensures the agent container connects to the shared network
# Give containers a moment to start
sleep 5

# Get shared network name from env
SHARED_NETWORK=${SHARED_NETWORK:-cloudlunacy-network}

# Get agent container ID - adjust filter pattern as needed
CONTAINER_ID=$(docker ps --filter "name=cloudlunacy" -q)

if [ -n "$CONTAINER_ID" ]; then
  # Check if already connected
  if ! docker network inspect $SHARED_NETWORK | grep -q "$CONTAINER_ID"; then
    echo "Connecting agent container $CONTAINER_ID to $SHARED_NETWORK"
    docker network connect $SHARED_NETWORK $CONTAINER_ID
  else
    echo "Container already connected to $SHARED_NETWORK"
  fi
else
  echo "Agent container not found - may not be running yet"
fi
EOF

  chmod +x "$SCRIPT_PATH"
  chown "$USERNAME:$USERNAME" "$SCRIPT_PATH"
  log "Network connection script created at $SCRIPT_PATH"
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
ExecStartPost=$BASE_DIR/ensure-network.sh
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
  setup_docker_network
  download_agent
  install_agent_dependencies
  setup_docker_permissions
  install_mongo
  configure_env
  create_ensure_network_script
  setup_service
  verify_installation
  register_agent
  register_agent

  log "Installation completed successfully!"
}

main "$@"
