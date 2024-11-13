const logger = require("./logger");
const fs = require("fs").promises;
const path = require("path");
const net = require("net");
const { executeCommand } = require("./executor");

class PortManager {
  constructor() {
    this.portsFile = "/opt/cloudlunacy/config/ports.json";
    this.portRangeStart = 30000;
    this.portRangeEnd = 32767;
    this.reservedPorts = new Set([80, 443]); // Reserve Traefik ports
    this.containerPort = 8080; // Default container port
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
    try {
      // Check Docker containers first
      try {
        const { stdout: dockerPorts } = await executeCommand("docker", [
          "ps",
          "--format",
          "{{.Ports}}",
        ]);
        if (dockerPorts.includes(`:${port}`)) {
          logger.debug(`Port ${port} is in use by a Docker container`);
          return true;
        }
      } catch (dockerError) {
        logger.warn("Error checking Docker ports:", dockerError);
      }

      // Check system ports using netstat
      const { stdout } = await executeCommand("netstat", ["-tuln"]);
      if (stdout.includes(`:${port} `)) {
        logger.debug(`Port ${port} is in use according to netstat`);
        return true;
      }

      // Final check with direct socket connection
      return new Promise((resolve) => {
        const socket = net.createServer();

        socket.once("error", (err) => {
          socket.close();
          if (err.code === "EADDRINUSE") {
            logger.debug(`Port ${port} is in use (socket check)`);
            resolve(true);
          } else {
            resolve(false);
          }
        });

        socket.once("listening", () => {
          socket.close();
          logger.debug(`Port ${port} is available`);
          resolve(false);
        });

        socket.listen(port);
      });
    } catch (error) {
      logger.warn(`Error checking port ${port}:`, error);
      return true; // Assume port is in use if we can't check it
    }
  }

  async isPortSafeToUse(port) {
    try {
      // Check reserved ports
      if (this.reservedPorts.has(port)) {
        logger.debug(`Port ${port} is reserved`);
        return false;
      }

      // Check running processes
      const { stdout } = await executeCommand("lsof", ["-i", `:${port}`]);
      const processes = stdout
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          const [command] = line.split(/\s+/);
          return command;
        });

      const criticalProcesses = [
        "traefik",
        "nginx",
        "apache",
        "mysql",
        "postgresql",
        "redis",
        "docker",
        "containerd",
      ];

      const isSafe = !processes.some((proc) =>
        criticalProcesses.some((critical) =>
          proc.toLowerCase().includes(critical)
        )
      );

      logger.debug(`Port ${port} safe to use: ${isSafe}`);
      return isSafe;
    } catch (error) {
      logger.warn(`Error checking port safety for ${port}:`, error);
      return true; // If we can't check, assume it's safe
    }
  }

  async findNextAvailablePort(startPort) {
    let port = startPort;
    let attempts = 0;
    const maxAttempts = 100; // Prevent infinite loops

    while (port <= this.portRangeEnd && attempts < maxAttempts) {
      logger.debug(`Checking port ${port} availability...`);
      const inUse = await this.isPortInUse(port);
      const isSafe = await this.isPortSafeToUse(port);

      if (!inUse && isSafe && !this.reservedPorts.has(port)) {
        // Verify not in use by Traefik
        try {
          const { stdout } = await executeCommand("docker", [
            "exec",
            "traefik-proxy",
            "traefik",
            "healthcheck",
          ]);
          if (!stdout.includes(`:${port}`)) {
            logger.debug(`Found available port: ${port}`);
            return port;
          }
        } catch (error) {
          // If we can't check Traefik, assume port is available
          logger.debug(
            `Traefik check failed, assuming port ${port} is available`
          );
          return port;
        }
      }
      port++;
      attempts++;
    }

    throw new Error(
      `No available ports found after checking ${attempts} ports starting from ${startPort}`
    );
  }

  async allocatePort(appName, environment) {
    const appId = `${appName}-${environment}`.toLowerCase();
    logger.info(`Allocating port for ${appId}`);

    // Check existing allocation
    if (this.portMap[appId]) {
      const currentPort = this.portMap[appId];
      const inUse = await this.isPortInUse(currentPort);
      const isSafe = await this.isPortSafeToUse(currentPort);

      if (!inUse && isSafe) {
        logger.info(`Reusing existing port ${currentPort} for ${appId}`);
        return {
          hostPort: currentPort,
          containerPort: this.containerPort,
          appId,
        };
      } else {
        logger.warn(
          `Previously allocated port ${currentPort} for ${appId} is ${
            inUse ? "in use" : "not safe"
          }, finding new port`
        );
        delete this.portMap[appId];
      }
    }

    try {
      const hostPort = await this.findNextAvailablePort(this.portRangeStart);
      this.portMap[appId] = hostPort;
      await this.savePorts();

      logger.info(
        `Allocated new port mapping for ${appId}: ${hostPort} -> ${this.containerPort}`
      );

      return {
        hostPort,
        containerPort: this.containerPort,
        appId,
      };
    } catch (error) {
      logger.error("Port allocation failed:", error);
      throw error;
    }
  }

  async releasePort(appName, environment) {
    const appId = `${appName}-${environment}`.toLowerCase();
    logger.info(`Releasing port for ${appId}`);

    if (this.portMap[appId]) {
      const port = this.portMap[appId];
      delete this.portMap[appId];
      await this.savePorts();
      logger.info(`Released port ${port} for ${appId}`);

      // Kill any processes still using this port
      await this.killProcessOnPort(port).catch((error) => {
        logger.warn(`Failed to kill processes on port ${port}:`, error);
      });
    }
  }

  async getPort(appName, environment) {
    const appId = `${appName}-${environment}`.toLowerCase();
    return this.portMap[appId];
  }

  async killProcessOnPort(port) {
    try {
      if (!(await this.isPortSafeToUse(port))) {
        logger.warn(
          `Port ${port} is used by a critical service, skipping kill`
        );
        return false;
      }

      const { stdout } = await executeCommand("lsof", ["-i", `:${port}`]);
      const lines = stdout.split("\n");
      let killed = false;

      for (const line of lines) {
        if (line.includes("PID")) continue;

        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const pid = parts[1];
          if (pid) {
            try {
              await executeCommand("kill", ["-9", pid]);
              logger.info(`Killed process ${pid} using port ${port}`);
              killed = true;
            } catch (error) {
              logger.warn(`Failed to kill process ${pid}:`, error);
            }
          }
        }
      }

      if (killed) {
        // Wait for port to be fully released
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      return killed;
    } catch (error) {
      logger.warn(`No process found using port ${port}`);
      return false;
    }
  }

  async ensurePortAvailable(port) {
    logger.info(`Ensuring port ${port} is available`);

    if (!(await this.isPortSafeToUse(port))) {
      logger.warn(
        `Port ${port} is used by a critical service, cannot ensure availability`
      );
      return false;
    }

    const inUse = await this.isPortInUse(port);
    if (inUse) {
      logger.warn(`Port ${port} is in use, attempting to free it`);
      const killed = await this.killProcessOnPort(port);
      if (killed) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return true;
      }
      return false;
    }
    return true;
  }

  async verifyPortMapping(hostPort, containerPort, appId) {
    try {
      // Verify Docker port mapping
      const { stdout } = await executeCommand("docker", [
        "ps",
        "--format",
        "{{.Names}}\t{{.Ports}}",
        "--filter",
        `name=${appId}`,
      ]);

      const expectedMapping = `${hostPort}->${containerPort}`;
      const isValid = stdout.includes(expectedMapping);
      logger.debug(`Port mapping verification for ${appId}: ${isValid}`);
      return isValid;
    } catch (error) {
      logger.warn(`Error verifying port mapping: ${error.message}`);
      return false;
    }
  }

  async getPortInfo(appName, environment) {
    const appId = `${appName}-${environment}`.toLowerCase();
    const hostPort = this.portMap[appId];
    return hostPort
      ? {
          hostPort,
          containerPort: this.containerPort,
          appId,
        }
      : null;
  }

  async reservePort(port) {
    this.reservedPorts.add(port);
    logger.info(`Reserved port ${port}`);
  }

  async unreservePort(port) {
    this.reservedPorts.delete(port);
    logger.info(`Unreserved port ${port}`);
  }
}

module.exports = new PortManager();
