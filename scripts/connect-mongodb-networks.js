/**
 * Connect MongoDB container to required Docker networks
 * This script ensures the MongoDB container is connected to both
 * the traefik-network and cloudlunacy-network for proper communication
 */

const { execSync } = require("child_process");
const logger = require("../utils/logger");

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
 * Main function to connect MongoDB to all required networks
 */
function connectMongoDBToNetworks() {
  console.log("Connecting MongoDB container to required networks...");

  // Check if MongoDB container is running
  try {
    execSync(`docker inspect ${MONGODB_CONTAINER}`, { stdio: "ignore" });
  } catch (error) {
    console.error(
      `Error: MongoDB container '${MONGODB_CONTAINER}' is not running.`,
    );
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
