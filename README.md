# Download the install script and its checksum
curl -LO https://github.com/Mayze123/cloudlunacy-deployment-agent/releases/latest/download/install-agent.sh
curl -LO https://github.com/Mayze123/cloudlunacy-deployment-agent/releases/latest/download/install-agent.sh.sha256

# Verify the checksum
sha256sum -c install-agent.sh.sha256

# If the verification succeeds, proceed to run the script
sudo bash install-agent.sh <AGENT_TOKEN> <SERVER_ID> [BACKEND_URL]