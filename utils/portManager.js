// utils/portManager.js

const fs = require("fs").promises;
const path = require("path");
const net = require("net");
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
    } catch (error) {
      logger.error("Failed to save ports configuration:", error);
      throw error;
    }
  }

  async isPortInUse(port) {
    return new Promise((resolve) => {
      const server = net.createServer();

      server.once("error", (err) => {
        server.close();
        if (err.code === "EADDRINUSE") {
          resolve(true);
        } else {
          resolve(false);
        }
      });

      server.once("listening", () => {
        server.close();
        resolve(false);
      });

      server.listen(port);
    });
  }

  async findNextAvailablePort() {
    let port = this.portRangeStart;
    let attempts = 0;
    const maxAttempts = 1000; // Try up to 1000 ports

    while (port <= this.portRangeEnd && attempts < maxAttempts) {
      logger.debug(`Checking port ${port} availability...`);

      // Skip reserved ports
      if (this.reservedPorts.has(port)) {
        port++;
        attempts++;
        continue;
      }

      // Check if port is in use
      const inUse = await this.isPortInUse(port);
      if (!inUse) {
        logger.debug(`Found available port: ${port}`);
        return port;
      }

      port++;
      attempts++;
    }

    throw new Error(
      `No available ports found after checking ${attempts} ports`,
    );
  }

  async allocatePort(serviceName) {
    logger.info(`Allocating port for ${serviceName}`);

    // Check existing allocation
    if (this.portMap[serviceName]) {
      const currentPort = this.portMap[serviceName];
      const inUse = await this.isPortInUse(currentPort);

      // If port is already allocated and not in use by another service, reuse it
      if (!inUse) {
        logger.info(`Reusing existing port ${currentPort} for ${serviceName}`);
        return {
          hostPort: currentPort,
          containerPort: this.standardContainerPort,
        };
      } else {
        logger.warn(
          `Previously allocated port ${currentPort} for ${serviceName} is in use, finding new port`,
        );
        delete this.portMap[serviceName];
      }
    }

    try {
      const hostPort = await this.findNextAvailablePort();
      this.portMap[serviceName] = hostPort;
      await this.savePorts();

      logger.info(
        `Allocated new port mapping for ${serviceName}: ${hostPort} -> ${this.standardContainerPort}`,
      );

      return {
        hostPort,
        containerPort: this.standardContainerPort,
      };
    } catch (error) {
      logger.error("Port allocation failed:", error);
      throw error;
    }
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
