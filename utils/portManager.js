const logger = require("./logger");
const fs = require("fs").promises;
const path = require("path");
const { executeCommand } = require("./executor");

class PortManager {
  constructor() {
    this.portsFile = "/opt/cloudlunacy/config/ports.json";
    this.portRangeStart = 30000;
    this.portRangeEnd = 32767;
    this.reservedPorts = new Set();
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

  async isPortSafeToUse(port) {
    try {
      const { stdout } = await executeCommand("lsof", ["-i", `:${port}`]);
      const processes = stdout
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          const [command] = line.split(/\s+/);
          return command;
        });

      const criticalProcesses = [
        "nginx",
        "apache",
        "mysql",
        "postgresql",
        "redis",
      ];

      return !processes.some((proc) =>
        criticalProcesses.some((critical) =>
          proc.toLowerCase().includes(critical)
        )
      );
    } catch (error) {
      return true;
    }
  }

  async findNextAvailablePort(startPort) {
    let port = startPort;
    while (port <= this.portRangeEnd) {
      const inUse = await this.isPortInUse(port);
      const isSafe = await this.isPortSafeToUse(port);
      if (!inUse && isSafe && !this.reservedPorts.has(port)) {
        return port;
      }
      port++;
    }
    throw new Error("No available ports in the range");
  }

  async allocatePort(appName, environment) {
    const appId = `${appName}-${environment}`.toLowerCase();

    // If port is already allocated, verify it's actually available and safe
    if (this.portMap[appId]) {
      const currentPort = this.portMap[appId];
      const inUse = await this.isPortInUse(currentPort);
      const isSafe = await this.isPortSafeToUse(currentPort);

      if (!inUse && isSafe) {
        logger.info(`Reusing existing port ${currentPort} for ${appId}`);
        return currentPort;
      } else {
        logger.warn(
          `Previously allocated port ${currentPort} for ${appId} is ${
            inUse ? "in use" : "not safe"
          }, finding new port`
        );
        delete this.portMap[appId];
      }
    }

    // Find first available and safe port
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
      if (!(await this.isPortSafeToUse(port))) {
        logger.warn(
          `Port ${port} is used by a critical service, skipping kill`
        );
        return false;
      }

      const { stdout } = await executeCommand("lsof", ["-i", `:${port}`]);
      const lines = stdout.split("\n");

      for (const line of lines) {
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
}

module.exports = new PortManager();
