#!/bin/bash
# ------------------------------------------------------------------------------
# Installation Script for CloudLunacy Deployment Agent with MongoDB
# Version: 2.5.2 (Modified for two-phase MongoDB setup)
# Author: Mahamadou Taibou
# Date: 2024-11-24
#
# Description:
# This script installs and configures the CloudLunacy Deployment Agent on a VPS.
# It performs the following tasks:
#   - Detects the operating system and version
#   - Updates system packages
#   - Installs necessary dependencies (Docker, Node.js, Git, jq, Certbot)
#   - Sets up MongoDB in two phases:
#       Phase 1: No auth -> root user is created by official entrypoint
#       Phase 2: Enable auth -> health check passes with credentials
#   - Creates a dedicated user with correct permissions
#   - Downloads the latest version of the Deployment Agent from GitHub
#   - Installs Node.js dependencies
#   - Configures environment variables
#   - Sets up the Deployment Agent as a systemd service
#   - Automates SSL certificate renewal
#   - Provides post-installation verification and feedback
#
# Usage:
#   sudo ./install-agent.sh <AGENT_TOKEN> <SERVER_ID> [BACKEND_BASE_URL]
#
# Arguments:
#   AGENT_TOKEN      - Unique token for agent authentication
#   SERVER_ID        - Unique identifier for the server
#   BACKEND_BASE_URL - (Optional) Backend base URL; defaults to https://your-default-backend-url
# ------------------------------------------------------------------------------

set -euo pipefail
# Uncomment the following line to enable debugging
set -x
IFS=$'\n\t'

# ----------------------------
# Configuration Variables
# ----------------------------
USERNAME="cloudlunacy"
BASE_DIR="/opt/cloudlunacy"
MONGODB_DIR="$BASE_DIR/mongodb"
MONGO_ENV_FILE="$MONGODB_DIR/.env"
FRONT_API_TOKEN="your_secret_token"

FRONTDOOR_API_URL="http://138.199.165.36:3000"
FRONTDOOR_API_TOKEN="your_secret_token"
FRONTDOOR_SUBDOMAIN_BASE="mongodb.cloudlunacy.uk"
FRONTDOOR_CONFIG="/etc/cloudlunacy/frontdoor.conf"

# ----------------------------
# Function Definitions
# ----------------------------

display_info() {
  echo "-------------------------------------------------"
  echo "CloudLunacy Deployment Agent Installation Script"
  echo "Version: 2.5.2"
  echo "Author: Mahamadou Taibou"
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

install_mongosh() {
  log "Pulling MongoDB Shell Docker image..."
  docker pull mongodb/mongodb-community-server:6.0-ubi8
  log "MongoDB Shell Docker image pulled."
}

wait_for_mongodb_health() {
  log "Waiting for MongoDB container to be healthy..."
  local max_attempts=10
  local attempt=1

  while [ $attempt -le $max_attempts ]; do
    if docker ps --filter "name=mongodb" --format "{{.Status}}" | grep -q "healthy"; then
      log "MongoDB container is healthy"
      return 0
    fi

    # Get current health check status
    local status=$(docker ps --filter "name=mongodb" --format "{{.Status}}")
    log "Attempt $attempt/$max_attempts: Current status: $status"

    # If container is unhealthy, get the last health check output
    if echo "$status" | grep -q "unhealthy"; then
      log "Last health check output:"
      docker inspect --format "{{json .State.Health.Log}}" mongodb | jq -r '.[-1].Output'
    fi

    sleep 30
    attempt=$((attempt + 1))
  done

  log_error "MongoDB failed to become healthy after $max_attempts attempts"
  log_error "Container logs:"
  docker logs mongodb
  return 1
}

generate_mongo_credentials() {
  log "Generating MongoDB credentials..."

  # Generate credentials only if not already set
  if [ -z "${MONGO_INITDB_ROOT_USERNAME:-}" ]; then
    MONGO_INITDB_ROOT_USERNAME=$(openssl rand -hex 12)
    MONGO_INITDB_ROOT_PASSWORD=$(openssl rand -hex 24)
  fi

  # Write the credentials to the file
  cat << EOF > "$MONGO_ENV_FILE"
    export MONGO_INITDB_ROOT_USERNAME="$MONGO_INITDB_ROOT_USERNAME"
    export MONGO_INITDB_ROOT_PASSWORD="$MONGO_INITDB_ROOT_PASSWORD"
    EOF

# Set file permissions
chmod 600 "$MONGO_ENV_FILE"

# Change ownership so that the cloudlunacy user can read the file
chown cloudlunacy:cloudlunacy "$MONGO_ENV_FILE"
    
    # Source with validation
    set +u
    if [ -f "$MONGO_ENV_FILE" ]; then  
        . "$MONGO_ENV_FILE"
    else
        log_error "MongoDB credentials file missing!"
        exit 1
    fi
    set -u

    # Verify variables
    if [ -z "${MONGO_INITDB_ROOT_USERNAME:-}" ] || [ -z "${MONGO_INITDB_ROOT_PASSWORD:-}" ]; then
        log_error "Failed to generate MongoDB credentials!"
        exit 1
    fi
}

setup_mongodb() {
    log "Setting up MongoDB with authentication sequence..."
    
    # Create working directory
    mkdir -p "$MONGODB_DIR"
    chown -R "$USERNAME":"$USERNAME" "$MONGODB_DIR"

    # Generate credentials if not already exists
    if [ ! -f "$MONGO_ENV_FILE" ]; then
        log "Generating new MongoDB credentials..."
        MONGO_INITDB_ROOT_USERNAME=$(openssl rand -hex 12)
        MONGO_INITDB_ROOT_PASSWORD=$(openssl rand -hex 24)
        echo "MONGO_INITDB_ROOT_USERNAME=$MONGO_INITDB_ROOT_USERNAME" > "$MONGO_ENV_FILE"
        echo "MONGO_INITDB_ROOT_PASSWORD=$MONGO_INITDB_ROOT_PASSWORD" >> "$MONGO_ENV_FILE"
        chmod 600 "$MONGO_ENV_FILE"
    fi

    # Source credentials with safety checks
    set +u
    source "$MONGO_ENV_FILE"
    set -u

    # Verify credentials
    if [ -z "${MONGO_INITDB_ROOT_USERNAME:-}" ] || [ -z "${MONGO_INITDB_ROOT_PASSWORD:-}" ]; then
        log_error "MongoDB credentials not properly initialized!"
        exit 1
    fi

    # Ensure Docker network exists
    if ! docker network inspect traefik_network >/dev/null 2>&1; then
        log "Creating traefik_network..."
        docker network create traefik_network
    fi

    # Phase 1: Initial setup without authentication
    log "Phase 1: Starting MongoDB without auth..."
    cat <<COMPOSE > "$MONGODB_DIR/docker-compose.phase1.yml"
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
      - traefik_network
    healthcheck:
      test: mongosh --eval "db.adminCommand('ping')"
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 20s

volumes:
  mongo_data:

networks:
  traefik_network:
    external: true
COMPOSE

    # Start initial MongoDB
    log "Starting initial MongoDB container..."
    cd "$MONGODB_DIR"
    sudo -u "$USERNAME" docker-compose -f docker-compose.phase1.yml up -d

    # Wait for MongoDB to become healthy
    local health_retries=10
    while ! docker inspect --format '{{.State.Health.Status}}' mongodb | grep -q "healthy"; do
        if [ $health_retries -le 0 ]; then
            log_error "MongoDB failed to start in phase 1"
            docker logs mongodb
            exit 1
        fi
        sleep 10
        health_retries=$((health_retries - 1))
    done

    # Phase 2: Secure setup with authentication
    log "Phase 2: Configuring authenticated MongoDB..."
    cat <<COMPOSE > "$MONGODB_DIR/docker-compose.phase2.yml"
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
    networks:
      - traefik_network
    healthcheck:
      test: ["CMD", "mongosh", "--host", "localhost", "-u", "${MONGO_INITDB_ROOT_USERNAME}", "-p", "${MONGO_INITDB_ROOT_PASSWORD}", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 30s

volumes:
  mongo_data:

networks:
  traefik_network:
    external: true
COMPOSE

    # Restart with authentication
    log "Restarting MongoDB with authentication..."
    sudo -u "$USERNAME" docker-compose -f docker-compose.phase1.yml down
    sudo -u "$USERNAME" docker-compose -f docker-compose.phase2.yml up -d

    # Verify secure connection
    local verify_retries=10
    while ! docker exec mongodb mongosh \
        -u "$MONGO_INITDB_ROOT_USERNAME" \
        -p "$MONGO_INITDB_ROOT_PASSWORD" \
        --eval "db.adminCommand('ping')" &>/dev/null; do
        if [ $verify_retries -le 0 ]; then
            log_error "Failed to verify authenticated MongoDB connection"
            docker logs mongodb
            exit 1
        fi
        sleep 10
        verify_retries=$((verify_retries - 1))
    done

    log "MongoDB authentication setup completed successfully"
    
    # Create management user
    create_mongo_management_user
}

create_mongo_management_user() {
    log "Creating/updating MongoDB management user..."
    
    # Ensure environment file exists and can be read
    if [ ! -f "$MONGO_ENV_FILE" ]; then
        log_error "MongoDB environment file not found at $MONGO_ENV_FILE"
        return 1
    fi

    # Source MongoDB environment variables
    set +u  # Temporarily disable errors for unbound variables
    source "$MONGO_ENV_FILE"
    set -u

    # Verify required variables are set
    if [ -z "${MONGO_INITDB_ROOT_USERNAME:-}" ] || [ -z "${MONGO_INITDB_ROOT_PASSWORD:-}" ]; then
        log_error "Root credentials not found in environment file"
        return 1
    fi

    # Set management user constants
    MONGO_MANAGER_USERNAME="manager"
    local max_retries=3
    local retry_count=0
    local success=false

    # Function to verify MongoDB connection
    verify_mongodb_connection() {
            docker exec mongodb mongosh \
            --host localhost \
            -u "$MONGO_INITDB_ROOT_USERNAME" \
            -p "$MONGO_INITDB_ROOT_PASSWORD" \
            --eval "db.adminCommand('ping')" &>/dev/null
    }

    # Wait for MongoDB to be fully operational
    log "Waiting for MongoDB to be ready..."
    while [ $retry_count -lt $max_retries ]; do
        if verify_mongodb_connection; then
            success=true
            break
        fi
        log "Attempt $((retry_count + 1))/$max_retries: MongoDB not ready yet, waiting..."
        sleep 10
        retry_count=$((retry_count + 1))
    done

    if [ "$success" != "true" ]; then
        log_error "Failed to connect to MongoDB after $max_retries attempts"
        return 1
    fi

    # Check if management user exists
    log "Checking for existing management user..."
    local user_exists
    user_exists=$(docker exec mongodb mongosh \
    -u "$MONGO_INITDB_ROOT_USERNAME" \
    -p "$MONGO_INITDB_ROOT_PASSWORD" \
    --eval "db.getSiblingDB('admin').getUser('$MONGO_MANAGER_USERNAME')" \
    --quiet)

    # Generate new password regardless of whether we're creating or updating
    MONGO_MANAGER_PASSWORD=$(openssl rand -hex 24)

    if [ "$user_exists" = "null" ] || [ -z "$user_exists" ]; then
        log "Creating new management user..."
        # Create new management user
        if ! docker exec mongodb mongosh \
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
        # Update existing management user
        if ! docker exec mongodb mongosh \
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

    # Update environment file with all credentials
    log "Updating environment file with credentials..."
    {
        echo "MONGO_INITDB_ROOT_USERNAME=$MONGO_INITDB_ROOT_USERNAME"
        echo "MONGO_INITDB_ROOT_PASSWORD=$MONGO_INITDB_ROOT_PASSWORD"
        echo "MONGO_MANAGER_USERNAME=$MONGO_MANAGER_USERNAME"
        echo "MONGO_MANAGER_PASSWORD=$MONGO_MANAGER_PASSWORD"
    } > "$MONGO_ENV_FILE"

    # Secure the environment file
    chmod 600 "$MONGO_ENV_FILE"
    chown "$USERNAME:$USERNAME" "$MONGO_ENV_FILE"

    # Verify management user access
    log "Verifying management user access..."
    if ! docker exec mongodb mongosh \
        -u "$MONGO_MANAGER_USERNAME" \
        -p "$MONGO_MANAGER_PASSWORD" \
        --eval "db.adminCommand('ping')"; then
        log_error "Failed to verify management user access"
        return 1
    fi

    log "Management user setup completed successfully"
    return 0
}

adjust_firewall_settings() {
    log "Adjusting firewall settings..."
    TRUSTED_IP="138.199.165.36" 
    if command -v ufw >/dev/null 2>&1; then
        ufw allow from $TRUSTED_IP to any port 27017 proto tcp
        log "Allowed port 27017 for trusted IP $TRUSTED_IP."
    else
        iptables -A INPUT -p tcp -s $TRUSTED_IP --dport 27017 -j ACCEPT
        log "Allowed port 27017 for trusted IP $TRUSTED_IP via iptables."
    fi
    log "Firewall settings adjusted."
}

configure_network() {
    log "Configuring network access to front server..."
    
    # Allow front server IP to access MongoDB
    FRONT_SERVER_IP="138.199.165.36"
    ufw allow from "$FRONT_SERVER_IP" to any port 27017 proto tcp
    
    # Allow agent to reach frontdoor API
    ufw allow out to "$FRONT_SERVER_IP" port 3000 proto tcp
    
    log "Network rules configured for front server access"
}

register_with_frontdoor() {
    log "Registering agent with frontdoor service..."
    
    local PUBLIC_IP=$(curl -s https://api.ipify.org)
    local API_URL="$FRONTDOOR_API_URL/api/frontdoor/add-subdomain"
    
    curl -X POST "$API_URL" \
         -H "Authorization: Bearer $FRONTDOOR_API_TOKEN" \
         -H "Content-Type: application/json" \
         -d @- <<EOF
{
    "subdomain": "$SERVER_ID.$FRONTDOOR_SUBDOMAIN_BASE",
    "targetIp": "$PUBLIC_IP"
}
EOF

  log "Registration complete. Subdomain: $SERVER_ID.$FRONTDOOR_SUBDOMAIN_BASE"
}

verify_frontdoor_connection() {
  log "Verifying frontdoor service connection..."

  response=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $FRONTDOOR_API_TOKEN" \
    "$FRONTDOOR_API_URL/api/frontdoor/add-subdomain")

  if [ "$response" -eq 401 ]; then
    log_error "Invalid API token"
    exit 1
  elif [ "$response" -ne 200 ]; then
    log_error "Connection failed (HTTP $response)"
    exit 1
  fi

  log "Frontdoor service connection verified"
}

create_frontdoor_config() {
  log "Creating frontdoor API configuration..."
  mkdir -p /etc/cloudlunacy

  cat << EOF > "$FRONTDOOR_CONFIG"
# CloudLunacy Frontdoor Configuration
FRONTDOOR_API_URL="${FRONTDOOR_API_URL}"
FRONTDOOR_API_TOKEN="${FRONTDOOR_API_TOKEN}"
FRONTDOOR_SUBDOMAIN_BASE="${FRONTDOOR_SUBDOMAIN_BASE}"
EOF

  chmod 600 "$FRONTDOOR_CONFIG"
  log "Frontdoor configuration created at $FRONTDOOR_CONFIG"

  # Security validation
  if ! curl -sI "${FRONTDOOR_API_URL}/health" | grep -q "200 OK"; then
    log_warn "Could not verify frontdoor API connectivity"
  fi
}

get_public_ip() {
  log "Obtaining public IP address..."
  local max_retries=3
  local retry_delay=5

  for ((i = 1; i <= max_retries; i++)); do
    PUBLIC_IP=$(curl -s --fail https://api.ipify.org)
    if [ -n "$PUBLIC_IP" ]; then
      log "Public IP obtained: $PUBLIC_IP"
      return 0
    fi
    log_warn "Failed to get public IP (attempt $i/$max_retries)"
    sleep $retry_delay
  done

  log_error "Could not determine public IP"
  return 1
}

generate_subdomain() {
  # Create a short hash from SERVER_ID (first 12 characters of the SHA256 sum)
  local hash=$(echo -n "$SERVER_ID" | sha256sum | cut -c1-12)
  local prefix="cl-${hash}"

  # Sanitize: Replace any non-alphanumeric/dash characters with dashes
  prefix=${prefix//[^a-z0-9-]/-}
  # Trim to a maximum of 24 characters (if needed)
  prefix=${prefix:0:24}

  # Append the front door base domain so the full subdomain becomes:
  # cl-<hash>.mongodb.cloudlunacy.uk
  echo "${prefix}.${FRONTDOOR_SUBDOMAIN_BASE}"
}

validate_subdomain() {
  local subdomain="$1"

  # Basic DNS validation
  if [[ ! "$subdomain" =~ ^[a-z0-9-]{1,24}$ ]]; then
    log_error "Invalid subdomain format: $subdomain"
    return 1
  fi

  # Check against DNS restrictions
  if [[ "$subdomain" == -* || "$subdomain" == *- ]]; then
    log_error "Subdomain cannot start/end with dash: $subdomain"
    return 1
  fi

  return 0
}

register_subdomain() {
  log "Registering subdomain with front server..."

  local api_url="${FRONTDOOR_API_URL}/api/frontdoor/add-subdomain"
  local subdomain="$(generate_subdomain)"

  local response=$(
    curl -s -o /dev/null -w "%{http_code}" \
      -X POST "$api_url" \
      -H "Authorization: Bearer ${FRONTDOOR_API_TOKEN}" \
      -H "Content-Type: application/json" \
      -d @- << EOF
{
    "subdomain": "$subdomain",
    "targetIp": "$PUBLIC_IP"
}
EOF
  )

  case "$response" in
    200 | 201)
      log "Subdomain registered: $subdomain → $PUBLIC_IP"
      return 0
      ;;
    401)
      log_error "Invalid API token"
      return 1
      ;;
    409)
      log_error "Subdomain already exists"
      return 1
      ;;
    *)
      log_error "Registration failed (HTTP $response)"
      return 1
      ;;
  esac
}

load_frontdoor_config() {
  # No need for existence check - we create it earlier
  source "$FRONTDOOR_CONFIG"

  # Add validation for good measure
  if [ -z "$FRONTDOOR_API_URL" ] || [ -z "$FRONTDOOR_API_TOKEN" ]; then
    log_error "Frontdoor configuration invalid"
    exit 1
  fi
}

configure_environment() {
  log "Configuring environment variables..."
  ENV_FILE="$BASE_DIR/.env"

  # Ensure MongoDB environment file exists
  if [ ! -f "$MONGO_ENV_FILE" ]; then
    log_error "MongoDB environment file not found at $MONGO_ENV_FILE"
    return 1
  fi

  # Source the MongoDB environment file
  set +u # Temporarily disable errors for unbound variables
  source "$MONGO_ENV_FILE"
  set -u

  # Verify required MongoDB variables are set
  if [ -z "${MONGO_MANAGER_USERNAME:-}" ] || [ -z "${MONGO_MANAGER_PASSWORD:-}" ]; then
    log_error "MongoDB manager credentials not found in environment file"
    return 1
  fi

  # Log verification of credentials (without exposing them)
  log "Verifying MongoDB manager credentials..."
  if ! docker exec mongodb mongosh \
    -u "${MONGO_MANAGER_USERNAME}" \
    -p "${MONGO_MANAGER_PASSWORD}" \
    --eval "db.adminCommand('ping')" &> /dev/null; then
    log_error "Failed to verify MongoDB manager credentials"
    return 1
  fi

  log "MongoDB manager credentials verified successfully"

  # Create environment file with explicit values
  cat > "$ENV_FILE" << EOL
BACKEND_URL="${BACKEND_URL:-https://your-default-backend-url}"
AGENT_API_TOKEN="${AGENT_TOKEN}"
SERVER_ID="${SERVER_ID}"
MONGO_MANAGER_USERNAME="${MONGO_MANAGER_USERNAME}"
MONGO_MANAGER_PASSWORD="${MONGO_MANAGER_PASSWORD}"
MONGO_HOST="localhost"
MONGO_PORT=27017
NODE_ENV=production
FRONTDOOR_API_URL="$FRONTDOOR_API_URL"
FRONTDOOR_API_TOKEN="$FRONTDOOR_API_TOKEN"
PUBLIC_IP="$PUBLIC_IP"
EOL

  chown "$USERNAME:$USERNAME" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  # Verify file contents
  if [ ! -s "$ENV_FILE" ]; then
    log_error "Environment file is empty or not created properly"
    return 1
  fi

  # Verify required variables are present
  local required_vars=(
    "MONGO_MANAGER_USERNAME"
    "MONGO_MANAGER_PASSWORD"
    "MONGO_HOST"
  )

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

  # Set up logging directory with proper permissions
  LOG_DIR="/var/log/cloudlunacy"
  mkdir -p "$LOG_DIR"
  chown -R "$USERNAME:$USERNAME" "$LOG_DIR"
  chmod 750 "$LOG_DIR"

  # Create log files
  touch "$LOG_DIR/app.log" "$LOG_DIR/error.log"
  chown "$USERNAME:$USERNAME" "$LOG_DIR/app.log" "$LOG_DIR/error.log"
  chmod 640 "$LOG_DIR/app.log" "$LOG_DIR/error.log"

  # First, verify Node.js can run the application
  log "Verifying Node.js application..."
  if ! sudo -u "$USERNAME" bash -c "cd $BASE_DIR && NODE_ENV=production node -e 'require(\"./agent.js\")'" 2> "$LOG_DIR/verify.log"; then
    log_error "Node.js application verification failed. Check $LOG_DIR/verify.log for details"
    cat "$LOG_DIR/verify.log"
    return 1
  fi

  # Create systemd service file with debug logging
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

# Environment setup
Environment="HOME=$BASE_DIR"
Environment="NODE_ENV=production"
Environment="DEBUG=*"
Environment="NODE_DEBUG=*"
EnvironmentFile=$BASE_DIR/.env

# Execution
ExecStart=/usr/bin/node --trace-warnings $BASE_DIR/agent.js
ExecStartPre=/usr/bin/node -c $BASE_DIR/agent.js

# Logging
StandardOutput=append:$LOG_DIR/app.log
StandardError=append:$LOG_DIR/error.log

# Restart configuration
Restart=always
RestartSec=10
StartLimitInterval=200
StartLimitBurst=5

# Security
ProtectSystem=full
ReadWriteDirectories=$BASE_DIR $LOG_DIR
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  chmod 644 "$SERVICE_FILE"

  # Verify environment file has required variables
  ENV_CHECK=($BASE_DIR/.env)
  REQUIRED_VARS=(
    "BACKEND_URL"
    "AGENT_API_TOKEN"
    "SERVER_ID"
    "MONGO_MANAGER_USERNAME"
    "MONGO_MANAGER_PASSWORD"
    "MONGO_HOST"
  )

  log "Verifying environment variables..."
  for var in "${REQUIRED_VARS[@]}"; do
    if ! grep -q "^${var}=" "$BASE_DIR/.env"; then
      log_error "Missing required environment variable: $var"
      return 1
    fi
  done

  # Reload systemd and restart service
  systemctl daemon-reload
  systemctl stop cloudlunacy 2> /dev/null || true
  sleep 2

  log "Starting CloudLunacy service..."
  systemctl start cloudlunacy
  sleep 5

  # Check service status with enhanced diagnostics
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

  # Enable service for boot
  systemctl enable cloudlunacy

  log "CloudLunacy service setup completed successfully"
  return 0
}

verify_installation() {
  log "Verifying CloudLunacy Deployment Agent installation..."

  # Wait a bit for the service to stabilize
  sleep 5

  if ! systemctl is-active --quiet cloudlunacy; then
    log_error "CloudLunacy Deployment Agent failed to start. Debug information:"

    # Check Node.js installation
    log_error "------- Node.js Version -------"
    node --version

    # Check agent.js existence and permissions
    log_error "------- Agent.js Status -------"
    ls -l /opt/cloudlunacy/agent.js

    # Service Logs with more context
    log_error "------- Service Status -------"
    systemctl status cloudlunacy

    log_error "------- Detailed Service Logs -------"
    journalctl -u cloudlunacy -n 50 --no-pager

    log_error "------- Environment File Contents -------"
    cat "$BASE_DIR/.env"

    log_error "------- MongoDB CA File Status -------"
    ls -la /etc/ssl/mongo/

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
  BACKEND_BASE_URL="${3:-https://your-default-backend-url}"
  BACKEND_URL="${BACKEND_BASE_URL}"

  # 1) Basic environment detection & updates first
  detect_os
  update_system
  install_dependencies

  # 2) Now install Docker before we call any 'docker' commands
  install_docker

  # 3) Then set up your user
  setup_user_directories

  create_frontdoor_config
  load_frontdoor_config

  # 4) Install MongoDB Shell, Node.js, Docker permissions, etc.
  install_mongosh
  install_node
  setup_docker_permissions
  download_agent
  install_agent_dependencies
  stop_conflicting_containers

  # Clean up any existing MongoDB containers
  log "Cleaning up any existing MongoDB containers..."
  docker rm -f mongodb 2> /dev/null || true
  docker volume rm -f $(docker volume ls -q --filter name=mongo_data) 2> /dev/null || true

  # 5) Set up MongoDB
  setup_mongodb
  create_mongo_management_user

  # 6) Obtain public IP
  if ! get_public_ip; then
    log_error "Cannot proceed without public IP"
    exit 1
  fi

  # 7) Register subdomain with the front door
  if ! register_subdomain; then
    log_error "Subdomain registration failed - check front server status"
    exit 1
  fi

  # 8) Adjust firewall settings
  adjust_firewall_settings

  # 9) Configure environment variables **after** MongoDB setup
  configure_environment

  # 10) Configure network
  configure_network

  # 11) Set up systemd service
  setup_service

  # 12) Verify installation
  verify_installation

  # 13) Completion message and credentials display
  completion_message
  display_mongodb_credentials

  # 14) Verify frontdoor connection
  verify_frontdoor_connection
}

main "$@"
