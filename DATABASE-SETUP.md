# Database Setup Guide

This guide explains how to set up the necessary directories and permissions for MongoDB and Redis installations.

## Permission Issues

If you encounter permission errors like this when installing databases:

```
Failed to install MongoDB: Command failed: mkdir -p /opt/cloudlunacy/mongodb/data/db
mkdir: cannot create directory '/opt/cloudlunacy/mongodb/data': Permission denied
```

You need to create the required directories with proper permissions.

## Option 1: Using the Setup Script (Recommended)

We've created a setup script that will automatically create all required directories with proper permissions:

```bash
# Run the setup script with sudo permissions
npm run setup:db-dirs

# Or run it directly
sudo node setup-database-dirs.js
```

This script will:

1. Create all necessary directories for MongoDB and Redis
2. Set the correct ownership to your user
3. Set appropriate permissions (755)

## Option 2: Manual Setup

If you prefer to set up the directories manually, you can run the following commands:

```bash
# Create MongoDB directories
sudo mkdir -p /opt/cloudlunacy/mongodb/data/db

# Create Redis directory
sudo mkdir -p /opt/cloudlunacy/redis/data

# Create certificates directory
sudo mkdir -p /opt/cloudlunacy/certs

# Set ownership to your user (replace YOUR_USERNAME with your actual username)
sudo chown -R YOUR_USERNAME:YOUR_USERNAME /opt/cloudlunacy

# Set permissions
sudo chmod -R 755 /opt/cloudlunacy
```

## Verifying Setup

After running the setup script or manual commands, you can verify that the directories were created properly:

```bash
ls -la /opt/cloudlunacy
```

You should see directories for `mongodb`, `redis`, and `certs`, all owned by your user.

## Installing Databases

Once the directories are set up with proper permissions, you can install MongoDB and Redis:

```bash
# Install MongoDB
npm run db:install mongodb

# Install Redis
npm run db:install redis

# Check database status
npm run db:status mongodb
npm run db:status redis
```

## Troubleshooting

If you continue to experience permission issues:

1. Ensure you ran the setup script with sudo
2. Verify the directory ownership: `ls -la /opt/cloudlunacy`
3. Try running the manual commands again
4. Check if any parent directories have restrictive permissions

For additional help, please refer to the main documentation or contact support.
