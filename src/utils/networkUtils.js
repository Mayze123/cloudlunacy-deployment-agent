/**
 * Network Utilities
 *
 * Helper functions for network-related operations.
 */

const os = require("os");
const { exec } = require("child_process");
const util = require("util");
const axios = require("axios");
const logger = require("../../utils/logger");

const execAsync = util.promisify(exec);

/**
 * Get the public/local IP address of this server.
 * Tries multiple methods to determine the IP address.
 *
 * @returns {Promise<string>} IP address
 */
async function getPublicIp() {
  try {
    // First try to get the server's own IP address using execSync
    try {
      const { stdout } = await execAsync("hostname -I");
      const localIp = stdout.toString().trim().split(" ")[0];
      if (localIp) {
        logger.debug(`Found local IP using hostname command: ${localIp}`);
        return localIp;
      }
    } catch (err) {
      logger.warn(`Failed to get local IP with hostname -I: ${err.message}`);
    }

    // If local command fails, try network interfaces from os module
    try {
      const interfaces = os.networkInterfaces();
      for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
          // Skip internal interfaces and non-IPv4
          if (iface.family === "IPv4" && !iface.internal) {
            logger.debug(
              `Found local IP from network interfaces: ${iface.address}`,
            );
            return iface.address;
          }
        }
      }
    } catch (err) {
      logger.warn(
        `Failed to get local IP from network interfaces: ${err.message}`,
      );
    }

    // If all local methods fail, try external service
    logger.debug("Attempting to get IP from external service ipify.org");
    const response = await axios.get("https://api.ipify.org?format=json");
    return response.data.ip;
  } catch (error) {
    logger.error(`Failed to determine IP address: ${error.message}`);
    // Fallback to localhost as a last resort
    return "127.0.0.1";
  }
}

/**
 * Check if a port is in use on the server
 *
 * @param {number} port - The port to check
 * @returns {Promise<boolean>} True if port is in use, false otherwise
 */
async function isPortInUse(port) {
  try {
    const { stdout, stderr } = await execAsync(
      `netstat -tuln | grep LISTEN | grep :${port}`,
    );
    return !!stdout; // If we get output, the port is in use
  } catch (error) {
    // If the command fails, port is likely not in use
    return false;
  }
}

/**
 * Get a list of all services running on a specific port
 *
 * @param {number} port - The port to check
 * @returns {Promise<Array>} List of services
 */
async function getServicesOnPort(port) {
  try {
    const { stdout } = await execAsync(`lsof -i :${port} -n -P`);
    if (!stdout) return [];

    // Parse the output to extract service information
    const lines = stdout.split("\n").slice(1); // Skip the header line
    const services = lines
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const parts = line.split(/\s+/);
        return {
          process: parts[0],
          pid: parts[1],
          user: parts[2],
          type: parts[4],
          address: parts[8],
        };
      });

    return services;
  } catch (error) {
    logger.warn(`Failed to get services on port ${port}: ${error.message}`);
    return [];
  }
}

module.exports = {
  getPublicIp,
  isPortInUse,
  getServicesOnPort,
};
