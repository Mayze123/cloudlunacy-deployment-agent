#!/usr/bin/env node

/**
 * Database Directory Setup Script
 *
 * This script creates the necessary directories for MongoDB and Redis
 * with proper permissions. It should be run with sudo permissions.
 *
 * Usage: sudo node setup-database-dirs.js [username]
 *
 * If username is not provided, the current user's name will be used.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Base directory for CloudLunacy
const basePath = "/opt/cloudlunacy";

// Directories to create
const directories = [
  // MongoDB directories
  path.join(basePath, "mongodb"),
  path.join(basePath, "mongodb/data"),
  path.join(basePath, "mongodb/data/db"),

  // Redis directories
  path.join(basePath, "redis"),
  path.join(basePath, "redis/data"),

  // Certificates directory
  path.join(basePath, "certs"),
];

// Get username from command line or current user
let username = process.argv[2];
if (!username) {
  try {
    // Try to get current username
    username = execSync("whoami").toString().trim();
    console.log(`No username provided, using current user: ${username}`);
  } catch (error) {
    console.error("Failed to get current username:", error.message);
    console.error(
      "Please provide a username as an argument: sudo node setup-database-dirs.js <username>",
    );
    process.exit(1);
  }
}

// Check if running as root
const isRoot = process.getuid && process.getuid() === 0;
if (!isRoot) {
  console.error("This script must be run with sudo privileges.");
  console.error("Please run: sudo node setup-database-dirs.js [username]");
  process.exit(1);
}

console.log("Creating CloudLunacy directories with proper permissions...");

// Create base directory if it doesn't exist
if (!fs.existsSync(basePath)) {
  try {
    fs.mkdirSync(basePath, { recursive: true });
    console.log(`Created base directory: ${basePath}`);
  } catch (error) {
    console.error(
      `Failed to create base directory ${basePath}:`,
      error.message,
    );
    process.exit(1);
  }
}

// Create all required directories
for (const dir of directories) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    } else {
      console.log(`Directory already exists: ${dir}`);
    }
  } catch (error) {
    console.error(`Failed to create directory ${dir}:`, error.message);
    process.exit(1);
  }
}

// Set ownership
try {
  const command = `chown -R ${username}:${username} ${basePath}`;
  console.log(`Setting ownership: ${command}`);
  execSync(command);
  console.log(`Changed ownership of ${basePath} to ${username}`);
} catch (error) {
  console.error(`Failed to set ownership:`, error.message);
  process.exit(1);
}

// Set permissions
try {
  const command = `chmod -R 755 ${basePath}`;
  console.log(`Setting permissions: ${command}`);
  execSync(command);
  console.log(`Set permissions for ${basePath} to 755`);
} catch (error) {
  console.error(`Failed to set permissions:`, error.message);
  process.exit(1);
}

console.log("\nSetup completed successfully!");
console.log("\nDirectory structure created:");
console.log(`  ${basePath}/`);
console.log(`  ├── mongodb/`);
console.log(`  │   └── data/`);
console.log(`  │       └── db/`);
console.log(`  ├── redis/`);
console.log(`  │   └── data/`);
console.log(`  └── certs/`);
console.log("\nAll directories are now owned by:", username);
console.log(
  "\nYou can now run database installations without permission issues.",
);
