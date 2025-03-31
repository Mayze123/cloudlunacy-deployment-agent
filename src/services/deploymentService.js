/**
 * Deployment Service
 *
 * Handles deployment of applications and services.
 */

const logger = require("../../utils/logger");
const ZeroDowntimeDeployer = require("../../modules/zeroDowntimeDeployer");

class DeploymentService {
  constructor() {
    this.deployer = null;
    this.initialized = false;
    this.activeDeployments = new Map();
  }

  /**
   * Initialize the deployment service
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      logger.info("Initializing deployment service...");

      // Initialize the zero downtime deployer
      this.deployer = new ZeroDowntimeDeployer();
      await this.deployer.initialize();

      this.initialized = true;
      logger.info("Deployment service initialized successfully");
      return true;
    } catch (error) {
      logger.error(`Failed to initialize deployment service: ${error.message}`);
      return false;
    }
  }

  /**
   * Shutdown the deployment service
   * @returns {Promise<boolean>} Success status
   */
  async shutdown() {
    try {
      logger.info("Shutting down deployment service...");

      // Warn about active deployments
      if (this.activeDeployments.size > 0) {
        logger.warn(
          `There are ${this.activeDeployments.size} active deployments that will be interrupted`,
        );

        // Notify each deployment that it's being interrupted
        for (const [id, deployment] of this.activeDeployments.entries()) {
          logger.warn(`Interrupting deployment ${id}`);
          // If the deployment has a cleanup method, call it
          if (deployment.cleanup && typeof deployment.cleanup === "function") {
            try {
              await deployment.cleanup();
            } catch (cleanupError) {
              logger.error(
                `Error cleaning up deployment ${id}: ${cleanupError.message}`,
              );
            }
          }
        }

        this.activeDeployments.clear();
      }

      // Clean up the deployer if it exists
      if (this.deployer) {
        logger.info("Cleaning up deployer resources");

        // If the deployer has a cleanup method, call it
        if (
          this.deployer.cleanup &&
          typeof this.deployer.cleanup === "function"
        ) {
          await this.deployer.cleanup();
        }

        this.deployer = null;
      }

      this.initialized = false;
      logger.info("Deployment service shut down successfully");
      return true;
    } catch (error) {
      logger.error(`Error shutting down deployment service: ${error.message}`);
      return false;
    }
  }

  /**
   * Deploy an application
   * @param {Object} deploymentConfig Deployment configuration
   * @param {Object} socket WebSocket connection for progress updates
   * @returns {Promise<Object>} Deployment result
   */
  async deployApplication(deploymentConfig, socket) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Generate a unique ID for this deployment
      const deploymentId = `deploy-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

      // Track the deployment
      this.activeDeployments.set(deploymentId, {
        config: deploymentConfig,
        startTime: new Date(),
        status: "running",
      });

      // Use the zero downtime deployer to handle the deployment
      const result = await this.deployer.deploy(deploymentConfig, socket);

      // Update the deployment status
      this.activeDeployments.set(deploymentId, {
        ...this.activeDeployments.get(deploymentId),
        status: result.success ? "completed" : "failed",
        endTime: new Date(),
        result,
      });

      // Remove from active deployments after some time
      setTimeout(() => {
        this.activeDeployments.delete(deploymentId);
      }, 60000); // Keep for 1 minute for reference

      return result;
    } catch (error) {
      logger.error(`Deployment failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get the deployer instance
   * @returns {ZeroDowntimeDeployer} Zero downtime deployer instance
   */
  getDeployer() {
    if (!this.initialized) {
      this.initialize();
    }
    return this.deployer;
  }
}

module.exports = new DeploymentService();
