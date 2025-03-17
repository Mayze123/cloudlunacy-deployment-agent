# Download the install script and its checksum

curl -LO https://github.com/Mayze123/cloudlunacy-deployment-agent/releases/latest/download/install-agent.sh
curl -LO https://github.com/Mayze123/cloudlunacy-deployment-agent/releases/latest/download/install-agent.sh.sha256

# Verify the checksum

sha256sum -c install-agent.sh.sha256

# If the verification succeeds, proceed to run the script

sudo bash install-agent.sh <AGENT_TOKEN> <SERVER_ID> [BACKEND_URL]

## Testing

### Development Environment

1. Start the development environment:

   ```
   npm run dev
   ```

2. The agent will be available at:
   - Agent API: http://localhost:3006
   - Health API: http://localhost:9000

### Running Tests

To run the automated tests against the development environment:
