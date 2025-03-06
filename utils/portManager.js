// utils/portManager.js - Simplified with fixed port allocation

const fs = require("fs").promises;
const path = require("path");
const logger = require("./logger");

class PortManager {
  constructor() {
    this.portsFile = "/opt/cloudlunacy/config/ports.json";
    this.portRangeStart = 10000;
    this.portRangeEnd = 20000;
    this.reservedPorts = new Set([80, 443, 3005, 8080, 27017]); // Reserve system ports
    this.standardContainerPort = 8080; // Fixed internal container port
    this.portMap = {};
  }

  async initialize() {
    try {
      await fs.mkdir(path.dirname(this.portsFile), { recursive: true });
      try {
        const data = await fs.readFile(this.portsFile, "utf8");
        this.portMap = JSON.parse(data);
        logger.info(
          `Loaded port mappings for ${Object.keys(this.portMap).length} services`,
        );
      } catch (error) {
        this.portMap = {};
        await this.savePorts();
      }
    } catch (error) {
      logger.error("Failed to initialize port manager:", error);
      throw error;
    }
  }

  async savePorts() {
    try {
      await fs.writeFile(this.portsFile, JSON.stringify(this.portMap, null, 2));
      logger.info("Port mappings saved to disk");
    } catch (error) {
      logger.error("Failed to save ports configuration:", error);
      throw error;
    }
  }

  async verifyPortMapping(serviceName, hostPort) {
    // This method ensures that a service always gets the expected port
    // It updates our records if needed and ensures the front server is in sync

    if (this.portMap[serviceName] && this.portMap[serviceName] !== hostPort) {
      logger.info(
        `Port mapping mismatch for ${serviceName}: recorded ${this.portMap[serviceName]}, actual ${hostPort}`,
      );
      this.portMap[serviceName] = hostPort;
      await this.savePorts();

      // Here we could add a call to ensure the front server is updated if needed
      return true;
    }

    return false;
  }

  async findFreePort(startPort = 10000, endPort = 30000, excludedPort = null) {
    logger.info(
      `Finding free port between ${startPort} and ${endPort}, excluding ${excludedPort}`,
    );

    // Get a list of all used ports by Docker containers
    const { stdout: usedPortsOutput } = await executeCommand("docker", [
      "ps",
      "--format",
      "{{.Ports}}",
    ]);

    // Parse the port output and create a set of used ports
    const usedPorts = new Set();
    usedPortsOutput
      .split("\n")
      .filter(Boolean)
      .forEach((portMapping) => {
        const portMatches = portMapping.match(/0\.0\.0\.0:(\d+)/g);
        if (portMatches) {
          portMatches.forEach((match) => {
            const port = parseInt(match.split(":")[1], 10);
            usedPorts.add(port);
          });
        }
      });

    // Add our reserved ports and the excluded port
    this.reservedPorts.forEach((port) => usedPorts.add(port));
    if (excludedPort) usedPorts.add(excludedPort);

    // Find the first available port in our range
    for (let port = startPort; port <= endPort; port++) {
      if (!usedPorts.has(port)) {
        // Verify the port is truly available at the OS level
        try {
          const { stdout: lsofOutput } = await executeCommand("lsof", [
            "-i",
            `:${port}`,
          ]);

          if (!lsofOutput.trim()) {
            logger.info(`Found free port: ${port}`);
            return port;
          }
        } catch (error) {
          // lsof throwing an error usually means no process is using this port
          logger.info(`Found free port: ${port}`);
          return port;
        }
      }
    }

    throw new Error(
      `No free ports available between ${startPort} and ${endPort}`,
    );
  }

  async allocatePort(serviceName) {
    logger.info(`Allocating port for ${serviceName}`);

    // Check existing allocation - reuse the previous port assignment for consistency
    if (this.portMap[serviceName]) {
      const fixedPort = this.portMap[serviceName];
      logger.info(`Using fixed port ${fixedPort} for ${serviceName}`);

      return {
        hostPort: fixedPort,
        containerPort: this.standardContainerPort,
      };
    }

    // For new services, assign a port based on a deterministic hash of the service name
    // This ensures the same service always gets the same port, even across deployments
    const portHash = this.generateDeterministicPort(serviceName);
    this.portMap[serviceName] = portHash;
    await this.savePorts();

    logger.info(`Allocated fixed port ${portHash} for ${serviceName}`);
    return {
      hostPort: portHash,
      containerPort: this.standardContainerPort,
    };
  }

  generateDeterministicPort(serviceName) {
    // Create a deterministic port number based on the service name
    // Simple hash function - sum the char codes and use modulo to get a port in range
    let hash = 0;
    for (let i = 0; i < serviceName.length; i++) {
      hash = (hash << 5) - hash + serviceName.charCodeAt(i);
      hash |= 0; // Convert to 32bit integer
    }

    // Use absolute value, then get a port number in the range
    hash = Math.abs(hash);
    const portOffset = hash % (this.portRangeEnd - this.portRangeStart);
    let port = this.portRangeStart + portOffset;

    // Skip reserved ports
    while (this.reservedPorts.has(port)) {
      port++;
    }

    return port;
  }

  async releasePort(serviceName) {
    logger.info(`Releasing port for ${serviceName}`);

    if (this.portMap[serviceName]) {
      const port = this.portMap[serviceName];
      delete this.portMap[serviceName];
      await this.savePorts();
      logger.info(`Released port ${port} for ${serviceName}`);
    }
  }
}

module.exports = new PortManager();
