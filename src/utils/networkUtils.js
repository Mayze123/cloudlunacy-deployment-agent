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
    // First, try external service to get the public IP
    try {
      logger.debug(
        "Attempting to get public IP from external service ipify.org",
      );
      const response = await axios.get("https://api.ipify.org?format=json", {
        timeout: 5000,
      }); // Add timeout
      if (response.data && response.data.ip) {
        logger.debug(`Found public IP via ipify.org: ${response.data.ip}`);
        return response.data.ip;
      }
    } catch (extErr) {
      logger.warn(
        `Failed to get public IP from ipify.org: ${extErr.message}. Falling back to local methods.`,
      );
    }

    // If external service fails, try local command hostname -I
    try {
      const { stdout } = await execAsync("hostname -I");
      const localIp = stdout.toString().trim().split(" ")[0];
      if (localIp) {
        logger.debug(`Found local IP using hostname command: ${localIp}`);
        return localIp;
      }
    } catch (hostErr) {
      logger.warn(
        `Failed to get local IP with hostname -I: ${hostErr.message}`,
      );
    }

    // If hostname -I fails, try network interfaces from os module
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
    } catch (netErr) {
      logger.warn(
        `Failed to get local IP from network interfaces: ${netErr.message}`,
      );
    }

    // If all methods fail, fallback to localhost
    logger.warn(
      "All methods to determine IP failed. Falling back to 127.0.0.1",
    );
    return "127.0.0.1";
  } catch (error) {
    // Catch any unexpected errors in the outer try block
    logger.error(`Unexpected error in getPublicIp: ${error.message}`);
    return "127.0.0.1"; // Fallback in case of unexpected errors
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
