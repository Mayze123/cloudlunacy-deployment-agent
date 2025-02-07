#!/bin/bash

# ------------------------------------------------------------------------------
# Uninstallation Script for CloudLunacy Deployment Agent
# Version: 1.0.0
# Author: Mahamadou Taibou
# Date: 2024-04-27
#
# Description:
# This script uninstalls the CloudLunacy Deployment Agent from the VPS.
# It performs the following tasks:
#   - Stops and disables the systemd service
#   - Removes the systemd service file
#   - Deletes the dedicated directory
#   - Optionally removes Docker and Docker Compose
#   - Removes the dedicated user
#
# Usage:
#   ./uninstall-agent.sh
# ------------------------------------------------------------------------------

# Function to stop and disable the service
stop_service() {
  echo "Stopping CloudLunacy service..."
  sudo systemctl stop cloudlunacy
  sudo systemctl disable cloudlunacy
  echo "CloudLunacy service stopped and disabled."
}

# Function to remove the service file
remove_service_file() {
  echo "Removing CloudLunacy service file..."
  sudo rm -f /etc/systemd/system/cloudlunacy.service
  sudo systemctl daemon-reload
  echo "CloudLunacy service file removed."
}

# Function to delete the dedicated directory
delete_agent_directory() {
  echo "Deleting CloudLunacy directory..."
  sudo rm -rf /opt/cloudlunacy
  echo "CloudLunacy directory deleted."
}

# Function to remove the dedicated user (optional)
remove_agent_user() {
  echo "Removing dedicated user 'cloudlunacy'..."
  sudo userdel -r cloudlunacy
  echo "User 'cloudlunacy' removed."
}

# Detect OS and version
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
    pop)
      OS_TYPE="ubuntu"
      ;;
    linuxmint)
      OS_TYPE="ubuntu"
      ;;
    zorin)
      OS_TYPE="ubuntu"
      ;;
    *) ;;

  esac

  echo "$OS_TYPE" "$OS_VERSION"
}

read OS_TYPE OS_VERSION < <(detect_os)

# Function to uninstall Docker and Docker Compose (optional)
uninstall_docker() {
  echo "Uninstalling Docker and Docker Compose..."
  case "$OS_TYPE" in
    ubuntu | debian | raspbian)
      apt-get remove -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      apt-get purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      apt-get autoremove -y --purge
      ;;
    centos | rhel | ol | rocky | almalinux | amzn)
      yum remove -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    fedora)
      dnf remove -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    arch)
      pacman -Rns --noconfirm docker
      ;;
    alpine)
      apk del docker
      ;;
    sles | opensuse-leap | opensuse-tumbleweed)
      zypper remove -y docker
      ;;
    *)
      echo "Unsupported OS for Docker uninstallation: $OS_TYPE"
      ;;
  esac
  echo "Docker and Docker Compose uninstalled."
}

# Function to confirm uninstallation
confirm_uninstallation() {
  read -p "Do you want to uninstall Docker and Docker Compose as well? (y/N): " choice
  case "$choice" in
    y | Y) uninstall_docker ;;
    *) echo "Skipping Docker uninstallation." ;;
  esac
}

# Main Script Execution

echo "-------------------------------------------------"
echo "CloudLunacy Deployment Agent Uninstallation Script"
echo "Version: 1.0.0"
echo "Author: Mahamadou Taibou"
echo "Date: 2024-04-27"
echo "-------------------------------------------------"

# Stop and disable the service
stop_service

# Remove the service file
remove_service_file

# Delete the dedicated directory
delete_agent_directory

# Remove the dedicated user
remove_agent_user

# Confirm and uninstall Docker
confirm_uninstallation

echo "CloudLunacy Deployment Agent uninstalled successfully."
