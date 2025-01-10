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
# set -x
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
    
    cat "$CERT_DIR/privkey.pem" "$CERT_DIR/fullchain.pem" > "$SSL_DIR/combined.pem"
    cp "$CERT_DIR/chain.pem" "$SSL_DIR/chain.pem"

    chown -R 999:999 "$SSL_DIR"
    chmod 600 "$SSL_DIR"/*.pem
    log "Certificate files created in $SSL_DIR"
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
    log "Setting up MongoDB with auth and TLS..."

    # ----------------------------
    # Generate and store credentials
    # ----------------------------
    mkdir -p "$MONGODB_DIR"
    chown "$USERNAME":"$USERNAME" "$MONGODB_DIR"

    log "Generating MongoDB credentials..."
    MONGO_INITDB_ROOT_USERNAME=$(openssl rand -hex 12)
    MONGO_INITDB_ROOT_PASSWORD=$(openssl rand -hex 24)
    MONGO_MANAGER_USERNAME="manager"
    MONGO_MANAGER_PASSWORD=$(openssl rand -hex 24)

    cat <<EOF > "$MONGO_ENV_FILE"
MONGO_INITDB_ROOT_USERNAME=$MONGO_INITDB_ROOT_USERNAME
MONGO_INITDB_ROOT_PASSWORD=$MONGO_INITDB_ROOT_PASSWORD
MONGO_MANAGER_USERNAME=$MONGO_MANAGER_USERNAME
MONGO_MANAGER_PASSWORD=$MONGO_MANAGER_PASSWORD
EOF

    chown "$USERNAME":"$USERNAME" "$MONGO_ENV_FILE"
    chmod 600 "$MONGO_ENV_FILE"

    # Source the newly created .env file so variables are available in the script
    source "$MONGO_ENV_FILE"

    # ----------------------------
    # Safely re-create the Docker network
    # ----------------------------
    log "Ensuring 'internal' Docker network is available..."
    if docker network ls | grep -q "internal"; then
        log "Network 'internal' already exists. Stopping/removing any containers on it..."
        
        # Stop any running containers on the 'internal' network
        RUNNING_CONTAINERS="$(docker ps --filter network=internal -q)"
        if [ -n "$RUNNING_CONTAINERS" ]; then
            log "Stopping containers on 'internal' network: $RUNNING_CONTAINERS"
            docker stop $RUNNING_CONTAINERS || true
            docker rm $RUNNING_CONTAINERS || true
        fi

        # Now remove the existing network
        docker network rm internal || true
    fi

    # Create the 'internal' network fresh
    docker network create internal

    # ----------------------------
    # Single-phase Docker Compose for Auth + TLS
    # ----------------------------
    log "Creating docker-compose.mongodb.yml..."
     cat <<EOF > "$MONGODB_DIR/docker-compose.mongodb.yml"
version: '3.8'

services:
  mongodb:
    image: mongo:6.0
    container_name: mongodb
    restart: unless-stopped
    hostname: mongodb.cloudlunacy.uk
    environment:
      - MONGO_INITDB_ROOT_USERNAME=\${MONGO_INITDB_ROOT_USERNAME}
      - MONGO_INITDB_ROOT_PASSWORD=\${MONGO_INITDB_ROOT_PASSWORD}
    command:
      - "--auth"
      - "--tlsMode=requireTLS"
      - "--tlsCertificateKeyFile=/etc/ssl/mongo/combined.pem"
      - "--tlsCAFile=/etc/ssl/mongo/chain.pem"
      - "--bind_ip_all"
    volumes:
      - mongo_data:/data/db
      - /etc/ssl/mongo:/etc/ssl/mongo:ro
    networks:
      internal:
        aliases:
          - mongodb.cloudlunacy.uk
    healthcheck:
      test: >
        mongosh "mongodb://mongodb.cloudlunacy.uk:27017" --tls
        --tlsCAFile /etc/ssl/mongo/chain.pem
        --tlsCertificateKeyFile /etc/ssl/mongo/combined.pem
        --eval "db.adminCommand('ping')"
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s

volumes:
  mongo_data:

networks:
  internal:
    external: true
EOF

    chown "$USERNAME":"$USERNAME" "$MONGODB_DIR/docker-compose.mongodb.yml"

    # Start MongoDB container
    log "Starting MongoDB container with Auth + TLS..."
    cd "$MONGODB_DIR"
    sudo -u "$USERNAME" docker-compose --env-file "$MONGO_ENV_FILE" -f docker-compose.mongodb.yml up -d

    # Wait for MongoDB to become healthy (using your existing wait_for_mongodb_health function)
    if ! wait_for_mongodb_health; then
        log_error "MongoDB failed to become healthy"
        docker logs mongodb
        return 1
    fi

    log "MongoDB setup completed successfully."
}

create_mongo_management_user() {
    log "Creating MongoDB management user..."

    # Ensure the environment file exists
    if [ ! -f "$MONGO_ENV_FILE" ]; then
        log_error "MongoDB environment file not found at $MONGO_ENV_FILE"
        exit 1
    fi

    # Source environment variables
    source "$MONGO_ENV_FILE"
    if [ -z "$MONGO_INITDB_ROOT_USERNAME" ] || [ -z "$MONGO_INITDB_ROOT_PASSWORD" ]; then
        log_error "MongoDB root credentials not found in environment file"
        exit 1
    fi

    # Wait until MongoDB is healthy (reuse your existing function)
    wait_for_mongodb_health

    # 1) Define and populate TEMP_CERT_DIR on the host:
    TEMP_CERT_DIR="/tmp/mongo-certs"
    mkdir -p "$TEMP_CERT_DIR"
    cp "/etc/ssl/mongo/combined.pem" "$TEMP_CERT_DIR/combined.pem"
    cp "/etc/ssl/mongo/chain.pem"    "$TEMP_CERT_DIR/chain.pem"
    chmod 644 "$TEMP_CERT_DIR"/*

    # 2) Test connectivity from a separate ephemeral container:
    log "Testing connectivity to MongoDB with auth & TLS..."
    docker run --rm --network=internal \
      -v "$TEMP_CERT_DIR:/certs:ro" \
      mongo:6.0 \
      mongosh "mongodb://mongodb.cloudlunacy.uk:27017" \
        --tls \
        --tlsCAFile /certs/chain.pem \
        --tlsCertificateKeyFile /certs/combined.pem \
        -u "$MONGO_INITDB_ROOT_USERNAME" \
        -p "$MONGO_INITDB_ROOT_PASSWORD" \
        --authenticationDatabase admin \
        --eval "db.runCommand({ ping: 1 })"

    # 3) Create the management user with the root credentials:
    log "Creating management user..."
    MONGO_COMMAND="db.getSiblingDB('admin').createUser({
        user: '$MONGO_MANAGER_USERNAME',
        pwd: '$MONGO_MANAGER_PASSWORD',
        roles: [
          {role: 'userAdminAnyDatabase', db: 'admin'},
          {role: 'readWriteAnyDatabase', db: 'admin'}
        ]
    });"

    docker run --rm --network=internal \
      -v "$TEMP_CERT_DIR:/certs:ro" \
      mongo:6.0 \
      mongosh "mongodb://mongodb.cloudlunacy.uk:27017" \
        --tls \
        --tlsCAFile /certs/chain.pem \
        --tlsCertificateKeyFile /certs/combined.pem \
        -u "$MONGO_INITDB_ROOT_USERNAME" \
        -p "$MONGO_INITDB_ROOT_PASSWORD" \
        --authenticationDatabase admin \
        --eval "$MONGO_COMMAND"

    # 4) Remove temporary cert directory from the host
    rm -rf "$TEMP_CERT_DIR"
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
    if [ -f "$MONGO_ENV_FILE" ]; then
        source "$MONGO_ENV_FILE"
    else
        log_error "MongoDB environment file not found at $MONGO_ENV_FILE."
        exit 1
    fi

    cat <<EOF > "$ENV_FILE"
BACKEND_URL=$BACKEND_URL
AGENT_API_TOKEN=$AGENT_TOKEN
SERVER_ID=$SERVER_ID
MONGO_MANAGER_USERNAME=$MONGO_MANAGER_USERNAME
MONGO_MANAGER_PASSWORD=$MONGO_MANAGER_PASSWORD
MONGO_HOST=$DOMAIN
MONGO_PORT=27017
EOF

    chown "$USERNAME":"$USERNAME" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    log "Environment variables configured."
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

    cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=CloudLunacy Deployment Agent
After=network.target docker.service
Requires=docker.service

[Service]
ExecStart=/usr/bin/node $BASE_DIR/agent.js
WorkingDirectory=$BASE_DIR
Restart=always
RestartSec=5
User=$USERNAME
Group=docker
Environment=HOME=$BASE_DIR
Environment=PATH=/usr/local/bin:/usr/bin:/bin
EnvironmentFile=$BASE_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable cloudlunacy
    systemctl start cloudlunacy

    log "CloudLunacy service set up and started."
}

verify_installation() {
    log "Verifying CloudLunacy Deployment Agent installation..."
    if systemctl is-active --quiet cloudlunacy; then
        log "CloudLunacy Deployment Agent is running successfully."
    else
        log_error "CloudLunacy Deployment Agent failed to start. Check the logs for details."
        exit 1
    fi

    log "Verifying Traefik installation..."
    if docker ps | grep -q "traefik"; then
        log "Traefik is running successfully."
    else
        log_error "Traefik failed to start. Check Docker logs for details."
        exit 1
    fi
}

completion_message() {
    echo -e "\033[0;35m
   ____                            _         _       _   _                 _
  / ___|___  _ __   __ _ _ __ __ _| |_ _   _| | __ _| |_(_) ___  _ __  ___| |
 | |   / _ \\| '_ \\ / _\` | '__/ _\` | __| | | | |/ _\` | __| |/ _ \\| '_ \\/ __| |
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

    detect_os
    log "Detected OS: $OS_TYPE $OS_VERSION"

    update_system
    install_dependencies
    install_certbot
    install_mongosh
    install_docker
    install_node
    setup_user_directories
    setup_docker_permissions
    download_agent
    install_agent_dependencies
    stop_conflicting_containers
    obtain_ssl_certificate
    create_combined_certificate
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