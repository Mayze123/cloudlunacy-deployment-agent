#!/bin/bash
# ------------------------------------------------------------------------------
# Installation Script for CloudLunacy Deployment Agent with Traefik and MongoDB
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
#   - Sets up Traefik as a reverse proxy
#   - Sets up MongoDB in two phases:
#       Phase 1: No auth/TLS -> root user is created by official entrypoint
#       Phase 2: Enable auth & TLS -> health check passes with credentials
#   - Creates a dedicated user with correct permissions
#   - Downloads the latest version of the Deployment Agent from GitHub
#   - Installs Node.js dependencies
#   - Configures environment variables
#   - Sets up the Deployment Agent as a systemd service
#   - Automates SSL certificate renewal
#   - Provides post-installation verification and feedback
#
# Usage:
#   sudo ./install-agent.sh <AGENT_TOKEN> <SERVER_ID> <EMAIL> [BACKEND_BASE_URL]
#
# Arguments:
#   AGENT_TOKEN      - Unique token for agent authentication
#   SERVER_ID        - Unique identifier for the server
#   EMAIL            - Email address for Let's Encrypt notifications
#   BACKEND_BASE_URL - (Optional) Backend base URL; defaults to https://your-default-backend-url
# ------------------------------------------------------------------------------

set -euo pipefail
# Uncomment the following line to enable debugging
set -x
IFS=$'\n\t'

# ----------------------------
# Configuration Variables
# ----------------------------
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
            if command -v dnf >/dev/null 2>&1; then
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
            if command -v dnf >/dev/null 2>&1; then
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
    if command -v docker >/dev/null 2>&1; then
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
    if command -v docker-compose >/dev/null 2>&1; then
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
    if command -v node >/dev/null 2>&1; then
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

install_certbot() {
    log "Installing Certbot for SSL certificate management..."
    case "$OS_TYPE" in
        ubuntu | debian | raspbian)
            apt-get update
            apt-get install -y certbot
            ;;
        centos | fedora | rhel | ol | rocky | almalinux | amzn)
            yum install -y certbot
            ;;
        *)
            log_error "Unsupported OS for Certbot installation: $OS_TYPE $OS_VERSION"
            exit 1
            ;;
    esac
    log "Certbot installed."
}

install_mongosh() {
    log "Pulling MongoDB Shell Docker image..."
    docker pull mongodb/mongodb-community-server:6.0-ubi8
    log "MongoDB Shell Docker image pulled."
}

obtain_ssl_certificate() {
    log "Obtaining SSL/TLS certificate for domain $DOMAIN..."
    
    # Ensure port 80 is free
    if lsof -i :80 | grep LISTEN; then
        log "Port 80 is currently in use. Attempting to stop services using port 80..."
        systemctl stop nginx || true
        systemctl stop apache2 || true
        systemctl stop httpd || true
        systemctl stop traefik || true
        if lsof -i :80 | grep LISTEN; then
            log_error "Port 80 is still in use. Cannot proceed."
            exit 1
        fi
    fi

    certbot certonly --standalone --non-interactive --agree-tos --email "$EMAIL" -d "$DOMAIN" || true
    if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
        certbot renew --dry-run || true
        if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
            log_error "Failed to obtain SSL/TLS certificate for $DOMAIN."
            exit 1
        fi
    fi

    log "SSL/TLS certificate obtained for $DOMAIN."
}

create_combined_certificate() {
    log "Creating combined certificate file for MongoDB..."
    SSL_DIR="/etc/ssl/mongo"
    mkdir -p "$SSL_DIR"
    CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

    # Combine private key and full chain into single .pem
    cat "$CERT_DIR/privkey.pem" "$CERT_DIR/fullchain.pem" > "$SSL_DIR/combined.pem"

    # Copy the default chain (intermediate only)
    cp "$CERT_DIR/chain.pem" "$SSL_DIR/chain.pem"

    # ADDED: Download Let’s Encrypt root cert and append it to chain.pem
    curl -s https://letsencrypt.org/certs/isrgrootx1.pem > "$SSL_DIR/isrgrootx1.pem"
    cat "$SSL_DIR/chain.pem" "$SSL_DIR/isrgrootx1.pem" > "$SSL_DIR/chain-with-root.pem"
    mv "$SSL_DIR/chain-with-root.pem" "$SSL_DIR/chain.pem"
    rm -f "$SSL_DIR/isrgrootx1.pem"

    # Adjust file ownership/permissions
    chown "$USERNAME:docker" "$SSL_DIR"
    chmod 750 "$SSL_DIR"
    chown "$USERNAME:docker" "$SSL_DIR"/*.pem
    chmod 644 "$SSL_DIR"/*.pem

    log "Certificate files created at $SSL_DIR"
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

    # Create random credentials
    MONGO_INITDB_ROOT_USERNAME=$(openssl rand -hex 12)
    MONGO_INITDB_ROOT_PASSWORD=$(openssl rand -hex 24)
    MONGO_MANAGER_USERNAME="manager"
    MONGO_MANAGER_PASSWORD=$(openssl rand -hex 24)

    # Write them to the Mongo .env file
    cat <<EOF > "$MONGO_ENV_FILE"
MONGO_INITDB_ROOT_USERNAME=$MONGO_INITDB_ROOT_USERNAME
MONGO_INITDB_ROOT_PASSWORD=$MONGO_INITDB_ROOT_PASSWORD
MONGO_MANAGER_USERNAME=$MONGO_MANAGER_USERNAME
MONGO_MANAGER_PASSWORD=$MONGO_MANAGER_PASSWORD
EOF

    chown "$USERNAME":"$USERNAME" "$MONGO_ENV_FILE"
    chmod 600 "$MONGO_ENV_FILE"

    # Source them right away so subsequent commands can use them
    set +u  # temporarily disable 'unbound variable' strictness
    source "$MONGO_ENV_FILE"
    set -u
}

setup_mongodb() {
    log "Setting up MongoDB with authentication sequence..."
    
    mkdir -p "$MONGODB_DIR"
    chown "$USERNAME":"$USERNAME" "$MONGODB_DIR"

    # Step 1: Start MongoDB without auth for initial setup
    log "Step 1: Starting MongoDB without auth..."
    cat <<COMPOSE > "$MONGODB_DIR/docker-compose.mongodb.yml"
version: '3.8'

services:
  mongodb:
    image: mongo:6.0
    container_name: mongodb
    restart: unless-stopped
    command: >
      mongod
      --bind_ip_all
    volumes:
      - mongo_data:/data/db
      - /etc/ssl/mongo:/etc/ssl/mongo:ro
    networks:
      internal:
        aliases:
          - $DOMAIN
    healthcheck:
      test: mongosh --eval "db.adminCommand('ping')"
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

    # Wait for initial MongoDB to be healthy
    log "Waiting for MongoDB to be healthy..."
    local max_attempts=10
    local attempt=1
    local healthy=false
    
    while [ $attempt -le $max_attempts ]; do
        if docker ps --filter "name=mongodb" --format "{{.Status}}" | grep -q "healthy"; then
            healthy=true
            break
        fi
        log "Waiting for MongoDB to be healthy (attempt $attempt/$max_attempts)..."
        sleep 5
        attempt=$((attempt + 1))
    done

    if [ "$healthy" != "true" ]; then
        log_error "MongoDB failed to become healthy"
        docker logs mongodb
        return 1
    fi

    # Step 2: Create root user
    log "Step 2: Creating root user..."
    MONGO_INITDB_ROOT_USERNAME=$(openssl rand -hex 12)
    MONGO_INITDB_ROOT_PASSWORD=$(openssl rand -hex 24)

    # Create root user without auth
    if ! docker exec mongodb mongosh --eval "
        db.getSiblingDB('admin').createUser({
            user: '$MONGO_INITDB_ROOT_USERNAME',
            pwd: '$MONGO_INITDB_ROOT_PASSWORD',
            roles: ['root']
        })
    "; then
        log_error "Failed to create root user"
        return 1
    fi

    # Save credentials
    cat <<EOF > "$MONGO_ENV_FILE"
MONGO_INITDB_ROOT_USERNAME=$MONGO_INITDB_ROOT_USERNAME
MONGO_INITDB_ROOT_PASSWORD=$MONGO_INITDB_ROOT_PASSWORD
EOF

    chown "$USERNAME":"$USERNAME" "$MONGO_ENV_FILE"
    chmod 600 "$MONGO_ENV_FILE"

    # Step 3: Restart with auth and TLS
    log "Step 3: Restarting MongoDB with auth and TLS..."
    cat <<COMPOSE > "$MONGODB_DIR/docker-compose.mongodb.yml"
version: '3.8'

services:
  mongodb:
    image: mongo:6.0
    container_name: mongodb
    restart: unless-stopped
    environment:
      MONGO_INITDB_ROOT_USERNAME: \${MONGO_INITDB_ROOT_USERNAME}
      MONGO_INITDB_ROOT_PASSWORD: \${MONGO_INITDB_ROOT_PASSWORD}
    command: >
      mongod
      --auth
      --tlsMode=requireTLS
      --tlsCertificateKeyFile=/etc/ssl/mongo/combined.pem
      --tlsCAFile=/etc/ssl/mongo/chain.pem
      --tlsAllowConnectionsWithoutCertificates
      --bind_ip_all
    ports:
      - "27017:27017"  
    volumes:
      - mongo_data:/data/db
      - /etc/ssl/mongo:/etc/ssl/mongo:ro
    networks:
      internal:
        aliases:
          - $DOMAIN
    healthcheck:
      test: >
        mongosh 
        --tls 
        --tlsAllowInvalidCertificates
        --tlsCAFile=/etc/ssl/mongo/chain.pem
        --host $DOMAIN
        -u \$\${MONGO_INITDB_ROOT_USERNAME}
        -p \$\${MONGO_INITDB_ROOT_PASSWORD}
        --eval "db.adminCommand('ping')"
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

    # Wait for secure MongoDB to be healthy with increased timeout
    log "Waiting for secure MongoDB to be healthy..."
    attempt=1
    healthy=false
    
    while [ $attempt -le $max_attempts ]; do
        if docker ps --filter "name=mongodb" --format "{{.Status}}" | grep -q "healthy"; then
            healthy=true
            break
        fi
        log "Waiting for secure MongoDB to be healthy (attempt $attempt/$max_attempts)..."
        # Show current container logs for debugging
        docker logs --tail 10 mongodb
        sleep 10
        attempt=$((attempt + 1))
    done

    if [ "$healthy" != "true" ]; then
        log_error "Secure MongoDB failed to become healthy"
        docker logs mongodb
        return 1
    fi

    # Verify secure connection
    log "Verifying secure connection..."
    for i in {1..5}; do
        if docker exec mongodb mongosh \
            --tls \
            --tlsAllowInvalidCertificates \
            --tlsCAFile=/etc/ssl/mongo/chain.pem \
            --host "$DOMAIN" \
            -u "$MONGO_INITDB_ROOT_USERNAME" \
            -p "$MONGO_INITDB_ROOT_PASSWORD" \
            --eval "db.adminCommand('ping')"; then
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
            --tls \
            --tlsAllowInvalidCertificates \
            --tlsCAFile=/etc/ssl/mongo/chain.pem \
            --host "$DOMAIN" \
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
        --tls \
        --tlsAllowInvalidCertificates \
        --tlsCAFile=/etc/ssl/mongo/chain.pem \
        --host "$DOMAIN" \
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
            --tls \
            --tlsAllowInvalidCertificates \
            --tlsCAFile=/etc/ssl/mongo/chain.pem \
            --host "$DOMAIN" \
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
            --tls \
            --tlsAllowInvalidCertificates \
            --tlsCAFile=/etc/ssl/mongo/chain.pem \
            --host "$DOMAIN" \
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
        --tls \
        --tlsAllowInvalidCertificates \
        --tlsCAFile=/etc/ssl/mongo/chain.pem \
        --host "$DOMAIN" \
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
    TRUSTED_IP="128.140.53.203" 
    if command -v ufw >/dev/null 2>&1; then
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
    
    # First ensure directory exists
    mkdir -p "$BASE_DIR"
    
    # Source MongoDB environment and verify credentials exist
    if [ ! -f "$MONGO_ENV_FILE" ]; then
        log_error "MongoDB environment file not found at $MONGO_ENV_FILE"
        return 1
    fi
    
    # Source the MongoDB environment file
    set +u  # Temporarily disable errors for unbound variables
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
        --tls \
        --tlsAllowInvalidCertificates \
        --tlsCAFile=/etc/ssl/mongo/chain.pem \
        --host "$DOMAIN" \
        -u "${MONGO_MANAGER_USERNAME}" \
        -p "${MONGO_MANAGER_PASSWORD}" \
        --eval "db.adminCommand('ping')" &>/dev/null; then
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
MONGO_HOST="$DOMAIN"
MONGO_PORT=27017
MONGO_CA_FILE=/etc/ssl/mongo/chain.pem
MONGODB_CA_FILE=/etc/ssl/mongo/chain.pem
NODE_ENV=production
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
        "MONGODB_CA_FILE"
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

configure_environment() {
    # Base configuration
    export BASE_DIR="/opt/cloudlunacy"
    export USERNAME="cloudlunacy"
    export MONGODB_DIR="$BASE_DIR/mongodb"
    export MONGO_ENV_FILE="$MONGODB_DIR/.env"

    # Create necessary directories
    mkdir -p "$MONGODB_DIR"
    
    # Set ownership
    chown -R "$USERNAME":"$USERNAME" "$MONGODB_DIR"
    chmod 750 "$MONGODB_DIR"

    # Verify environment
    log "Environment Configuration:"
    log "BASE_DIR = $BASE_DIR"
    log "USERNAME = $USERNAME"
    log "MONGODB_DIR = $MONGODB_DIR"
    log "MONGO_ENV_FILE = $MONGO_ENV_FILE"

    # Create Docker network if it doesn't exist
    if ! docker network ls --format '{{.Name}}' | grep -qx 'internal'; then
        log "Creating internal Docker network..."
        docker network create internal
    else
       log "Docker network 'internal' already exists."
    fi
}

verify_ca_file() {
    log "Verifying MongoDB CA file setup..."
    local CA_FILE="/etc/ssl/mongo/chain.pem"
    local CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

    # Ensure CA file exists and has correct content
    if [ ! -f "$CA_FILE" ] || [ ! -s "$CA_FILE" ]; then
        log "Recreating CA file from Let's Encrypt certificate..."
        mkdir -p "/etc/ssl/mongo"
        cp "$CERT_DIR/chain.pem" "$CA_FILE"
    fi

    # Set correct ownership and permissions
    chown "$USERNAME":"$USERNAME" "$CA_FILE"
    chmod 644 "$CA_FILE"

    # Verify the file is readable by service user
    if ! sudo -u "$USERNAME" test -r "$CA_FILE"; then
        log_error "CA file is not readable by $USERNAME"
        return 1
    fi

    # Verify file content
    if ! openssl x509 -in "$CA_FILE" -text -noout >/dev/null 2>&1; then
        log_error "Invalid CA file content"
        return 1
    fi

    log "CA file verified successfully"
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

setup_certificate_renewal() {
    log "Setting up SSL certificate renewal with Certbot..."
    RENEWAL_SCRIPT="/usr/local/bin/renew_certificates.sh"
    cat <<EOF > "$RENEWAL_SCRIPT"
#!/bin/bash
certbot renew --deploy-hook "cat /etc/letsencrypt/live/$DOMAIN/privkey.pem /etc/letsencrypt/live/$DOMAIN/fullchain.pem > /etc/ssl/mongo/combined.pem"
chown 999:999 /etc/ssl/mongo/combined.pem
chmod 600 /etc/ssl/mongo/combined.pem
docker-compose -f $MONGODB_DIR/docker-compose.mongodb.yml restart mongodb
EOF
    chmod +x "$RENEWAL_SCRIPT"
    (crontab -l 2>/dev/null; echo "0 2 * * * $RENEWAL_SCRIPT >> /var/log/letsencrypt/renewal.log 2>&1") | crontab -
    log "SSL certificate renewal setup complete."
}

setup_user_directories() {
    log "Creating dedicated user and directories..."
    if id "$USERNAME" &>/dev/null; then
        log "User '$USERNAME' already exists."
        usermod -d "$BASE_DIR" "$USERNAME"
    else
        useradd -m -d "$BASE_DIR" -r -s /bin/bash "$USERNAME"
        log "User '$USERNAME' created."
    fi

    mkdir -p "$BASE_DIR"
    chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"
    chmod -R 750 "$BASE_DIR"

    mkdir -p "$BASE_DIR"/{logs,ssh,config,bin,deployments,traefik}
    chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"/{logs,ssh,config,bin,deployments,traefik}

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

setup_traefik() {
    log "Setting up Traefik as a reverse proxy..."
    TRAEFIK_DIR="$BASE_DIR/traefik"
    mkdir -p "$TRAEFIK_DIR"
    chown "$USERNAME":"$USERNAME" "$TRAEFIK_DIR"

cat <<EOF > "$TRAEFIK_DIR/docker-compose.traefik.yml"
version: '3.8'

services:
  traefik:
    image: traefik:v2.9
    container_name: traefik
    command:
      - "--api.insecure=true"
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
    ports:
      - "80:80"
      - "8080:8080"
    volumes:
      - "/var/run/docker.sock:/var/run/docker.sock:ro"
    networks:
      - traefik-network

networks:
  traefik-network:
    external: true
EOF

    chown "$USERNAME":"$USERNAME" "$TRAEFIK_DIR/docker-compose.traefik.yml"

    if ! docker network ls | grep -q "traefik-network"; then
        docker network create traefik-network
        log "Created traefik-network."
    else
        log "traefik-network already exists."
    fi

    cd "$TRAEFIK_DIR"
    sudo -u "$USERNAME" docker-compose -f docker-compose.traefik.yml up -d
    log "Traefik set up and running."
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
    if ! sudo -u "$USERNAME" bash -c "cd $BASE_DIR && NODE_ENV=production node -e 'require(\"./agent.js\")'" 2>"$LOG_DIR/verify.log"; then
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
Environment="MONGODB_CA_FILE=/etc/ssl/mongo/chain.pem"
Environment="NODE_EXTRA_CA_CERTS=/etc/ssl/mongo/chain.pem"
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
ReadOnlyDirectories=/etc/ssl/mongo
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
        "MONGODB_CA_FILE"
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
    systemctl stop cloudlunacy 2>/dev/null || true
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
    
    log "Verifying Traefik installation..."
    if ! docker ps | grep -q "traefik"; then
        log_error "Traefik failed to start. Check Docker logs for details."
        return 1
    fi
    log "Traefik is running successfully."
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

    echo -e "Traefik is running and will route traffic to your deployed applications automatically."
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

    # 1) Basic environment detection & updates first
    detect_os
    update_system
    install_dependencies
    
    # 2) Now install Docker before we call any 'docker' commands
    install_docker

    # 3) Then set up your user
    setup_user_directories

    # 4) Then do environment config
    configure_environment

    install_certbot
    install_mongosh
    install_node
    setup_docker_permissions
    download_agent
    install_agent_dependencies
    stop_conflicting_containers
    obtain_ssl_certificate
    create_combined_certificate

    # Add this near the beginning of main() function before setup_mongodb()
    log "Cleaning up any existing MongoDB containers..."
    docker rm -f mongodb 2>/dev/null || true
    docker volume rm -f $(docker volume ls -q --filter name=mongo_data) 2>/dev/null || true

    setup_mongodb
    create_mongo_management_user
    adjust_firewall_settings
    configure_env
    setup_traefik
    setup_service
    setup_certificate_renewal
    verify_installation
    completion_message
    display_mongodb_credentials
}

main "$@"