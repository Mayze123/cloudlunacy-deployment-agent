#!/bin/bash
# ------------------------------------------------------------------------------
# Network Security Setup for CloudLunacy
# ------------------------------------------------------------------------------

# Ensure the script is run as root
if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root"
  exit 1
fi

# Get the front server IP (should be provided as an argument)
FRONT_SERVER_IP=$1
if [[ -z "$FRONT_SERVER_IP" ]]; then
  echo "Please provide the front server IP as an argument"
  echo "Usage: $0 <FRONT_SERVER_IP>"
  exit 1
fi

# Setup firewall
echo "Setting up firewall rules..."
if command -v ufw &> /dev/null; then
  # Allow SSH
  ufw allow 22/tcp

  # Allow traffic from the front server to MongoDB port
  ufw allow from $FRONT_SERVER_IP to any port 27017

  # Deny all other external traffic to MongoDB
  ufw deny 27017/tcp

  # Enable the firewall if not already enabled
  if ! ufw status | grep -q "Status: active"; then
    ufw --force enable
  fi

  echo "Firewall configured successfully"
else
  echo "UFW not found. Installing..."
  apt-get update && apt-get install -y ufw

  # Configure UFW
  ufw allow 22/tcp
  ufw allow from $FRONT_SERVER_IP to any port 27017
  ufw deny 27017/tcp
  ufw --force enable

  echo "UFW installed and configured"
fi

# Ensure Docker default bridge network is secured
echo "Securing Docker networks..."
# Ensure bridge network doesn't have external access
cat > /etc/docker/daemon.json << EOL
{
  "iptables": true,
  "bridge": "none",
  "userland-proxy": false
}
EOL

# Restart Docker to apply changes
systemctl restart docker

# Verify our shared network exists and is properly configured
SHARED_NETWORK=${SHARED_NETWORK:-cloudlunacy-network}

# Check if network exists
if ! docker network ls | grep -q "$SHARED_NETWORK"; then
  echo "Creating secure Docker network $SHARED_NETWORK..."
  docker network create --internal $SHARED_NETWORK
  echo "Network created successfully"
else
  # Check if it's an internal network
  if ! docker network inspect $SHARED_NETWORK | grep -q '"Internal": true'; then
    echo "Recreating $SHARED_NETWORK as an internal network..."
    docker network rm $SHARED_NETWORK
    docker network create --internal $SHARED_NETWORK
    echo "Network recreated successfully"
  else
    echo "Network $SHARED_NETWORK already exists and is properly configured"
  fi
fi

echo "Network security setup completed successfully"
