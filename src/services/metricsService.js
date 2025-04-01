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
    this.collectionInterval = null;
    this.metricsHistory = [];
    this.initialized = false;
    this.historySize = 60; // Keep 1 hour of metrics (1 sample per minute)
  }

  /**
   * Initialize the metrics service
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      if (this.initialized) {
        return true;
      }

      logger.info("Initializing metrics service...");

      // Get configuration
      const metricsEnabled = config.metrics.enabled;
      const collectionInterval = config.metrics.interval;

      if (!metricsEnabled) {
        logger.info("Metrics collection is disabled in configuration");
        return true;
      }

      // Start collecting metrics
      this.startMetricsCollection(collectionInterval);

      this.initialized = true;
      logger.info(
        `Metrics service initialized with collection interval of ${collectionInterval}ms`,
      );
      return true;
    } catch (error) {
      logger.error(`Failed to initialize metrics service: ${error.message}`);
      return false;
    }
  }

  /**
   * Shutdown the metrics service
   * @returns {Promise<boolean>} Success status
   */
  async shutdown() {
    try {
      if (this.collectionInterval) {
        clearInterval(this.collectionInterval);
        this.collectionInterval = null;
        logger.info("Metrics collection stopped");
      }

      this.initialized = false;
      this.metricsHistory = [];
      logger.info("Metrics service shut down successfully");
      return true;
    } catch (error) {
      logger.error(`Error shutting down metrics service: ${error.message}`);
      return false;
    }
  }

  /**
   * Start collecting and reporting metrics at regular intervals
   */
  startMetricsCollection(interval) {
    // Clear any existing interval
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
    }

    logger.info(`Starting metrics collection every ${interval / 1000} seconds`);

    // Set up the interval for metrics collection
    this.collectionInterval = setInterval(async () => {
      try {
        const metrics = await this.collectMetrics();

        // Only try to send metrics if WebSocket is connected
        if (websocketService.isConnected()) {
          websocketService.sendMessage("metrics", { metrics });
        } else {
          // Just log metrics locally if WebSocket is not connected
          if (process.env.DEBUG_METRICS === "true") {
            logger.debug("Collected metrics (not sent):", metrics);
          }
        }
      } catch (error) {
        logger.error(`Failed to collect or send metrics: ${error.message}`);
      }
    }, interval);
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

      this.metricsHistory.push(metrics);
      if (this.metricsHistory.length > this.historySize) {
        this.metricsHistory.shift();
      }

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
