# Download the install script and its checksum

curl -LO https://github.com/Mayze123/cloudlunacy-deployment-agent/releases/latest/download/install-agent.sh
curl -LO https://github.com/Mayze123/cloudlunacy-deployment-agent/releases/latest/download/install-agent.sh.sha256

# Verify the checksum

sha256sum -c install-agent.sh.sha256

# Run the installation script

sudo bash install-agent.sh <AGENT_TOKEN> <SERVER_ID> [BACKEND_URL]

# The agent is installed without any database.

# To install databases, use the database management commands after installation.

## Development Environment

### Running the Agent

1. Start the development environment without any database:

   ```
   npm run dev:no-mongo
   ```

2. Or with MongoDB enabled in docker-compose (for local development only):

   ```
   npm run dev
   ```

3. The agent will be available at:
   - Agent API: http://localhost:3006
   - Health API: http://localhost:9000

### Database Management

Databases are **never** installed automatically. The agent supports a completely on-demand approach to database installation where users explicitly choose which databases to install. Databases are managed by their specific configuration variables rather than an enabled/disabled flag.

#### Development Commands

- Start without any databases (recommended): `npm run dev:no-mongo`
- Build and start without any databases: `npm run dev:build-no-mongo`
- Start with MongoDB in docker-compose (dev only): `npm run dev`
- Build and start with MongoDB in docker-compose (dev only): `npm run dev:build`

#### Installing and Managing Databases

Use the following commands to install and manage databases on demand:

```bash
# Install a database
npm run db:install -- mongodb
npm run db:install -- redis --port=6380 --password=mypassword

# Check database status
npm run db:status -- mongodb
npm run db:status -- redis

# Uninstall a database
npm run db:uninstall -- mongodb
npm run db:uninstall -- redis
```

When a database is installed, its configuration variables will be automatically added to your .env file.

#### Available Options

- `--port=<port>` - Specify the port for the database
- `--username=<user>` - Specify the username for the database
- `--password=<pass>` - Specify the password for the database
- `--tls=<true|false>` - Enable or disable TLS
- `--auth=<true|false>` - Enable or disable authentication

#### Supported Databases

- `mongodb` - MongoDB document database
- `redis` - Redis key-value store

## Testing

### Running Tests

To run the automated tests against the development environment:

```bash
npm test
```

To test MongoDB connections specifically (requires MongoDB to be installed):

```bash
npm run test:mongo
```
