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
            apt-get install -y curl wget git jq coreutils
            ;;
        arch)
            pacman -S --noconfirm curl wget git jq coreutils
            ;;
        alpine)
            apk add --no-cache curl wget git jq coreutils
            ;;
        centos | fedora | rhel | ol | rocky | almalinux | amzn)
            if [ "$OS_TYPE" = "amzn" ]; then
                yum install -y curl wget git jq coreutils
            else
                if ! command -v dnf >/dev/null 2>&1; then
                    yum install -y dnf
                fi
                dnf install -y curl wget git jq coreutils
            fi
            ;;
        sles | opensuse-leap | opensuse-tumbleweed)
            zypper install -y curl wget git jq coreutils
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

install_nginx() {
    log "Checking Nginx installation..."
    if command -v nginx >/dev/null 2>&1; then
        log "Nginx is already installed."
    else
        log "Nginx not found. Installing Nginx..."

        case "$OS_TYPE" in
            ubuntu | debian | raspbian)
                apt-get install -y nginx
                ;;
            centos | rhel | fedora | rocky | almalinux)
                if command -v dnf >/dev/null 2>&1; then
                    dnf install -y nginx
                else
                    yum install -y nginx
                fi
                ;;
            *)
                log_error "Nginx installation not supported on this OS."
                exit 1
                ;;
        esac

        systemctl enable nginx
        systemctl start nginx
        log "Nginx installed successfully."
    fi

    # Set up Nginx directories and permissions
    log "Setting up Nginx configuration directories..."
    
    # Ensure directories exist
    mkdir -p /etc/nginx/sites-available
    mkdir -p /etc/nginx/sites-enabled
    
    # Ubuntu-specific setup
    log "Configuring Nginx permissions for Ubuntu..."
    if [ "$OS_TYPE" = "ubuntu" ] || [ "$OS_TYPE" = "debian" ] || [ "$OS_TYPE" = "raspbian" ]; then
        # Add cloudlunacy user to www-data group
        usermod -aG www-data "$USERNAME"
        
        # Set ownership
        chown -R root:root /etc/nginx
        chown -R "$USERNAME:www-data" /etc/nginx/sites-available
        chown -R "$USERNAME:www-data" /etc/nginx/sites-enabled
        
        # Set directory permissions
        chmod 755 /etc/nginx
        chmod 775 /etc/nginx/sites-available
        chmod 775 /etc/nginx/sites-enabled
    else
        # For other distributions that use the nginx user/group
        groupadd -f nginx
        usermod -aG nginx "$USERNAME"
        chown -R root:root /etc/nginx
        chown -R "$USERNAME:nginx" /etc/nginx/sites-available
        chown -R "$USERNAME:nginx" /etc/nginx/sites-enabled
        chmod 755 /etc/nginx
        chmod 775 /etc/nginx/sites-available
        chmod 775 /etc/nginx/sites-enabled
    fi

    # Update nginx configuration
    NGINX_CONF="/etc/nginx/nginx.conf"
    
    # Add includes if they don't exist
    if ! grep -q "include /etc/nginx/sites-enabled/\*" "$NGINX_CONF"; then
        sed -i '/http {/a \    include /etc/nginx/sites-enabled/*;' "$NGINX_CONF"
        log "Added sites-enabled include to nginx.conf"
    fi
    
    if ! grep -q "server_names_hash_bucket_size" "$NGINX_CONF"; then
        sed -i '/http {/a \    server_names_hash_bucket_size 128;' "$NGINX_CONF"
        log "Added server_names_hash_bucket_size directive"
    fi
    
    # Create sudoers entry
    SUDOERS_FILE="/etc/sudoers.d/cloudlunacy-nginx"
    cat > "$SUDOERS_FILE" << EOF
# Allow cloudlunacy user to manage nginx
$USERNAME ALL=(ALL) NOPASSWD: /usr/sbin/nginx
$USERNAME ALL=(ALL) NOPASSWD: /bin/systemctl reload nginx
$USERNAME ALL=(ALL) NOPASSWD: /bin/systemctl restart nginx
$USERNAME ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/nginx/sites-available/*
$USERNAME ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/nginx/sites-enabled/*
$USERNAME ALL=(ALL) NOPASSWD: /bin/ln -sf /etc/nginx/sites-available/* /etc/nginx/sites-enabled/*
$USERNAME ALL=(ALL) NOPASSWD: /bin/rm -f /etc/nginx/sites-available/*
$USERNAME ALL=(ALL) NOPASSWD: /bin/rm -f /etc/nginx/sites-enabled/*
EOF

    # Set proper permissions on sudoers file
    chmod 440 "$SUDOERS_FILE"
    
    # Test and reload nginx
    if ! nginx -t; then
        log_error "Nginx configuration test failed"
        exit 1
    fi
    
    systemctl reload nginx
    
    log "Nginx setup completed successfully"
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

    # Create nginx configuration directories
    mkdir -p "$BASE_DIR/nginx/sites-available"
    mkdir -p "$BASE_DIR/nginx/sites-enabled"
    chown -R "$USERNAME":"$USERNAME" "$BASE_DIR/nginx"
    chmod -R 750 "$BASE_DIR/nginx"

    # Create subdirectories
    mkdir -p "$BASE_DIR"/{logs,ssh,config,bin}
    chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"/{logs,ssh,config,bin}

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
    chown "$USERNAME":"$USERNAME" "$BASE_DIR"

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
        sudo -u "$USERNAME" HOME="$BASE_DIR" npm install axios dotenv winston shelljs ws handlebars js-yaml --cache "$NPM_CACHE_DIR" --no-fund --no-audit
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

setup_nginx_templates() {
    log "Setting up Nginx configuration templates..."
    
    TEMPLATES_DIR="$BASE_DIR/templates/nginx"
    mkdir -p "$TEMPLATES_DIR"
    
    # Create a basic Nginx virtual host template
    cat <<EOF > "$TEMPLATES_DIR/virtual-host.template"
server {
    listen 80;
    server_name {{domain}};

    location / {
        proxy_pass http://127.0.0.1:{{port}};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:{{port}};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

    # Set proper ownership and permissions
    chown -R "$USERNAME":"$USERNAME" "$TEMPLATES_DIR"
    chmod 750 "$TEMPLATES_DIR"
    chmod 640 "$TEMPLATES_DIR/virtual-host.template"
    
    log "Nginx templates created successfully."
}

setup_nginx_permissions() {
    log "Configuring Nginx sudo permissions..."
    
    # Create sudoers.d file for cloudlunacy nginx permissions
    cat <<EOF > /etc/sudoers.d/cloudlunacy-nginx
# Allow cloudlunacy user to manage nginx
cloudlunacy ALL=(ALL) NOPASSWD: /usr/sbin/nginx
cloudlunacy ALL=(ALL) NOPASSWD: /bin/systemctl reload nginx
cloudlunacy ALL=(ALL) NOPASSWD: /bin/systemctl restart nginx
cloudlunacy ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/nginx/sites-available/*
cloudlunacy ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/nginx/sites-enabled/*
cloudlunacy ALL=(ALL) NOPASSWD: /bin/ln -sf /etc/nginx/sites-available/* /etc/nginx/sites-enabled/*
cloudlunacy ALL=(ALL) NOPASSWD: /bin/rm /etc/nginx/sites-available/*
cloudlunacy ALL=(ALL) NOPASSWD: /bin/rm /etc/nginx/sites-enabled/*
EOF

    # Set proper permissions on the sudoers file
    chmod 440 /etc/sudoers.d/cloudlunacy-nginx
    
    log "Nginx sudo permissions configured."
}

setup_docker_permissions() {
    log "Setting up Docker permissions..."
    
    # Add cloudlunacy user to docker group
    usermod -aG docker cloudlunacy
    
    # Create deployment directories with correct permissions
    mkdir -p /opt/cloudlunacy/deployments
    mkdir -p /tmp/cloudlunacy-deployments
    
    # Set permissions
    chown -R cloudlunacy:docker /opt/cloudlunacy
    chown cloudlunacy:docker /opt/cloudlunacy/deployments
    chown cloudlunacy:docker /tmp/cloudlunacy-deployments
    
    chmod 775 /opt/cloudlunacy/deployments
    chmod 775 /tmp/cloudlunacy-deployments
    chmod 666 /var/run/docker.sock
    
    log "Docker permissions configured successfully."
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
User=cloudlunacy
Group=docker
Environment=HOME=$BASE_DIR
EnvironmentFile=$ENV_FILE

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable cloudlunacy
    systemctl start cloudlunacy
    
    # Restart Docker to ensure group changes take effect
    systemctl restart docker
    
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
    install_nginx
    install_node
    setup_user_directories
    setup_docker_permissions
    setup_nginx_permissions
    setup_nginx_templates
    setup_ssh "$GITHUB_SSH_KEY"
    download_agent
    install_agent_dependencies
    configure_env
    setup_service
    verify_installation
    display_ssh_instructions
    completion_message
}

main "$@"