/**
 * Metrics Service
 *
 * Collects and reports system metrics to the backend.
 */

const os = require("os");
const { execSync } = require("child_process");
const logger = require("../../utils/logger");
const config = require("../config");
const websocketService = require("./websocketService");

class MetricsService {
  constructor() {
    this.metricsInterval = null;
  }

  /**
   * Start collecting and reporting metrics at regular intervals
   */
  startMetricsCollection() {
    // Clear any existing interval
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }

    logger.info(
      `Starting metrics collection every ${config.metrics.interval / 1000} seconds`,
    );

    // Set up the interval for metrics collection
    this.metricsInterval = setInterval(async () => {
      try {
        const metrics = await this.collectMetrics();
        websocketService.sendMessage("metrics", { metrics });
      } catch (error) {
        logger.error(`Failed to collect or send metrics: ${error.message}`);
      }
    }, config.metrics.interval);
  }

  /**
   * Stop metrics collection
   */
  stopMetricsCollection() {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
      logger.info("Metrics collection stopped");
    }
  }

  /**
   * Collect system metrics
   * @returns {Object} - Collected metrics
   */
  async collectMetrics() {
    try {
      const metrics = {
        timestamp: new Date().toISOString(),
        serverId: config.serverId,
        cpu: await this.getCPUUsage(),
        memory: this.getMemoryUsage(),
        disk: await this.getDiskUsage(),
        uptime: os.uptime(),
        loadAvg: os.loadavg(),
        platform: os.platform(),
        release: os.release(),
        hostname: os.hostname(),
      };

      return metrics;
    } catch (error) {
      logger.error(`Error collecting metrics: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get CPU usage metrics
   * @returns {Object} - CPU metrics
   */
  async getCPUUsage() {
    // Get CPU load averages
    const loadAvg = os.loadavg();

    // Get number of CPU cores
    const cpuCount = os.cpus().length;

    // Calculate CPU usage percentage
    // On Linux we use top for more accurate real-time usage
    let currentCpuPercent = 0;

    try {
      if (os.platform() === "linux") {
        // Use 'top' to get current CPU usage on Linux
        const topOutput = execSync("top -bn1 | grep 'Cpu(s)'").toString();
        const cpuUsageMatch = topOutput.match(/(\d+\.\d+)\s+id/);
        if (cpuUsageMatch) {
          // Top shows idle percentage, so we subtract from 100 to get usage
          currentCpuPercent = 100 - parseFloat(cpuUsageMatch[1]);
        }
      } else if (os.platform() === "darwin") {
        // Use 'top' to get current CPU usage on macOS
        const topOutput = execSync("top -l 1 | grep 'CPU usage'").toString();
        const cpuUsageMatch = topOutput.match(/(\d+\.\d+)%\s+user/);
        if (cpuUsageMatch) {
          currentCpuPercent = parseFloat(cpuUsageMatch[1]);
        }
      } else {
        // Fallback to load average based on CPU count for other platforms
        currentCpuPercent = (loadAvg[0] / cpuCount) * 100;
      }
    } catch (error) {
      logger.warn(
        `Could not get precise CPU metrics: ${error.message}. Using load average instead.`,
      );
      currentCpuPercent = (loadAvg[0] / cpuCount) * 100;
    }

    return {
      loadAvg: loadAvg,
      numCpus: cpuCount,
      currentUsagePercent: currentCpuPercent,
      cpuInfo: os.cpus(),
    };
  }

  /**
   * Get memory usage metrics
   * @returns {Object} - Memory metrics
   */
  getMemoryUsage() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const usedMemPercent = (usedMem / totalMem) * 100;

    return {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      usedPercent: usedMemPercent,
    };
  }

  /**
   * Get disk usage metrics
   * @returns {Object} - Disk usage metrics
   */
  async getDiskUsage() {
    try {
      // Use df command to get disk usage
      const dfOutput = execSync("df -h / | tail -1").toString();
      const parts = dfOutput.trim().split(/\s+/);

      // Parse df output (format varies by OS but usually includes size, used, available, use%)
      let totalSize = parts[1] || "unknown";
      let usedSize = parts[2] || "unknown";
      let availableSize = parts[3] || "unknown";
      let usedPercent = parts[4] || "unknown";

      // If usedPercent includes % sign, remove it for consistency
      if (typeof usedPercent === "string" && usedPercent.includes("%")) {
        usedPercent = parseFloat(usedPercent.replace("%", ""));
      }

      return { totalSize, usedSize, availableSize, usedPercent };
    } catch (error) {
      logger.warn(`Could not get disk metrics: ${error.message}`);
      return {
        totalSize: "unknown",
        usedSize: "unknown",
        availableSize: "unknown",
        usedPercent: "unknown",
        error: error.message,
      };
    }
  }
}

module.exports = new MetricsService();
