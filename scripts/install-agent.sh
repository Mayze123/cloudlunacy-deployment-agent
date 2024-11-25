#!/bin/bash
# ------------------------------------------------------------------------------
# Installation Script for CloudLunacy Deployment Agent with Traefik and MongoDB
# Version: 2.5.0
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
#   - Sets up MongoDB with TLS using a publicly trusted certificate
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

# Fixed domain for MongoDB
DOMAIN="mongodb.cloudlunacy.uk"

# ----------------------------
# Function Definitions
# ----------------------------

# Function to display script information
display_info() {
    echo "-------------------------------------------------"
    echo "CloudLunacy Deployment Agent Installation Script"
    echo "Version: 2.5.0"
    echo "Author: Mahamadou Taibou"
    echo "Date: 2024-11-24"
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
        echo "Usage: $0 <AGENT_TOKEN> <SERVER_ID> <EMAIL> [BACKEND_BASE_URL]"
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

# Function to install Certbot
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

# Function to install MongoDB Shell (mongosh) Docker image
install_mongosh() {
    log "Pulling MongoDB Shell Docker image..."
    docker pull mongodb/mongodb-community-server:6.0-ubi8
    log "MongoDB Shell Docker image pulled."
}

# Function to obtain SSL/TLS certificate using Certbot
obtain_ssl_certificate() {
    log "Obtaining SSL/TLS certificate for domain $DOMAIN..."
    
    # Ensure port 80 is available
    if lsof -i :80 | grep LISTEN; then
        log "Port 80 is currently in use. Attempting to stop services using port 80..."
        # Try to stop common services that might be using port 80
        systemctl stop nginx || true
        systemctl stop apache2 || true
        systemctl stop httpd || true
        systemctl stop traefik || true
        # Check again if port 80 is free
        if lsof -i :80 | grep LISTEN; then
            log_error "Port 80 is still in use. Cannot proceed with certificate issuance."
            exit 1
        fi
    fi

    # Obtain the certificate using standalone mode
    certbot certonly --standalone --non-interactive --agree-tos --email "$EMAIL" -d "$DOMAIN"

    # Check if the certificate was successfully obtained
    if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
        log_error "Failed to obtain SSL/TLS certificate for $DOMAIN."
        exit 1
    fi

    log "SSL/TLS certificate obtained for $DOMAIN."
}

# Function to create combined certificate file for MongoDB
create_combined_certificate() {
    log "Creating combined certificate file for MongoDB..."

    # Create MongoDB SSL directory
    SSL_DIR="/etc/ssl/mongo"
    mkdir -p "$SSL_DIR"

    # Source certificate directory
    CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
    
    # Create combined certificate (private key + fullchain)
    cat "$CERT_DIR/privkey.pem" "$CERT_DIR/fullchain.pem" > "$SSL_DIR/combined.pem"
    
    # Copy chain certificate
    cp "$CERT_DIR/chain.pem" "$SSL_DIR/chain.pem"

    # Set proper permissions
    chown -R 999:999 "$SSL_DIR"
    chmod 600 "$SSL_DIR"/*.pem

    log "Certificate files created in $SSL_DIR"
}

# Function to set up MongoDB with TLS using the obtained certificate
setup_mongodb() {
    log "Setting up MongoDB as a Docker container with TLS..."

    MONGODB_DIR="$BASE_DIR/mongodb"
    mkdir -p "$MONGODB_DIR"
    chown "$USERNAME":"$USERNAME" "$MONGODB_DIR"

    # Generate MongoDB root username and password
    MONGO_INITDB_ROOT_USERNAME=$(openssl rand -hex 12)
    MONGO_INITDB_ROOT_PASSWORD=$(openssl rand -hex 24)

    # Generate MongoDB management user credentials
    MONGO_MANAGER_USERNAME="manager"
    MONGO_MANAGER_PASSWORD=$(openssl rand -hex 24)

    # Save MongoDB credentials to environment file
    MONGO_ENV_FILE="$MONGODB_DIR/.env"
    cat <<EOF > "$MONGO_ENV_FILE"
MONGO_INITDB_ROOT_USERNAME=$MONGO_INITDB_ROOT_USERNAME
MONGO_INITDB_ROOT_PASSWORD=$MONGO_INITDB_ROOT_PASSWORD
MONGO_MANAGER_USERNAME=$MONGO_MANAGER_USERNAME
MONGO_MANAGER_PASSWORD=$MONGO_MANAGER_PASSWORD
EOF
    chown "$USERNAME":"$USERNAME" "$MONGO_ENV_FILE"
    chmod 600 "$MONGO_ENV_FILE"

    # Create MongoDB Docker Compose file
    cat <<EOF > "$MONGODB_DIR/docker-compose.mongodb.yml"
version: '3.8'

services:
  mongodb:
    image: mongo:6.0
    container_name: mongodb
    restart: unless-stopped
    volumes:
      - mongo_data:/data/db
      - /etc/ssl/mongo:/etc/ssl/mongo:ro
    environment:
      - MONGO_INITDB_ROOT_USERNAME=\${MONGO_INITDB_ROOT_USERNAME}
      - MONGO_INITDB_ROOT_PASSWORD=\${MONGO_INITDB_ROOT_PASSWORD}
    command:
      - "--auth"
      - "--tlsMode=requireTLS"
      - "--tlsCertificateKeyFile=/etc/ssl/mongo/combined.pem"
      - "--tlsCAFile=/etc/ssl/mongo/chain.pem"
      - "--bind_ip_all"
      - "--logpath=/dev/stdout"
      - "--logappend"
      - "--setParameter"
      - "tlsLogLevel=5"
    ports:
      - "27017:27017"
    networks:
      - internal

volumes:
  mongo_data:

networks:
  internal:
    external: true
EOF

    chown "$USERNAME":"$USERNAME" "$MONGODB_DIR/docker-compose.mongodb.yml"

    # Create the internal Docker network if it doesn't exist
    if ! docker network ls | grep -q "internal"; then
        docker network create internal
        log "Created internal Docker network."
    else
        log "Internal Docker network already exists."
    fi

    # Start MongoDB using Docker Compose
    cd "$MONGODB_DIR"
    sudo -u "$USERNAME" docker-compose -f docker-compose.mongodb.yml up -d

    log "MongoDB set up and running."

    # Wait for MongoDB to initialize
    log "Waiting for MongoDB to initialize..."
    sleep 30

    # Create the management user
    create_mongo_management_user
}

# Function to create MongoDB management user
create_mongo_management_user() {
    log "Creating MongoDB management user..."
    source "$MONGO_ENV_FILE"
    
    TEMP_CERT_DIR="/tmp/mongo-certs"
    mkdir -p "$TEMP_CERT_DIR"
    cp "/etc/ssl/mongo/combined.pem" "$TEMP_CERT_DIR/combined.pem"
    cp "/etc/ssl/mongo/chain.pem" "$TEMP_CERT_DIR/chain.pem"
    chmod 644 "$TEMP_CERT_DIR"/*
    
    MONGO_COMMAND="db.getSiblingDB('admin').createUser({user: '$MONGO_MANAGER_USERNAME', pwd: '$MONGO_MANAGER_PASSWORD', roles: [{role: 'userAdminAnyDatabase', db: 'admin'}, {role: 'readWriteAnyDatabase', db: 'admin'}]});"
    
    # Wait for MongoDB to be ready
    sleep 30
    
    # Set MONGO_IP to the service name
    MONGO_IP="mongodb"
    
    # Test connectivity
    log "Testing connectivity to MongoDB at $MONGO_IP..."
    docker run --rm --network=internal \
        -v "$TEMP_CERT_DIR:/certs:ro" \
        mongo:6.0 \
        mongosh \
        --tls \
        --tlsCertificateKeyFile /certs/combined.pem \
        --tlsCAFile /certs/chain.pem \
        --tlsAllowInvalidHostnames \
        --host $MONGO_IP \
        -u "$MONGO_INITDB_ROOT_USERNAME" \
        -p "$MONGO_INITDB_ROOT_PASSWORD" \
        --authenticationDatabase admin \
        --eval "db.runCommand({ ping: 1 })"
    
    if [ $? -ne 0 ]; then
        log_error "Cannot connect to MongoDB server. Exiting."
        exit 1
    fi
    
    # Create the management user
    docker run --rm --network=internal \
        -v "$TEMP_CERT_DIR:/certs:ro" \
        mongo:6.0 \
        mongosh \
        --tls \
        --tlsCertificateKeyFile /certs/combined.pem \
        --tlsCAFile /certs/chain.pem \
        --tlsAllowInvalidHostnames \
        -u "$MONGO_INITDB_ROOT_USERNAME" \
        -p "$MONGO_INITDB_ROOT_PASSWORD" \
        --authenticationDatabase admin \
        --host $MONGO_IP \
        --eval "$MONGO_COMMAND"
    
    rm -rf "$TEMP_CERT_DIR"
}

# Function to adjust firewall settings
adjust_firewall_settings() {
    log "Adjusting firewall settings to allow external MongoDB connections..."

    # Check if UFW is installed
    if command -v ufw >/dev/null 2>&1; then
        # Allow port 27017
        ufw allow 27017/tcp
        log "Allowed port 27017/tcp through UFW."
    else
        # Use iptables
        iptables -A INPUT -p tcp --dport 27017 -j ACCEPT
        log "Allowed port 27017/tcp through iptables."
    fi

    log "Firewall settings adjusted."
}

# Function to configure environment variables
configure_env() {
    log "Configuring environment variables..."
    ENV_FILE="$BASE_DIR/.env"

    # Read MongoDB credentials from MongoDB env file
    MONGO_ENV_FILE="$BASE_DIR/mongodb/.env"
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

# Function to display MongoDB credentials
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

# Function to automate SSL certificate renewal
setup_certificate_renewal() {
    log "Setting up SSL certificate renewal with Certbot..."

    # Create renewal script
    RENEWAL_SCRIPT="/usr/local/bin/renew_certificates.sh"
    cat <<EOF > "$RENEWAL_SCRIPT"
#!/bin/bash
certbot renew --deploy-hook "docker-compose -f $BASE_DIR/mongodb/docker-compose.mongodb.yml restart mongodb"
EOF
    chmod +x "$RENEWAL_SCRIPT"

    # Add cron job
    (crontab -l 2>/dev/null; echo "0 2 * * * $RENEWAL_SCRIPT >> /var/log/letsencrypt/renewal.log 2>&1") | crontab -

    log "SSL certificate renewal setup complete."
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
        sudo -u "$USERNAME" HOME="$BASE_DIR" npm install axios dotenv winston mongodb joi shelljs ws handlebars js-yaml --cache "$NPM_CACHE_DIR" --no-fund --no-audit
    fi

    log "Agent dependencies installed."
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
      - "--api.insecure=true" # Enable Traefik dashboard (insecure access)
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
    ports:
      - "80:80"      # HTTP
      # Remove port 443 mapping
      # - "443:443"    # HTTPS
      - "8080:8080"  # Traefik Dashboard (if needed)
    volumes:
      - "/var/run/docker.sock:/var/run/docker.sock:ro"
    networks:
      - traefik-network

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

    BACKEND_URL="${BACKEND_BASE_URL}"

    detect_os
    log "Detected OS: $OS_TYPE $OS_VERSION"

    update_system
    install_dependencies
    install_certbot             # Install Certbot
    install_mongosh             # Pull MongoDB Shell Docker image
    install_docker
    install_node
    setup_user_directories
    setup_docker_permissions
    download_agent
    install_agent_dependencies
    stop_conflicting_containers # Stop services on port 80 if necessary
    obtain_ssl_certificate      # Obtain SSL/TLS certificate
    create_combined_certificate # Create combined certificate for MongoDB
    setup_mongodb               # Set up MongoDB with TLS
    adjust_firewall_settings    # Adjust firewall settings
    configure_env               # Configure environment variables
    setup_traefik               # Set up Traefik (if needed)
    setup_service
    setup_certificate_renewal   # Automate SSL certificate renewal
    verify_installation
    completion_message
    display_mongodb_credentials   # Display MongoDB management user credentials after installation
}

main "$@"