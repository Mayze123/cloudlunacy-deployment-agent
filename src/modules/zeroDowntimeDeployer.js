/**
 * Zero Downtime Deployer
 *
 * Handles zero-downtime deployment of applications using blue/green deployment strategy.
 */

const { execSync } = require("child_process");
const fs = require("fs").promises;
const path = require("path");
const logger = require("../utils/logger");
const config = require("../config");

class ZeroDowntimeDeployer {
  constructor() {
    this.healthCheckRetries =
      parseInt(process.env.HEALTH_CHECK_RETRIES, 10) || 5;
    this.healthCheckInterval =
      parseInt(process.env.HEALTH_CHECK_INTERVAL, 10) || 10000;
    this.startupGracePeriod =
      parseInt(process.env.STARTUP_GRACE_PERIOD, 10) || 30000;
    this.rollbackTimeout = parseInt(process.env.ROLLBACK_TIMEOUT, 10) || 180000;
    this.deployBaseDir = config.deployment.baseDir;
    this.templatesDir = config.deployment.templatesDir;
    this.deploymentLocks = new Set();
    this.STANDARD_CONTAINER_PORT = 8080;
  }

  /**
   * Validate deployment prerequisites
   * @returns {Promise<void>}
   * @throws {Error} If prerequisites validation fails
   */
  validatePrerequisites = async () => {
    try {
      await this.executeCommand("which", ["docker"]);
      await this.executeCommand("which", ["docker-compose"]);
      await this.validateNetworks();
    } catch (error) {
      throw new Error(`Prerequisite validation failed: ${error.message}`);
    }
  };

  /**
   * Validate that required Docker networks exist, create if needed
   * @returns {Promise<void>}
   * @throws {Error} If network validation fails
   */
  async validateNetworks() {
    try {
      const { stdout: networks } = await this.executeCommand("docker", [
        "network",
        "ls",
        "--format",
        "{{.Name}}",
      ]);

      if (!networks.includes("traefik-network")) {
        logger.info("Creating traefik-network as it doesn't exist");
        await this.executeCommand("docker", [
          "network",
          "create",
          "traefik-network",
        ]);
      } else {
        logger.debug("traefik-network exists, continuing deployment");
      }
    } catch (error) {
      throw new Error(`Network validation failed: ${error.message}`);
    }
  }

  /**
   * Helper method to execute commands
   * @param {string} command - Command to execute
   * @param {string[]} args - Command arguments
   * @param {Object} options - Execution options
   * @returns {Promise<{stdout: string, stderr: string}>} - Command output
   */
  async executeCommand(command, args = [], options = {}) {
    // This is a stub implementation
    logger.debug(`Executing command: ${command} ${args.join(" ")}`);

    try {
      const stdout = execSync(`${command} ${args.join(" ")}`, {
        encoding: "utf8",
        ...options,
      });

      return { stdout, stderr: "" };
    } catch (error) {
      logger.error(`Command execution failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Deploy an application
   * @param {Object} payload - Deployment payload
   * @param {WebSocket} ws - WebSocket connection for progress updates
   * @returns {Promise<Object>} - Deployment result
   */
  async deploy(payload, ws) {
    // Check if deployment for this app is already in progress
    const appKey = `${payload.repoOwner}/${payload.repoName}:${payload.appName}`;

    if (this.deploymentLocks.has(appKey)) {
      const message = `Deployment for ${appKey} is already in progress`;
      logger.warn(message);

      if (ws) {
        ws.send(
          JSON.stringify({
            type: "deployment_status",
            status: "error",
            message,
            deploymentId: payload.deploymentId,
          }),
        );
      }

      return { success: false, message };
    }

    // Add deployment lock
    this.deploymentLocks.add(appKey);

    try {
      // Validate prerequisites
      await this.validatePrerequisites();

      // Send status update
      this.sendStatusUpdate(
        ws,
        payload.deploymentId,
        "started",
        "Deployment started",
      );

      // Initialize deployment directory
      const deployDir = path.join(this.deployBaseDir, payload.appName);
      await fs.mkdir(deployDir, { recursive: true });

      // Clone repository
      await this.cloneRepository(payload, deployDir);

      // Determine deployment color (blue/green)
      const currentColor = await this.getCurrentDeploymentColor(
        payload.appName,
      );
      const targetColor = currentColor === "blue" ? "green" : "blue";

      // Prepare deployment files
      await this.prepareDeploymentFiles(payload, deployDir, targetColor);

      // Deploy the application
      await this.deployApplication(payload, deployDir, targetColor);

      // Run health checks
      const healthCheckResult = await this.runHealthChecks(
        payload,
        targetColor,
      );

      if (!healthCheckResult.success) {
        // Roll back if health checks fail
        await this.rollback(payload, currentColor);
        throw new Error(`Health checks failed: ${healthCheckResult.message}`);
      }

      // Switch traffic to new deployment
      await this.switchTraffic(payload.appName, targetColor);

      // Mark deployment as successful
      this.sendStatusUpdate(
        ws,
        payload.deploymentId,
        "completed",
        `Deployment of ${payload.appName} completed successfully`,
        { color: targetColor },
      );

      return {
        success: true,
        message: `Deployment completed successfully`,
        color: targetColor,
      };
    } catch (error) {
      logger.error(`Deployment failed: ${error.message}`);

      // Send error status
      this.sendStatusUpdate(
        ws,
        payload.deploymentId,
        "error",
        `Deployment failed: ${error.message}`,
      );

      return { success: false, message: error.message };
    } finally {
      // Remove deployment lock
      this.deploymentLocks.delete(appKey);
    }
  }

  /**
   * Clone repository to the deployment directory
   * @param {Object} payload - Deployment payload
   * @param {string} deployDir - Deployment directory
   * @returns {Promise<void>}
   */
  async cloneRepository(payload, deployDir) {
    // This is a stub implementation
    logger.info(`Cloning repository ${payload.repoOwner}/${payload.repoName}`);
    return Promise.resolve();
  }

  /**
   * Get current deployment color for an application
   * @param {string} appName - Application name
   * @returns {Promise<string>} - Current color ('blue' or 'green')
   */
  async getCurrentDeploymentColor(appName) {
    // This is a stub implementation
    // In a real implementation, this would check which color is currently receiving traffic
    return Promise.resolve("blue");
  }

  /**
   * Prepare deployment files for the target color
   * @param {Object} payload - Deployment payload
   * @param {string} deployDir - Deployment directory
   * @param {string} color - Target color ('blue' or 'green')
   * @returns {Promise<void>}
   */
  async prepareDeploymentFiles(payload, deployDir, color) {
    // This is a stub implementation
    logger.info(`Preparing deployment files for ${payload.appName}-${color}`);
    return Promise.resolve();
  }

  /**
   * Deploy the application
   * @param {Object} payload - Deployment payload
   * @param {string} deployDir - Deployment directory
   * @param {string} color - Target color ('blue' or 'green')
   * @returns {Promise<void>}
   */
  async deployApplication(payload, deployDir, color) {
    // This is a stub implementation
    logger.info(`Deploying ${payload.appName}-${color}`);
    return Promise.resolve();
  }

  /**
   * Run health checks on the deployed application
   * @param {Object} payload - Deployment payload
   * @param {string} color - Target color ('blue' or 'green')
   * @returns {Promise<Object>} - Health check result
   */
  async runHealthChecks(payload, color) {
    // This is a stub implementation
    logger.info(`Running health checks for ${payload.appName}-${color}`);
    return { success: true, message: "Health checks passed" };
  }

  /**
   * Roll back to previous deployment
   * @param {Object} payload - Deployment payload
   * @param {string} color - Color to roll back to ('blue' or 'green')
   * @returns {Promise<void>}
   */
  async rollback(payload, color) {
    // This is a stub implementation
    logger.info(`Rolling back to ${payload.appName}-${color}`);
    return Promise.resolve();
  }

  /**
   * Switch traffic to the new deployment
   * @param {string} appName - Application name
   * @param {string} color - Target color ('blue' or 'green')
   * @returns {Promise<void>}
   */
  async switchTraffic(appName, color) {
    // This is a stub implementation
    logger.info(`Switching traffic to ${appName}-${color}`);
    return Promise.resolve();
  }

  /**
   * Send status update over WebSocket
   * @param {WebSocket} ws - WebSocket connection
   * @param {string} deploymentId - Deployment ID
   * @param {string} status - Status ('started', 'progress', 'completed', 'error')
   * @param {string} message - Status message
   * @param {Object} data - Additional data
   */
  sendStatusUpdate(ws, deploymentId, status, message, data = {}) {
    if (ws && ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: "deployment_status",
          deploymentId,
          status,
          message,
          ...data,
        }),
      );
    }
  }
}

module.exports = ZeroDowntimeDeployer;
