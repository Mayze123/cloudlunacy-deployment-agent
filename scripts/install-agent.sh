#!/bin/bash
# ------------------------------------------------------------------------------
# Installation Script for CloudLunacy Deployment Agent with Traefik
# Version: 2.1.0
# Author: Mahamadou Taibou
# Date: 2024-11-22
#
# Description:
# This script installs and configures the CloudLunacy Deployment Agent on a VPS.
# It performs the following tasks:
#   - Detects the operating system and version
#   - Updates system packages
#   - Installs necessary dependencies (Docker, Node.js, Git, jq)
#   - Sets up Traefik as a reverse proxy
#   - Creates a dedicated user with correct permissions
#   - Downloads the latest version of the Deployment Agent from GitHub
#   - Installs Node.js dependencies
#   - Configures environment variables
#   - Sets up the Deployment Agent as a systemd service
#   - Generates SSH keys for private repository access
#   - Provides post-installation verification and feedback
#
# Usage:
#   sudo ./install-agent.sh <AGENT_TOKEN> <SERVER_ID> <EMAIL> [BACKEND_BASE_URL] [GITHUB_SSH_KEY]
#
# Arguments:
#   AGENT_TOKEN      - Unique token for agent authentication
#   SERVER_ID        - Unique identifier for the server
#   EMAIL            - Email address for Traefik's Let's Encrypt
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
    echo "Version: 2.1.0"
    echo "Author: Mahamadou Taibou"
    echo "Date: 2024-11-22"
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
    if [ "$#" -lt 3 ] || [ "$#" -gt 5 ]; then
        log_error "Invalid number of arguments."
        echo "Usage: $0 <AGENT_TOKEN> <SERVER_ID> <EMAIL> [BACKEND_BASE_URL] [GITHUB_SSH_KEY]"
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
}

# Function to update system packages
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

# Function to install dependencies
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
        *)
            log_error "Node.js installation not supported on this OS."
            exit 1
            ;;
    esac

    log "Node.js installed successfully."
}

# Function to create dedicated user and directories
setup_user_directories() {
    log "Creating dedicated user and directories..."
    USERNAME="cloudlunacy"
    BASE_DIR="/opt/cloudlunacy"

    if id "$USERNAME" &>/dev/null; then
        log "User '$USERNAME' already exists."
        usermod -d "$BASE_DIR" "$USERNAME"
    else
        useradd -m -d "$BASE_DIR" -r -s /bin/bash "$USERNAME"
        log "User '$USERNAME' created."
    fi

    # Ensure base directory exists and has correct permissions
    mkdir -p "$BASE_DIR"
    chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"
    chmod -R 750 "$BASE_DIR"

    # Create subdirectories
    mkdir -p "$BASE_DIR"/{logs,ssh,config,bin,deployments,traefik}
    chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"/{logs,ssh,config,bin,deployments,traefik}

    log "Directories created at $BASE_DIR."
}

# Function to download and verify the latest agent
download_agent() {
    log "Cloning the CloudLunacy Deployment Agent repository..."
    if [ -d "$BASE_DIR" ]; then
        rm -rf "$BASE_DIR"
    fi
    # Recreate the base directory and set ownership
    mkdir -p "$BASE_DIR"
    chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"

    sudo -u "$USERNAME" git clone https://github.com/Mayze123/cloudlunacy-deployment-agent.git "$BASE_DIR"
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
        sudo -u "$USERNAME" HOME="$BASE_DIR" npm install axios dotenv winston joi shelljs ws handlebars js-yaml --cache "$NPM_CACHE_DIR" --no-fund --no-audit
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
    sudo -u "$USERNAME" bash -c 'cat <<EOF > '"$SSH_DIR"'/config
Host github.com
    HostName github.com
    User git
    IdentityFile '"$SSH_DIR"'/id_ed25519
    StrictHostKeyChecking no
EOF'

    sudo -u "$USERNAME" chmod 600 "$SSH_DIR/config"
    log "SSH setup completed."
}

# Function to set up Docker permissions
setup_docker_permissions() {
    log "Setting up Docker permissions..."

    # Add cloudlunacy user to docker group
    usermod -aG docker "$USERNAME"

    # Set permissions
    chown -R "$USERNAME":docker "$BASE_DIR"
    chmod -R 775 "$BASE_DIR/deployments"
    chmod 666 /var/run/docker.sock

    log "Docker permissions configured successfully."
}

# Function to set up Traefik
setup_traefik() {
    log "Setting up Traefik as a reverse proxy..."

    TRAEFIK_DIR="$BASE_DIR/traefik"
    mkdir -p "$TRAEFIK_DIR"
    chown "$USERNAME":"$USERNAME" "$TRAEFIK_DIR"

# Create Traefik Docker Compose file
cat <<EOF > "$TRAEFIK_DIR/docker-compose.traefik.yml"
version: '3.8'

services:
  traefik:
    image: traefik:v2.9
    container_name: traefik
    command:
      - "--api.insecure=true" # Enable Traefik dashboard (secure in production)
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      # Use HTTP challenge instead of TLS challenge
      - "--certificatesresolvers.myresolver.acme.httpchallenge=true"
      - "--certificatesresolvers.myresolver.acme.httpchallenge.entrypoint=web"
      # Remove or comment out the TLS challenge line
      # - "--certificatesresolvers.myresolver.acme.tlschallenge=true"
      - "--certificatesresolvers.myresolver.acme.email=$EMAIL"
      - "--certificatesresolvers.myresolver.acme.storage=/letsencrypt/acme.json"
    ports:
      - "80:80"      # HTTP
      - "443:443"    # HTTPS
      - "8080:8080"  # Traefik Dashboard
    volumes:
      - "/var/run/docker.sock:/var/run/docker.sock:ro"
      - "./letsencrypt:/letsencrypt"
    networks:
      - traefik-network
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.traefik.rule=Host(\`traefik.${SERVER_ID}.yourdomain.com\`)"
      - "traefik.http.routers.traefik.entrypoints=websecure"
      - "traefik.http.routers.traefik.tls.certresolver=myresolver"
      - "traefik.http.routers.traefik.service=api@internal"

networks:
  traefik-network:
    external: true
EOF

    chown "$USERNAME":"$USERNAME" "$TRAEFIK_DIR/docker-compose.traefik.yml"

    # Create the Docker network if it doesn't exist
    if ! docker network ls | grep -q "traefik-network"; then
        docker network create traefik-network
        log "Created traefik-network."
    else
        log "traefik-network already exists."
    fi

    # Start Traefik using Docker Compose
    cd "$TRAEFIK_DIR"
    sudo -u "$USERNAME" docker-compose -f docker-compose.traefik.yml up -d

    log "Traefik set up and running."
}

# Function to set up systemd service
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

# Function to verify installation
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
        log_error "Traefik failed to start. Check the Docker logs for details."
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

    echo -e "Traefik is running and will route traffic to your deployed applications automatically."
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
    EMAIL="$3"
    BACKEND_BASE_URL="${4:-https://your-default-backend-url}"
    GITHUB_SSH_KEY="${5:-}"

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
    configure_env
    stop_conflicting_containers
    setup_traefik
    setup_service
    verify_installation
    completion_message
}

main "$@"