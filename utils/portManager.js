const fs = require("fs").promises;
const path = require("path");
const logger = require("./logger");
const { executeCommand } = require("./executor");
const net = require("net");

class PortManager {
  constructor() {
    this.portsFile = "/opt/cloudlunacy/config/ports.json";
    this.portRangeStart = 3000;
    this.portRangeEnd = 3999;
    this.reservedPorts = new Set([3000]); // Reserved for system use
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
    await fs.writeFile(this.portsFile, JSON.stringify(this.portMap, null, 2));
  }

  async isPortInUse(port) {
    try {
      // Check using netstat
      const { stdout } = await executeCommand("netstat", ["-tuln"]);
      if (stdout.includes(`:${port} `)) {
        return true;
      }

      // Double-check with a socket connection
      return new Promise((resolve) => {
        const socket = net.createServer();

        socket.once("error", (err) => {
          socket.close();
          if (err.code === "EADDRINUSE") {
            resolve(true);
          } else {
            resolve(false);
          }
        });

        socket.once("listening", () => {
          socket.close();
          resolve(false);
        });

        socket.listen(port);
      });
    } catch (error) {
      logger.warn(`Error checking port ${port}:`, error);
      return true; // Assume port is in use if we can't check it
    }
  }

  async findNextAvailablePort(startPort) {
    let port = startPort;
    while (port <= this.portRangeEnd) {
      const inUse = await this.isPortInUse(port);
      if (!inUse && !this.reservedPorts.has(port)) {
        return port;
      }
      port++;
    }
    throw new Error("No available ports in the range");
  }

  async allocatePort(appName, environment) {
    const appId = `${appName}-${environment}`.toLowerCase();

    // If port is already allocated, verify it's actually available
    if (this.portMap[appId]) {
      const currentPort = this.portMap[appId];
      const inUse = await this.isPortInUse(currentPort);

      if (!inUse) {
        logger.info(`Reusing existing port ${currentPort} for ${appId}`);
        return currentPort;
      } else {
        logger.warn(
          `Previously allocated port ${currentPort} for ${appId} is in use, finding new port`
        );
        delete this.portMap[appId];
      }
    }

    // Get all allocated ports
    const allocatedPorts = new Set([
      ...Object.values(this.portMap),
      ...this.reservedPorts,
    ]);

    // Find first available port that's not allocated and not in use
    try {
      const port = await this.findNextAvailablePort(this.portRangeStart);
      this.portMap[appId] = port;
      await this.savePorts();
      logger.info(`Allocated new port ${port} for ${appId}`);
      return port;
    } catch (error) {
      logger.error("Port allocation failed:", error);
      throw error;
    }
  }

  async releasePort(appName, environment) {
    const appId = `${appName}-${environment}`.toLowerCase();
    if (this.portMap[appId]) {
      const port = this.portMap[appId];
      delete this.portMap[appId];
      await this.savePorts();
      logger.info(`Released port ${port} for ${appId}`);
    }
  }

  async getPort(appName, environment) {
    const appId = `${appName}-${environment}`.toLowerCase();
    return this.portMap[appId];
  }

  async killProcessOnPort(port) {
    try {
      // Get process using the port
      const { stdout } = await executeCommand("lsof", ["-i", `:${port}`]);
      const lines = stdout.split("\n");

      for (const line of lines) {
        // Skip header line
        if (line.includes("PID")) continue;

        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const pid = parts[1];
          if (pid) {
            try {
              await executeCommand("kill", ["-9", pid]);
              logger.info(`Killed process ${pid} using port ${port}`);
              return true;
            } catch (error) {
              logger.warn(`Failed to kill process ${pid}:`, error);
            }
          }
        }
      }
    } catch (error) {
      logger.warn(`No process found using port ${port}`);
    }
    return false;
  }

  async ensurePortAvailable(port) {
    const inUse = await this.isPortInUse(port);
    if (inUse) {
      logger.warn(`Port ${port} is in use, attempting to free it`);
      const killed = await this.killProcessOnPort(port);
      if (killed) {
        // Wait a bit for the port to be fully released
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return true;
      }
      return false;
    }
    return true;
  }
}

module.exports = new PortManager();
