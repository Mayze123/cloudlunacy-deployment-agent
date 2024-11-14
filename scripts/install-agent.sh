#!/bin/bash
# ------------------------------------------------------------------------------
# Installation Script for CloudLunacy Deployment Agent
# Version: 1.5.2
# Author: Mahamadou Taibou
# Date: 2024-11-02
#
# Description:
# This script installs and configures the CloudLunacy Deployment Agent on a VPS.
# It performs the following tasks:
#   - Detects the operating system and version
#   - Updates system packages
#   - Installs necessary dependencies (Docker, Node.js, Git, jq)
#   - Creates a dedicated user with a home directory and correct permissions
#   - Downloads the latest version of the Deployment Agent from GitHub
#   - Installs Node.js dependencies
#   - Configures environment variables
#   - Sets up the Deployment Agent as a systemd service
#   - Generates SSH keys for private repository access
#   - Provides post-installation verification and feedback
#
# Usage:
#   sudo ./install-agent.sh <AGENT_TOKEN> <SERVER_ID> [BACKEND_BASE_URL] [GITHUB_SSH_KEY]
#
# Arguments:
#   AGENT_TOKEN      - Unique token for agent authentication
#   SERVER_ID        - Unique identifier for the server
#   BACKEND_BASE_URL - (Optional) Backend base URL; defaults to https://your-default-backend-url
#   GITHUB_SSH_KEY   - (Optional) Path to existing SSH private key for accessing private repos
# ------------------------------------------------------------------------------

set -euo pipefail
# Uncomment the following line to enable debugging
# set -x
IFS=$'\n\t'

# ----------------------------
# Function Definitions
# ----------------------------

# Function to display script information
display_info() {
    echo "-------------------------------------------------"
    echo "CloudLunacy Deployment Agent Installation Script"
    echo "Version: 1.5.2"
    echo "Author: Mahamadou Taibou"
    echo "Date: 2024-11-02"
    echo "-------------------------------------------------"
}

# Function to log messages
log() {
    echo -e "\033[1;32m[INFO]\033[0m $1"
}

log_warn() {
    echo -e "\033[1;33m[WARNING]\033[0m $1"
}

log_error() {
    echo -e "\033[1;31m[ERROR]\033[0m $1"
}

# Function to check for required arguments
check_args() {
    if [ "$#" -lt 2 ] || [ "$#" -gt 4 ]; then
        log_error "Invalid number of arguments."
        echo "Usage: $0 <AGENT_TOKEN> <SERVER_ID> [BACKEND_BASE_URL] [GITHUB_SSH_KEY]"
        exit 1
    fi
}

# Function to check for root privileges
check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        log_error "This script must be run as root. Please run it with sudo."
        exit 1
    fi
}

# Function to detect OS and version
detect_os() {
    OS_TYPE=$(grep -w "ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
    OS_VERSION=$(grep -w "VERSION_ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')

    # Normalize OS names
    case "$OS_TYPE" in
        manjaro | manjaro-arm)
            OS_TYPE="arch"
            OS_VERSION="rolling"
            ;;
        fedora-asahi-remix)
            OS_TYPE="fedora"
            ;;
        pop | linuxmint | zorin)
            OS_TYPE="ubuntu"
            ;;
        *)
            ;;
    esac
}

# Function to update system packages
update_system() {
    log "Updating system packages..."
    case "$OS_TYPE" in
        ubuntu | debian | raspbian)
            apt-get update -y && apt-get upgrade -y
            ;;
        arch)
            pacman -Syu --noconfirm
            ;;
        alpine)
            apk update && apk upgrade
            ;;
        centos | fedora | rhel | ol | rocky | almalinux | amzn)
            if command -v dnf >/dev/null 2>&1; then
                dnf upgrade -y
            else
                yum update -y
            fi
            ;;
        sles | opensuse-leap | opensuse-tumbleweed)
            zypper refresh && zypper update -y
            ;;
        *)
            log_error "Unsupported OS: $OS_TYPE $OS_VERSION"
            exit 1
            ;;
    esac
    log "System packages updated."
}

# Function to install dependencies
install_dependencies() {
    log "Installing dependencies (curl, wget, git, jq)..."
    case "$OS_TYPE" in
        ubuntu | debian | raspbian)
            apt-get install -y curl wget git jq coreutils apache2-utils
            ;;
        arch)
            pacman -S --noconfirm curl wget git jq coreutils apache2-utils
            ;;
        alpine)
            apk add --no-cache curl wget git jq coreutils apache2-utils
            ;;
        centos | fedora | rhel | ol | rocky | almalinux | amzn)
            if [ "$OS_TYPE" = "amzn" ]; then
                yum install -y curl wget git jq coreutils httpd-tools
            else
                if ! command -v dnf >/dev/null 2>&1; then
                    yum install -y dnf
                fi
                dnf install -y curl wget git jq coreutils httpd-tools
            fi
            ;;
        sles | opensuse-leap | opensuse-tumbleweed)
            zypper install -y curl wget git jq coreutils apache2-utils
            ;;
        *)
            log_error "Unsupported OS: $OS_TYPE $OS_VERSION"
            exit 1
            ;;
    esac
    log "Dependencies installed."
}

# Function to install Docker
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
        DOCKER_COMPOSE_VERSION="2.24.1"  # Update this version as needed
        
        # Download and install docker-compose binary
        curl -L "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
        chmod +x /usr/local/bin/docker-compose
        
        # Create symlink
        ln -sf /usr/local/bin/docker-compose /usr/bin/docker-compose
        
        log "Docker Compose installed successfully."
    fi
}

# Function to install Node.js
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
        sles | opensuse-leap | opensuse-tumbleweed)
            curl -fsSL https://rpm.nodesource.com/setup_$NODE_VERSION | bash -
            zypper install -y nodejs
            ;;
        *)
            log_error "Node.js installation not supported on this OS."
            exit 1
            ;;
    esac

    log "Node.js installed successfully."
}

# Add this at the beginning of the script, after the IFS declaration
USERNAME="cloudlunacy"
BASE_DIR="/opt/cloudlunacy"

# Function to create dedicated user and directories
setup_user_directories() {
    log "Creating dedicated user and directories..."
    USERNAME="cloudlunacy"
    BASE_DIR="/opt/cloudlunacy"

    if id "$USERNAME" &>/dev/null; then
        log "User '$USERNAME' already exists."
        usermod -aG docker "$USERNAME"
        usermod -d "$BASE_DIR" "$USERNAME"
    else
        useradd -m -d "$BASE_DIR" -G docker -s /bin/bash "$USERNAME"
        log "User '$USERNAME' created and added to docker group."
    fi

    # Create base directories with correct permissions
    mkdir -p "$BASE_DIR"
    
    # Explicitly create and set permissions for logs directory
    mkdir -p "$BASE_DIR/logs"
    chown -R "$USERNAME:docker" "$BASE_DIR/logs"
    chmod -R 775 "$BASE_DIR/logs"  # Group writable for docker group

    # Create other directories
    mkdir -p "$BASE_DIR"/{ssh,config,bin,deployments}
    chown -R "$USERNAME:docker" "$BASE_DIR"
    find "$BASE_DIR" -type d -exec chmod 775 {} \;
    find "$BASE_DIR" -type f -exec chmod 664 {} \;

    # Special permissions for ssh directory
    chmod 700 "$BASE_DIR/ssh"

    log "Directories created at $BASE_DIR."
}

# Function to download and verify the latest agent
download_agent() {
    log "Cloning the CloudLunacy Deployment Agent repository..."

    # First, backup any existing .env file if it exists
    if [ -f "$BASE_DIR/.env" ]; then
        cp "$BASE_DIR/.env" "/tmp/cloudlunacy.env.backup"
    fi

    # Remove contents of BASE_DIR while preserving the directory
    if [ -d "$BASE_DIR" ]; then
        # Remove all contents except .env backup
        find "$BASE_DIR" -mindepth 1 -delete
    fi

    # Ensure the base directory exists with correct ownership
    mkdir -p "$BASE_DIR"
    chown "$USERNAME":"$USERNAME" "$BASE_DIR"

    # Create temporary directory with correct permissions
    mkdir -p "$BASE_DIR.tmp"
    chown "$USERNAME":"$USERNAME" "$BASE_DIR.tmp"

    # Clone the repository
    sudo -u "$USERNAME" git clone https://github.com/Mayze123/cloudlunacy-deployment-agent.git "$BASE_DIR.tmp"
    mv "$BASE_DIR.tmp"/* "$BASE_DIR/"
    rm -rf "$BASE_DIR.tmp"

    # Restore .env file if it was backed up
    if [ -f "/tmp/cloudlunacy.env.backup" ]; then
        mv "/tmp/cloudlunacy.env.backup" "$BASE_DIR/.env"
    fi

    chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"
    log "Agent cloned to $BASE_DIR."
}

# Function to install agent dependencies
install_agent_dependencies() {
    log "Installing agent dependencies..."
    cd "$BASE_DIR"

    # Remove existing node_modules and package-lock.json
    rm -rf node_modules package-lock.json

    # Set NPM cache directory within base directory
    NPM_CACHE_DIR="$BASE_DIR/.npm-cache"
    mkdir -p "$NPM_CACHE_DIR"
    chown -R "$USERNAME":"$USERNAME" "$NPM_CACHE_DIR"

    # Run npm install as the cloudlunacy user
    if [ -f "package.json" ]; then
        sudo -u "$USERNAME" HOME="$BASE_DIR" npm install --cache "$NPM_CACHE_DIR" --no-fund --no-audit
    else
        sudo -u "$USERNAME" HOME="$BASE_DIR" npm init -y
        sudo -u "$USERNAME" HOME="$BASE_DIR" npm install axios dotenv winston bcryptjs shelljs ws handlebars js-yaml --cache "$NPM_CACHE_DIR" --no-fund --no-audit
    fi

    log "Agent dependencies installed."
}

# Function to configure environment variables
configure_env() {
    log "Configuring environment variables..."
    ENV_FILE="$BASE_DIR/.env"

    cat <<EOF > "$ENV_FILE"
BACKEND_URL=$BACKEND_URL
AGENT_API_TOKEN=$AGENT_TOKEN
SERVER_ID=$SERVER_ID
NODE_ENV=production
LOG_LEVEL=info
EOF

    chown "$USERNAME":"$USERNAME" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    log "Environment variables configured."
}

# Function to set up SSH for private repositories
setup_ssh() {
    log "Setting up SSH for accessing private repositories..."

    SSH_DIR="$BASE_DIR/.ssh"
    sudo -u "$USERNAME" mkdir -p "$SSH_DIR"
    sudo -u "$USERNAME" chmod 700 "$SSH_DIR"

    # Check if a custom SSH key was provided
    if [ -n "${GITHUB_SSH_KEY:-}" ] && [ -f "$GITHUB_SSH_KEY" ]; then
        log "Using provided SSH key."
        sudo -u "$USERNAME" cp "$GITHUB_SSH_KEY" "$SSH_DIR/id_ed25519"
    else
        log "Generating new SSH key for agent..."
        sudo -u "$USERNAME" ssh-keygen -t ed25519 -f "$SSH_DIR/id_ed25519" -N ""
    fi

    sudo -u "$USERNAME" chmod 600 "$SSH_DIR/id_ed25519"
    sudo -u "$USERNAME" touch "$SSH_DIR/config"
    sudo -u "$USERNAME" bash -c 'cat <<EOF > /opt/cloudlunacy/.ssh/config
Host github.com
    HostName github.com
    User git
    IdentityFile /opt/cloudlunacy/.ssh/id_ed25519
    StrictHostKeyChecking no
EOF'

    sudo -u "$USERNAME" chmod 600 "$SSH_DIR/config"
    log "SSH setup completed."
}

setup_nginx_proxy() {
    log "Setting up Nginx Proxy..."
    
    # Get user's UID and GID
    USER_UID=$(id -u "$USERNAME")
    USER_GID=$(id -g "$USERNAME")
    
    # Check if anything is using port 80
    if lsof -i :80 >/dev/null 2>&1; then
        log_warn "Port 80 is in use. Stopping system nginx if running..."
        systemctl stop nginx || true
        systemctl disable nginx || true
    fi

    # Create all required directories with correct ownership
    log "Creating nginx directories..."
    mkdir -p "${BASE_DIR}/nginx/"{conf.d,vhost.d,html,certs,temp/{client,proxy,fastcgi,uwsgi,scgi}}
    chown -R "$USERNAME:$USERNAME" "${BASE_DIR}/nginx"
    chmod -R 775 "${BASE_DIR}/nginx"
    
    # Create dedicated network for proxy
    docker network create nginx-proxy || true
    
    # Remove existing proxy container if it exists
    docker rm -f nginx-proxy >/dev/null 2>&1 || true

    # Create base nginx configuration
    cat > "${BASE_DIR}/nginx/nginx.conf" << EOF
worker_processes auto;
pid /tmp/nginx.pid;

events {
    worker_connections 768;
}

http {
    client_body_temp_path /temp/client;
    proxy_temp_path /temp/proxy;
    fastcgi_temp_path /temp/fastcgi;
    uwsgi_temp_path /temp/uwsgi;
    scgi_temp_path /temp/scgi;

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    access_log /dev/stdout;
    error_log /dev/stderr;

    gzip on;

    include /etc/nginx/conf.d/*.conf;
}
EOF
    
    # Create nginx proxy container
    cat > "$BASE_DIR/docker-compose.proxy.yml" << EOF
version: "3.8"
services:
  nginx-proxy:
    image: nginx:alpine
    container_name: nginx-proxy
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ${BASE_DIR}/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ${BASE_DIR}/nginx/conf.d:/etc/nginx/conf.d
      - ${BASE_DIR}/nginx/vhost.d:/etc/nginx/vhost.d
      - ${BASE_DIR}/nginx/html:/usr/share/nginx/html
      - ${BASE_DIR}/nginx/certs:/etc/nginx/certs:ro
      - ${BASE_DIR}/nginx/temp:/temp
    networks:
      - nginx-proxy
    user: "${USER_UID}:${USER_GID}"
networks:
  nginx-proxy:
    external: true
EOF
    
    # Create default configuration
    cat > "${BASE_DIR}/nginx/conf.d/default.conf" << EOF
server {
    listen 80 default_server;
    server_name _;
    
    location / {
        return 200 'Server is running\n';
        add_header Content-Type text/plain;
    }
}
EOF

    # Ensure proper ownership of all files
    chown "$USERNAME:$USERNAME" "$BASE_DIR/docker-compose.proxy.yml"
    chown "$USERNAME:$USERNAME" "${BASE_DIR}/nginx/nginx.conf"
    chown "$USERNAME:$USERNAME" "${BASE_DIR}/nginx/conf.d/default.conf"
    chmod 664 "${BASE_DIR}/nginx/conf.d/default.conf"
    chmod 664 "${BASE_DIR}/nginx/nginx.conf"

    # Start the proxy
    docker-compose -f "$BASE_DIR/docker-compose.proxy.yml" up -d

    # Wait a moment for the container to start
    sleep 2

    # Check if container is running
    if ! docker ps | grep -q nginx-proxy; then
        log_error "Failed to start nginx proxy. Check docker logs:"
        docker logs nginx-proxy
        exit 1
    fi

    log "Nginx Proxy setup completed successfully"
}

setup_traefik_proxy() {
    log "Setting up Traefik Proxy..."
    
    # Create cloudlunacy group if it doesn't exist
    groupadd -f cloudlunacy

    # Get user's UID and GID
    USER_UID=$(id -u "$USERNAME")
    GROUP_GID=$(getent group cloudlunacy | cut -d: -f3)

    # Ensure user is in both cloudlunacy and docker groups
    usermod -aG docker,cloudlunacy "$USERNAME"

    # Check if anything is using required ports
    if lsof -i :80 >/dev/null 2>&1 || lsof -i :443 >/dev/null 2>&1; then
        log_warn "Port 80 or 443 is in use. Stopping system nginx if running..."
        systemctl stop nginx || true
        systemctl disable nginx || true
    fi

    # First remove any existing Traefik setup
    rm -rf "${BASE_DIR}/traefik"

    # Create all required directories
    log "Creating Traefik directories..."
    mkdir -p "${BASE_DIR}/traefik"/{dynamic,acme,logs}

    # Set proper ownership and permissions with both groups
    chown -R "$USERNAME:cloudlunacy" "${BASE_DIR}"
    chmod 775 "${BASE_DIR}"
    chown -R "$USERNAME:cloudlunacy" "${BASE_DIR}/traefik"
    chmod 775 "${BASE_DIR}/traefik"

    # Ensure the base directory and its parent exist with correct permissions
    mkdir -p "/opt/cloudlunacy"
    chown -R "$USERNAME:cloudlunacy" "/opt/cloudlunacy"
    chmod 775 "/opt/cloudlunacy"

    # Set permissions for subdirectories
    find "${BASE_DIR}/traefik" -type d -exec chmod 775 {} \;
    find "${BASE_DIR}/traefik" -type f -exec chmod 664 {} \;

    # Set proper permissions for docker.sock
    if [ -e "/var/run/docker.sock" ]; then
        chmod 666 /var/run/docker.sock
    fi

    # Create base configuration file
    CONFIG_FILE="${BASE_DIR}/traefik/traefik.yml"
    touch "$CONFIG_FILE"
    chown "$USERNAME:cloudlunacy" "$CONFIG_FILE"
    chmod 664 "$CONFIG_FILE"

    # Create and secure acme.json with special permissions
    touch "${BASE_DIR}/traefik/acme/acme.json"
    chown "$USERNAME:cloudlunacy" "${BASE_DIR}/traefik/acme/acme.json"
    chmod 600 "${BASE_DIR}/traefik/acme/acme.json"

    # Generate secure credentials for Traefik dashboard
    DASHBOARD_PASSWORD=$(openssl rand -base64 32)
    HASHED_PASSWORD=$(openssl passwd -apr1 "$DASHBOARD_PASSWORD")

    # Escape $ symbols in the hashed password
    ESCAPED_HASHED_PASSWORD=$(echo "$HASHED_PASSWORD" | sed 's/\$/\$\$/g')

    # Write Traefik configuration
    cat > "$CONFIG_FILE" << 'EOF'
global:
  checkNewVersion: true
  sendAnonymousUsage: false

log:
  level: INFO
  filePath: "/etc/traefik/logs/traefik.log"

accessLog:
  filePath: "/etc/traefik/logs/access.log"
  bufferingSize: 100

api:
  dashboard: true
  insecure: false

entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ":443"
    http:
      tls:
        certResolver: letsencrypt

providers:
  docker:
    endpoint: "unix:///var/run/docker.sock"
    watch: true
    exposedByDefault: false
    network: traefik-proxy
  file:
    directory: "/etc/traefik/dynamic"
    watch: true

certificatesResolvers:
  letsencrypt:
    acme:
      email: "admin@example.com"
      storage: "/etc/traefik/acme/acme.json"
      httpChallenge:
        entryPoint: web
EOF

    # Ensure the config file has correct permissions
    chown "$USERNAME:cloudlunacy" "$CONFIG_FILE"
    chmod 664 "$CONFIG_FILE"

    # Create docker-compose file for Traefik with proper permissions
    COMPOSE_FILE="${BASE_DIR}/docker-compose.proxy.yml"

    # First ensure the directory exists with correct permissions
    mkdir -p "$(dirname "$COMPOSE_FILE")"
    chown "$USERNAME:cloudlunacy" "$(dirname "$COMPOSE_FILE")"
    chmod 775 "$(dirname "$COMPOSE_FILE")"

    # Create the compose file
    cat > "$COMPOSE_FILE" << EOF
version: "3.8"
services:
  traefik-proxy:
    image: traefik:v2.10
    container_name: traefik-proxy
    restart: always
    security_opt:
      - no-new-privileges:true
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /etc/localtime:/etc/localtime:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ${BASE_DIR}/traefik/traefik.yml:/etc/traefik/traefik.yml:ro
      - ${BASE_DIR}/traefik/dynamic:/etc/traefik/dynamic:ro
      - ${BASE_DIR}/traefik/acme:/etc/traefik/acme
      - ${BASE_DIR}/traefik/logs:/etc/traefik/logs
    networks:
      - traefik-proxy
    user: "${USER_UID}:${GROUP_GID}"
    environment:
      - TZ=UTC
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.dashboard.rule=Host(\`traefik.localhost\`)"
      - "traefik.http.routers.dashboard.service=api@internal"
      - "traefik.http.routers.dashboard.middlewares=auth-middleware"
      - "traefik.http.middlewares.auth-middleware.basicauth.users=${USERNAME}:${ESCAPED_HASHED_PASSWORD}"

networks:
  traefik-proxy:
    external: true
EOF

    # Set proper permissions for the compose file
    chown "$USERNAME:cloudlunacy" "$COMPOSE_FILE"
    chmod 664 "$COMPOSE_FILE"

    # Ensure docker network exists
    docker network create traefik-proxy 2>/dev/null || true

    # Remove existing container if it exists
    docker rm -f traefik-proxy 2>/dev/null || true

    # Start Traefik with proper permissions
    log "Starting Traefik proxy..."
    if ! sudo -u "$USERNAME" docker-compose -f "$COMPOSE_FILE" up -d; then
        log_error "Failed to start Traefik proxy"
        docker-compose -f "$COMPOSE_FILE" logs
        exit 1
    fi

    # Verify Traefik is running
    sleep 5
    if ! docker ps | grep -q traefik-proxy; then
        log_error "Traefik proxy failed to start. Logs:"
        docker logs traefik-proxy
        exit 1
    fi

    # Save dashboard credentials
    CREDS_FILE="${BASE_DIR}/traefik/dashboard_credentials.txt"
    cat > "$CREDS_FILE" << EOF
Traefik Dashboard Credentials
----------------------------
Username: ${USERNAME}
Password: ${DASHBOARD_PASSWORD}

IMPORTANT: Please save these credentials securely and delete this file afterwards.
EOF

    chown "$USERNAME:cloudlunacy" "$CREDS_FILE"
    chmod 600 "$CREDS_FILE"

    log "Traefik Proxy setup completed successfully"
    log "Dashboard credentials saved to: ${CREDS_FILE}"
}

fix_directory_permissions() {
    local dir=$1
    local user=$2
    local group="docker"  # Always use docker group
    
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
    fi
    
    chown -R "$user:$group" "$dir"
    chmod 775 "$dir"
    find "$dir" -type d -exec chmod 775 {} \;
    find "$dir" -type f -exec chmod 664 {} \;
}


setup_deployment_templates() {
    log "Setting up deployment templates..."
    
    # Templates directory is already at BASE_DIR/templates
    TEMPLATES_DIR="${BASE_DIR}/templates"

    # No need to copy, just set proper permissions
    if [ -d "$TEMPLATES_DIR" ]; then
        # Set proper permissions
        chown -R "$USERNAME:$USERNAME" "$TEMPLATES_DIR"
        chmod 755 "$TEMPLATES_DIR"
        find "$TEMPLATES_DIR" -type f -exec chmod 644 {} \;
        log "Deployment templates permissions updated"
    else
        log_error "Templates directory not found at ${TEMPLATES_DIR}"
        exit 1
    fi
}

setup_docker_permissions() {
    log "Setting up Docker permissions..."
    
    # Add cloudlunacy user to docker group
    usermod -aG docker cloudlunacy

    # Set docker.sock permissions
    chmod 666 /var/run/docker.sock
    
    # Create deployment directories with correct permissions
    mkdir -p /opt/cloudlunacy/deployments
    mkdir -p /tmp/cloudlunacy-deployments
    
    # Set permissions
    chown -R cloudlunacy:docker /opt/cloudlunacy
    chmod 775 /opt/cloudlunacy/deployments
    chmod 775 /tmp/cloudlunacy-deployments
    
    log "Docker permissions configured successfully."
}

verify_backend_connection() {
    log "Verifying backend connection..."
    
    # Wait for service to start
    sleep 5
    
    # Check if service is running
    if ! systemctl is-active --quiet cloudlunacy
    then
        log_error "Agent service is not running"
        journalctl -u cloudlunacy -n 50 --no-pager
        exit 1
    fi
    
    # Check for specific error messages first
    if journalctl -u cloudlunacy -n 50 | grep -q "Error in authentication request"
    then
        log_error "Authentication failed with backend. Check your AGENT_TOKEN and SERVER_ID"
        journalctl -u cloudlunacy -n 50 --no-pager
        exit 1
    fi
    
    if journalctl -u cloudlunacy -n 50 | grep -q "No response received from backend"
    then
        log_error "Could not reach backend server. Check your BACKEND_URL and network connectivity"
        journalctl -u cloudlunacy -n 50 --no-pager
        exit 1
    fi
    
    # Check for successful connection
    if ! journalctl -u cloudlunacy -n 50 | grep -q "WebSocket connection established"
    then
        log_error "Agent failed to connect to backend. Checking logs..."
        journalctl -u cloudlunacy -n 50 --no-pager
        exit 1
    fi
    
    log "Backend connection verified successfully"
}

restart_agent() {
    log "Restarting CloudLunacy agent..."
    systemctl restart cloudlunacy
    sleep 5
    
    if ! systemctl is-active --quiet cloudlunacy
    then
        log_error "Agent failed to restart"
        journalctl -u cloudlunacy -n 50 --no-pager
        exit 1
    fi
    
    log "Agent restarted successfully"
}

# Function to set up systemd service
setup_service() {
    log "Setting up CloudLunacy Deployment Agent as a systemd service..."
    SERVICE_FILE="/etc/systemd/system/cloudlunacy.service"

    # Get UID and GID
    USER_UID=$(id -u cloudlunacy)
    DOCKER_GID=$(getent group docker | cut -d: -f3)

    cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=CloudLunacy Deployment Agent
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
ExecStartPre=/bin/mkdir -p /opt/cloudlunacy/logs
ExecStartPre=/bin/chown -R cloudlunacy:docker /opt/cloudlunacy/logs
ExecStartPre=/bin/chmod -R 775 /opt/cloudlunacy/logs
ExecStart=/usr/bin/node $BASE_DIR/agent.js
WorkingDirectory=$BASE_DIR
Restart=always
RestartSec=5
User=cloudlunacy
Group=docker
Environment=HOME=$BASE_DIR
Environment=USER_UID=$USER_UID
Environment=USER_GID=$DOCKER_GID
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=NODE_ENV=production
EnvironmentFile=$BASE_DIR/.env

# Security settings
NoNewPrivileges=yes
ProtectSystem=full
ReadWritePaths=/opt/cloudlunacy
PrivateTmp=true

# Resource limits
LimitNOFILE=65535
LimitNPROC=65535

[Install]
WantedBy=multi-user.target
EOF

    chmod 644 "$SERVICE_FILE"

    # Create logs directory with proper permissions
    mkdir -p "/opt/cloudlunacy/logs"
    chown -R cloudlunacy:docker "/opt/cloudlunacy/logs"
    chmod -R 775 "/opt/cloudlunacy/logs"

    # Reload systemd and enable/start service
    systemctl daemon-reload
    systemctl enable cloudlunacy
    systemctl start cloudlunacy

    # Verify service status
    if ! systemctl is-active --quiet cloudlunacy; then
        log_error "Service failed to start. Checking logs..."
        journalctl -u cloudlunacy -n 50 --no-pager
        exit 1
    fi
    
    log "CloudLunacy service set up and started successfully."

    # Show status
    systemctl status cloudlunacy
}

# Function to verify installation
verify_installation() {
    log "Verifying CloudLunacy Deployment Agent installation..."
    if systemctl is-active --quiet cloudlunacy; then
        log "CloudLunacy Deployment Agent is running successfully."
    else
        log_error "CloudLunacy Deployment Agent failed to start. Check the logs for details."
        exit 1
    fi
}

# Function to display completion message
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

    PUBLIC_IP=$(curl -s https://api.ipify.org)
    if [ -z "$PUBLIC_IP" ]; then
        PUBLIC_IP="your_server_ip"
        echo -e "Could not retrieve public IP address. Please replace 'your_server_ip' with your actual IP."
    fi

    echo -e "Access it by visiting: http://$PUBLIC_IP:8000"
    echo -e "Logs are located at: $BASE_DIR/logs/agent.log"
    echo -e "It's recommended to back up your environment file:"
    echo -e "cp $BASE_DIR/.env $BASE_DIR/.env.backup"
}

# Function to handle cleanup on error
cleanup_on_error() {
    log_error "Installation encountered an error. Cleaning up..."
    rm -rf "$BASE_DIR"
    exit 1
}

# Function to display SSH key instructions
display_ssh_instructions() {
    SSH_DIR="$BASE_DIR/.ssh"
    PUBLIC_KEY_FILE="$SSH_DIR/id_ed25519.pub"
    log "SSH Key Setup Instructions:"
    log "----------------------------------------"
    log "1. Add the following SSH public key to your Git repository's deploy keys:"
    echo "----------------------------------------"
    if [ -f "$PUBLIC_KEY_FILE" ]; then
        cat "$PUBLIC_KEY_FILE"
    else
        log_error "Public SSH key not found at $PUBLIC_KEY_FILE."
    fi
    echo "----------------------------------------"
    log "2. Ensure that the deploy key has read access to the repository."
}

fix_traefik_permissions() {
    log "Fixing Traefik permissions..."
    
    # Get docker group GID
    DOCKER_GID=$(getent group docker | cut -d: -f3)
    
    # Ensure user is in docker group
    usermod -aG docker "$USERNAME"
    
    # Fix base permissions
    chown -R "$USERNAME:docker" "${BASE_DIR}/traefik"
    find "${BASE_DIR}/traefik" -type d -exec chmod 775 {} \;
    find "${BASE_DIR}/traefik" -type f -exec chmod 664 {} \;
    
    # Special permissions for acme.json
    chmod 600 "${BASE_DIR}/traefik/acme/acme.json"
    
    # Fix docker socket permissions
    chmod 666 /var/run/docker.sock
    
    log "Traefik permissions fixed"
}

# ----------------------------
# Main Execution Flow
# ----------------------------

# Trap errors and perform cleanup
trap cleanup_on_error ERR

main() {
    check_root
    display_info
    check_args "$@"

    AGENT_TOKEN="$1"
    SERVER_ID="$2"
    BACKEND_BASE_URL="${3:-https://your-default-backend-url}"
    GITHUB_SSH_KEY="${4:-}"

    BACKEND_URL="${BACKEND_BASE_URL}"

    detect_os
    log "Detected OS: $OS_TYPE $OS_VERSION"

    update_system
    install_dependencies
    install_docker
    install_node
    setup_user_directories
    setup_docker_permissions
    setup_ssh "$GITHUB_SSH_KEY"
    download_agent
    install_agent_dependencies
    setup_deployment_templates
    configure_env
    setup_service
    verify_installation
    verify_backend_connection  # First verify base connection works
    setup_traefik_proxy
    fix_traefik_permissions
    restart_agent  # Restart agent after traefik setup
    verify_backend_connection  # Verify connection again after traefik
    completion_message
}

main "$@"