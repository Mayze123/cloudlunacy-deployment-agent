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

# Function to uninstall Docker and Docker Compose (optional)
uninstall_docker() {
    echo "Uninstalling Docker and Docker Compose..."
    sudo apt-get remove -y docker.io docker-compose
    sudo apt-get autoremove -y
    echo "Docker and Docker Compose uninstalled."
}

# Function to confirm uninstallation
confirm_uninstallation() {
    read -p "Do you want to uninstall Docker and Docker Compose as well? (y/N): " choice
    case "$choice" in
        y|Y ) uninstall_docker;;
        * ) echo "Skipping Docker uninstallation.";;
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
