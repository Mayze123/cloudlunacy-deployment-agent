/**
 * Connect MongoDB container to required Docker networks
 * This script ensures the MongoDB container is connected to both
 * the traefik-network and cloudlunacy-network for proper communication
 */

const { execSync } = require("child_process");
const logger = require("../utils/logger");
const fs = require("fs");
const path = require("path");

// Container name for MongoDB
const MONGODB_CONTAINER = "mongodb-agent";

// Networks to connect
const NETWORKS = ["traefik-network", "cloudlunacy-network"];

/**
 * Check if a container is connected to a network
 * @param {string} container - Container name
 * @param {string} network - Network name
 * @returns {boolean} - True if connected, false otherwise
 */
function isContainerConnectedToNetwork(container, network) {
  try {
    // Use docker network inspect to check if container is connected
    const result = execSync(
      `docker network inspect ${network} -f '{{range .Containers}}{{.Name}} {{end}}'`,
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    return result.includes(container);
  } catch (error) {
    // Network might not exist
    return false;
  }
}

/**
 * Connect container to network if not already connected
 * @param {string} container - Container name
 * @param {string} network - Network name
 */
function connectToNetwork(container, network) {
  try {
    // Check if network exists
    execSync(`docker network inspect ${network}`, { stdio: "ignore" });

    // Check if container is already connected to network
    if (!isContainerConnectedToNetwork(container, network)) {
      console.log(`Connecting ${container} to ${network}...`);
      execSync(`docker network connect ${network} ${container}`);
      console.log(`Successfully connected ${container} to ${network}`);
    } else {
      console.log(`${container} is already connected to ${network}`);
    }
  } catch (error) {
    console.error(
      `Error: Network ${network} does not exist. Please create it first.`,
    );
  }
}

/**
 * Verify MongoDB is running with TLS enabled
 * @returns {boolean} - True if MongoDB is running with TLS, false otherwise
 */
function verifyMongoDBTLS() {
  try {
    // Check if MongoDB container is running
    const containerInfo = execSync(`docker inspect ${MONGODB_CONTAINER}`, {
      encoding: "utf8",
    });

    // Parse container info to JSON
    const containerData = JSON.parse(containerInfo);

    // Check if container is running
    if (!containerData[0].State.Running) {
      console.error(
        `Error: MongoDB container '${MONGODB_CONTAINER}' is not running.`,
      );
      return false;
    }

    // Check if container is using TLS by examining command line args
    const cmdLine = containerData[0].Config.Cmd || [];
    const hasTLS = cmdLine.some(
      (arg) =>
        arg.includes("tls") || arg.includes("ssl") || arg.includes("--config"),
    );

    if (!hasTLS) {
      console.warn(
        "Warning: MongoDB container may not be running with TLS enabled.",
      );
      console.warn("Please check your MongoDB configuration.");
    }

    return true;
  } catch (error) {
    console.error(`Error verifying MongoDB TLS: ${error.message}`);
    return false;
  }
}

/**
 * Create networks if they don't exist
 */
function createNetworksIfNeeded() {
  for (const network of NETWORKS) {
    try {
      // Check if network exists
      execSync(`docker network inspect ${network}`, { stdio: "ignore" });
      console.log(`Network ${network} already exists.`);
    } catch (error) {
      // Network doesn't exist, create it
      console.log(`Creating network ${network}...`);
      execSync(`docker network create ${network}`);
      console.log(`Successfully created network ${network}`);
    }
  }
}

/**
 * Main function to connect MongoDB to all required networks
 */
function connectMongoDBToNetworks() {
  console.log("Connecting MongoDB container to required networks...");

  // Create networks if they don't exist
  createNetworksIfNeeded();

  // Check if MongoDB container is running with TLS
  if (!verifyMongoDBTLS()) {
    console.error("MongoDB container is not properly configured.");
    process.exit(1);
  }

  // Connect to each network
  for (const network of NETWORKS) {
    connectToNetwork(MONGODB_CONTAINER, network);
  }

  console.log("Network connections for MongoDB container completed.");
}

// Run the function if this script is executed directly
if (require.main === module) {
  connectMongoDBToNetworks();
}

// Export for use in other modules
module.exports = { connectMongoDBToNetworks };
