#!/bin/bash
# ------------------------------------------------------------------------------
# Installation Script for CloudLunacy Deployment Agent
# Version: 1.1.0
# Author: Mahamadou Taibou
# Date: 2024-10-22
#
# Description:
# This script installs and configures the CloudLunacy Deployment Agent on a VPS.
# It performs the following tasks:
#   - Detects the operating system and version
#   - Updates system packages
#   - Installs necessary dependencies (Docker, Node.js, Git, jq)
#   - Creates a dedicated user and directory for the agent
#   - Downloads the latest version of the Deployment Agent from GitHub
#   - Installs Node.js dependencies
#   - Configures environment variables
#   - Sets up the Deployment Agent as a systemd service
#   - Provides post-installation verification and feedback
#
# Usage:
#   sudo ./install-agent.sh <AGENT_TOKEN> <SERVER_ID> [BACKEND_URL]
#
# Arguments:
#   AGENT_TOKEN - Unique token for agent authentication
#   SERVER_ID   - Unique identifier for the server
#   BACKEND_URL - (Optional) Backend URL; defaults to https://your-default-backend-url/api/agent
# ------------------------------------------------------------------------------

set -euo pipefail
set -x  # Enable debugging mode
IFS=$'\n\t'

# ----------------------------
# Function Definitions
# ----------------------------

# Function to display script information
display_info() {
    echo "-------------------------------------------------"
    echo "CloudLunacy Deployment Agent Installation Script"
    echo "Version: 1.1.0"
    echo "Author: Mahamadou Taibou"
    echo "Date: 2024-10-22"
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
    if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
        log_error "Invalid number of arguments."
        echo "Usage: $0 <AGENT_TOKEN> <SERVER_ID> [BACKEND_URL]"
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
            pacman -Sy --noconfirm
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
                dnf install -y curl wget git jq coreutils
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
        return
    fi

    log "Docker not found. Installing Docker..."
  case "$OS_TYPE" in
        ubuntu | debian | raspbian)
            apt-get install -y \
                ca-certificates \
                curl \
                gnupg \
                lsb-release

            mkdir -p /etc/apt/keyrings
            curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
                gpg --dearmor -o /etc/apt/keyrings/docker.gpg

            echo \
                "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
                $(lsb_release -cs) stable" | \
                tee /etc/apt/sources.list.d/docker.list > /dev/null

            apt-get update -y
            apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
            ;;
        arch)
            pacman -S --noconfirm docker
            ;;
        alpine)
            apk add --no-cache docker
            rc-update add docker default
            service docker start
            ;;
        centos | fedora | rhel | ol | rocky | almalinux | amzn)
            if [ "$OS_TYPE" = "amzn" ]; then
                dnf config-manager --add-repo=https://download.docker.com/linux/centos/docker-ce.repo
                dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
            else
                if command -v dnf >/dev/null 2>&1; then
                    dnf config-manager --add-repo=https://download.docker.com/linux/centos/docker-ce.repo
                    dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
                else
                    yum install -y yum-utils
                    yum-config-manager \
                        --add-repo \
                        https://download.docker.com/linux/centos/docker-ce.repo
                    yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
                fi
            fi
            ;;
        sles | opensuse-leap | opensuse-tumbleweed)
            zypper install -y docker
            systemctl enable docker
            systemctl start docker
            ;;
        *)
            log_error "Unsupported OS for Docker installation: $OS_TYPE $OS_VERSION"
            exit 1
            ;;
    esac

    log "Docker installed successfully."
}

# Function to install Node.js
install_node() {
    log "Checking Node.js installation..."
    if command -v node >/dev/null 2>&1; then
        log "Node.js is already installed."
        return
    fi

    log "Node.js not found. Installing Node.js..."
    case "$OS_TYPE" in
        ubuntu | debian | raspbian)
            curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
            apt-get install -y nodejs
            ;;
        centos | rhel | ol | rocky | almalinux)
            curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
            yum install -y nodejs
            ;;
        fedora)
            dnf module install -y nodejs:18
            ;;
        amzn)
            curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
            yum install -y nodejs
            ;;
        arch)
            pacman -S --noconfirm nodejs npm
            ;;
        alpine)
            apk add --no-cache nodejs npm
            ;;
        sles | opensuse-leap | opensuse-tumbleweed)
            zypper install -y nodejs18
            ;;
        *)
            log_error "Unsupported OS for Node.js installation: $OS_TYPE $OS_VERSION"
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
    else
        useradd -r -s /bin/false "$USERNAME"
        log "User '$USERNAME' created."
    fi

    mkdir -p "$BASE_DIR"/{logs,ssh,config,bin}
    chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"
    chmod -R 750 "$BASE_DIR"
    log "Directories created at $BASE_DIR."
}

# Function to download and verify the latest agent
download_agent() {
       log "Downloading the latest CloudLunacy Deployment Agent..."
    LATEST_RELEASE=$(curl -s https://api.github.com/repos/Mayze123/cloudlunacy-deployment-agent/releases/latest | grep tag_name | cut -d '"' -f 4)
    
    if [ -z "$LATEST_RELEASE" ]; then
        log_error "Failed to retrieve the latest release information from GitHub."
        exit 1
    fi

    DOWNLOAD_URL="https://github.com/Mayze123/cloudlunacy-deployment-agent/archive/refs/tags/${LATEST_RELEASE}.tar.gz"
    TEMP_DIR=$(mktemp -d)

    # Download the agent tarball
    if ! wget "$DOWNLOAD_URL" -O "$TEMP_DIR/agent.tar.gz"; then
        log_error "Failed to download the agent tarball from $DOWNLOAD_URL."
        exit 1
    fi

    log "Extracting the agent..."
    tar -xzf "$TEMP_DIR/agent.tar.gz" -C "$BASE_DIR" --strip-components=1
    rm -rf "$TEMP_DIR"
    chown -R "$USERNAME":"$USERNAME" "$BASE_DIR"
    log "Agent downloaded and extracted to $BASE_DIR."
}

# Function to install agent dependencies
install_agent_dependencies() {
    log "Installing agent dependencies..."
    cd "$BASE_DIR"
    # Check if package.json exists
    if [ -f "package.json" ]; then
        sudo -u "$USERNAME" npm install
    else
        # Initialize package.json and install dependencies
        sudo -u "$USERNAME" npm init -y
        sudo -u "$USERNAME" npm install axios
        # Add other dependencies as needed
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

# Function to set up systemd service
setup_service() {
    log "Setting up CloudLunacy Deployment Agent as a systemd service..."
    SERVICE_FILE="/etc/systemd/system/cloudlunacy.service"

    cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=CloudLunacy Deployment Agent
After=network.target

[Service]
ExecStart=/usr/bin/node $BASE_DIR/agent.js
WorkingDirectory=$BASE_DIR
Restart=always
RestartSec=5
User=$USERNAME
EnvironmentFile=$ENV_FILE

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
}

# Function to display completion message
completion_message() {
    echo -e "\033[0;35m
   ____                            _         _       _   _                 _
  / ___|___  _ __   __ _ _ __ __ _| |_ _   _| | __ _| |_(_) ___  _ __  ___| |
 | |   / _ \| '_ \ / _\` | '__/ _\` | __| | | | |/ _\` | __| |/ _ \| '_ \/ __| |
 | |__| (_) | | | | (_| | | | (_| | |_| |_| | | (_| | |_| | (_) | | | \__ \_|
  \____\___/|_| |_|\__, |_|  \__,_|\__|\__,_|_|\__,_|\__|_|\___/|_| |_|___(_)
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
    BACKEND_URL="${3:-https://your-default-backend-url/api/agent}"

    detect_os
    log "Detected OS: $OS_TYPE $OS_VERSION"

    update_system
    install_dependencies
    install_docker
    install_node
    setup_user_directories
    download_agent
    install_agent_dependencies  # Added function call
    configure_env
    setup_service
    verify_installation
    completion_message
}

main "$@"