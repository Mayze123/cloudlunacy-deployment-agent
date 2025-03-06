// utils/portManager.js - Fixed with verifyPortMapping function

const fs = require("fs").promises;
const path = require("path");
const logger = require("./logger");
const { executeCommand } = require("./executor");

class PortManager {
  constructor() {
    this.portsFile = "/opt/cloudlunacy/config/ports.json";
    this.portRangeStart = 10000;
    this.portRangeEnd = 20000;
    this.reservedPorts = new Set([80, 443, 3005, 8080, 8081, 27017]); // Include Traefik dashboard port
    this.standardContainerPort = 8080;
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

  // Add the missing verifyPortMapping function
  async verifyPortMapping(serviceName, hostPort) {
    // This method ensures that a service always gets the expected port
    // It updates our records if needed and ensures the front server is in sync
    logger.info(`Verifying port mapping for ${serviceName}: ${hostPort}`);

    if (this.portMap[serviceName] && this.portMap[serviceName] !== hostPort) {
      logger.info(
        `Port mapping mismatch for ${serviceName}: recorded ${this.portMap[serviceName]}, actual ${hostPort}`,
      );
      this.portMap[serviceName] = hostPort;
      await this.savePorts();
      return true;
    }

    // If no mapping exists for this service, create one
    if (!this.portMap[serviceName]) {
      logger.info(`Creating new port mapping for ${serviceName}: ${hostPort}`);
      this.portMap[serviceName] = hostPort;
      await this.savePorts();
      return true;
    }

    return false;
  }

  // More accurate port check - uses Docker directly
  async isPortAvailable(port) {
    try {
      // First check: Use netstat to see if something is actively listening
      const { stdout: netstatOutput } = await executeCommand(
        "netstat",
        ["-tulpn"],
        { ignoreError: true },
      );
      if (netstatOutput.includes(`:${port} `)) {
        logger.info(`Port ${port} found in use via netstat`);
        return false;
      }

      // Second check: Check if Docker has any containers using this port
      const { stdout: dockerOutput } = await executeCommand("docker", [
        "ps",
        "-a",
        "--format",
        '"{{.Ports}}"',
      ]);
      if (
        dockerOutput.includes(`:${port}-`) ||
        dockerOutput.includes(`:${port}/`)
      ) {
        logger.info(`Port ${port} found allocated in Docker containers`);
        return false;
      }

      // Third check: Try to bind to the port temporarily to verify it's truly free
      try {
        const { stdout: bindCheckOutput } = await executeCommand(
          "node",
          [
            "-e",
            `
          const net = require('net');
          const server = net.createServer();
          server.listen(${port}, '0.0.0.0', () => {
            console.log('Port is available');
            server.close(() => process.exit(0));
          });
          server.on('error', () => {
            console.log('Port is in use');
            process.exit(1);
          });
        `,
          ],
          { timeout: 2000, ignoreError: true },
        );

        if (bindCheckOutput.includes("Port is available")) {
          logger.info(
            `Port ${port} verified available through direct binding test`,
          );
          return true;
        } else {
          logger.info(`Port ${port} binding test failed - port is in use`);
          return false;
        }
      } catch (error) {
        logger.info(`Port ${port} binding test error: ${error.message}`);
        return false;
      }

      return true;
    } catch (error) {
      logger.warn(`Error checking port ${port} availability: ${error.message}`);
      // If we can't determine, be pessimistic and say it's not available
      return false;
    }
  }

  // Forcefully free a port by killing any processes using it
  async forceReleasePort(port) {
    try {
      logger.info(`Attempting to forcefully release port ${port}`);

      // First: Try to find any Docker containers using this port
      const { stdout: containerOutput } = await executeCommand(
        "docker",
        ["ps", "-q", "--filter", `publish=${port}`],
        { ignoreError: true },
      );

      if (containerOutput.trim()) {
        const containerIds = containerOutput.trim().split("\n");
        logger.info(
          `Found ${containerIds.length} containers using port ${port}: ${containerIds.join(", ")}`,
        );

        // Stop all containers using this port
        for (const id of containerIds) {
          try {
            await executeCommand("docker", ["stop", "--time=1", id], {
              ignoreError: true,
            });
            logger.info(`Stopped container ${id} that was using port ${port}`);
          } catch (stopErr) {
            logger.warn(`Could not stop container ${id}: ${stopErr.message}`);
          }
        }
      }

      // Second: Try to find any processes using this port
      try {
        const { stdout: pidOutput } = await executeCommand(
          "lsof",
          ["-ti", `:${port}`],
          { ignoreError: true },
        );
        if (pidOutput.trim()) {
          const pids = pidOutput.trim().split("\n");
          logger.info(
            `Found ${pids.length} processes using port ${port}: ${pids.join(", ")}`,
          );

          // Kill processes
          for (const pid of pids) {
            try {
              await executeCommand("kill", ["-9", pid], { ignoreError: true });
              logger.info(`Killed process ${pid} that was using port ${port}`);
            } catch (killErr) {
              logger.warn(`Could not kill process ${pid}: ${killErr.message}`);
            }
          }
        }
      } catch (lsofErr) {
        logger.info(`No processes found using port ${port} via lsof`);
      }

      // Wait a moment for OS to release the port
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify the port is now available
      const available = await this.isPortAvailable(port);
      logger.info(
        `Port ${port} availability after force release: ${available}`,
      );
      return available;
    } catch (error) {
      logger.error(`Error forcefully releasing port ${port}: ${error.message}`);
      return false;
    }
  }

  async allocatePort(serviceName) {
    logger.info(`Allocating port for ${serviceName}`);

    // Check existing allocation - reuse the previous port assignment for consistency
    if (this.portMap[serviceName]) {
      const assignedPort = this.portMap[serviceName];
      logger.info(
        `Service ${serviceName} has assigned port ${assignedPort}, checking availability`,
      );

      // Check if the assigned port is actually available
      const isAvailable = await this.isPortAvailable(assignedPort);

      if (isAvailable) {
        logger.info(`Using existing port ${assignedPort} for ${serviceName}`);
        return {
          hostPort: assignedPort,
          containerPort: this.standardContainerPort,
        };
      } else {
        // Port is not available despite being assigned to this service
        logger.warn(
          `Assigned port ${assignedPort} for ${serviceName} is not available, attempting to force release`,
        );

        const released = await this.forceReleasePort(assignedPort);
        if (released) {
          logger.info(
            `Successfully released port ${assignedPort} for ${serviceName}`,
          );
          return {
            hostPort: assignedPort,
            containerPort: this.standardContainerPort,
          };
        } else {
          logger.warn(
            `Could not release port ${assignedPort}, will find a new port for ${serviceName}`,
          );
        }
      }
    }

    // Find a new available port
    let port = this.generateDeterministicPort(serviceName);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const isAvailable = await this.isPortAvailable(port);
      if (isAvailable) {
        logger.info(`Allocated new port ${port} for ${serviceName}`);
        this.portMap[serviceName] = port;
        await this.savePorts();
        return {
          hostPort: port,
          containerPort: this.standardContainerPort,
        };
      }

      // Try next port in sequence
      port = port + 1;
      if (port > this.portRangeEnd) port = this.portRangeStart;

      // Skip reserved ports
      while (this.reservedPorts.has(port)) {
        port++;
      }

      attempts++;
    }

    throw new Error(
      `Failed to allocate an available port for ${serviceName} after ${maxAttempts} attempts`,
    );
  }

  generateDeterministicPort(serviceName) {
    // Create a deterministic port number based on the service name
    let hash = 0;
    for (let i = 0; i < serviceName.length; i++) {
      hash = (hash << 5) - hash + serviceName.charCodeAt(i);
      hash |= 0; // Convert to 32bit integer
    }

    hash = Math.abs(hash);
    const portOffset = hash % (this.portRangeEnd - this.portRangeStart);
    let port = this.portRangeStart + portOffset;

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

  // Find a free port in a specific range
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
          const isAvailable = await this.isPortAvailable(port);
          if (isAvailable) {
            logger.info(`Found free port: ${port}`);
            return port;
          }
        } catch (error) {
          logger.warn(`Error checking port ${port}: ${error.message}`);
        }
      }
    }

    throw new Error(
      `No free ports available between ${startPort} and ${endPort}`,
    );
  }
}

module.exports = new PortManager();
