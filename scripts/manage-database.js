/**
 * Database Management Script
 *
 * This script allows management of databases from the command line.
 * It's used to install, uninstall, and check the status of various databases.
 *
 * Usage:
 *   node scripts/manage-database.js <command> [dbType] [options]
 *
 * Commands:
 *   install   - Install a database
 *   uninstall - Uninstall a database
 *   status    - Check the status of a database
 *
 * Database Types:
 *   mongodb   - MongoDB database
 *   redis     - Redis database
 *
 * Options:
 *   --port=<port>        - Specify the port for the database
 *   --username=<user>    - Specify the username for the database
 *   --password=<pass>    - Specify the password for the database
 *   --tls=<true|false>   - Enable or disable TLS
 *   --auth=<true|false>  - Enable or disable authentication
 *
 * Examples:
 *   node scripts/manage-database.js install mongodb
 *   node scripts/manage-database.js install redis --port=6380 --password=mypassword
 *   node scripts/manage-database.js status mongodb
 *   node scripts/manage-database.js uninstall redis
 */

const dotenv = require("dotenv");
const databaseManager = require("../utils/databaseManager");
const logger = require("../utils/logger");

// Load environment variables
dotenv.config();

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];
const dbType = args[1];

// Parse options
const options = {};
for (let i = 2; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith("--")) {
    const [key, value] = arg.slice(2).split("=");
    options[key] = value === "true" ? true : value === "false" ? false : value;
  }
}

// Validate command
if (!command || !["install", "uninstall", "status"].includes(command)) {
  console.error("Error: Invalid or missing command");
  console.error(
    "Usage: node scripts/manage-database.js <command> [dbType] [options]",
  );
  console.error("Commands: install, uninstall, status");
  process.exit(1);
}

// Validate database type
if (!dbType) {
  console.error("Error: Missing database type");
  console.error("Supported databases: mongodb, redis");
  process.exit(1);
}

// Convert options
if (options.port) {
  options.port = parseInt(options.port, 10);
}

// Special case for TLS and auth
if (options.tls !== undefined) {
  options.useTls = options.tls;
  delete options.tls;
}

if (options.auth !== undefined) {
  options.authEnabled = options.auth;
  delete options.auth;
}

// Execute database operation
async function executeDatabaseOperation() {
  try {
    console.log(`Executing ${command} for ${dbType}...`);

    const result = await databaseManager.handleDatabaseOperation(
      command,
      dbType,
      options,
    );

    if (result.success) {
      console.log("\x1b[32m%s\x1b[0m", "Operation Successful:");
      console.log(`- Message: ${result.message}`);

      if (result.details) {
        console.log("- Details:");
        if (typeof result.details === "object") {
          Object.keys(result.details).forEach((key) => {
            if (key !== "error" && result.details[key] !== undefined) {
              console.log(`  ${key}: ${JSON.stringify(result.details[key])}`);
            }
          });
        } else {
          console.log(`  ${result.details}`);
        }
      }
    } else {
      console.error("\x1b[31m%s\x1b[0m", "Operation Failed:");
      console.error(`- Message: ${result.message}`);

      if (result.error) {
        console.error(`- Error: ${result.error}`);
      }
    }
  } catch (error) {
    console.error("\x1b[31m%s\x1b[0m", "An error occurred:");
    console.error(error.message);
    process.exit(1);
  }
}

// Run the operation
executeDatabaseOperation().finally(() => {
  // Exit process when done
  process.exit(0);
});
