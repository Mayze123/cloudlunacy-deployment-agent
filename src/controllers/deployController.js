/**
 * Deploy Controller
 *
 * Handles application deployment requests from the backend.
 */

const logger = require("../../utils/logger");
const ZeroDowntimeDeployer = require("../../modules/zeroDowntimeDeployer");
const config = require("../config");

class DeployController {
  constructor() {
    this.deployer = null;
  }

  /**
   * Initialize the zero downtime deployer
   * @returns {ZeroDowntimeDeployer} - Initialized deployer instance
   */
  getDeployer() {
    if (!this.deployer) {
      this.deployer = new ZeroDowntimeDeployer();
    }
    return this.deployer;
  }

  /**
   * Handle deploy app message.
   * @param {Object} message - Deploy app message.
   * @param {WebSocket} ws - WebSocket connection to respond on.
   */
  async handleDeployApp(message, ws) {
    const { payload } = message;

    try {
      logger.info(
        `Starting deployment process for ${payload.appName || "application"}`,
      );

      // Validate required fields
      this.validateDeployPayload(payload);

      // Initialize deployer if not already done
      const deployer = this.getDeployer();

      // Authentication method determination
      if (payload.githubToken) {
        logger.info("Deploying with GitHub App authentication");
      } else if (payload.sshKey) {
        logger.info("Deploying with SSH key authentication");
      } else {
        logger.info("Deploying with public repository (no authentication)");
      }

      // Start deployment process
      await deployer.deploy(payload, ws);
    } catch (error) {
      logger.error(`Deployment failed: ${error.message}`, error);

      // Send error message to client
      if (ws && ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            type: "deploy_error",
            error: error.message,
            deploymentId: payload.deploymentId,
            requestId: message.requestId || null,
          }),
        );
      }
    }
  }

  /**
   * Validate deployment payload contains all required fields
   * @param {Object} payload - Deployment payload
   * @throws {Error} If validation fails
   */
  validateDeployPayload(payload) {
    const requiredFields = [
      "deploymentId",
      "appName",
      "repoOwner",
      "repoName",
      "branch",
    ];

    const missingFields = requiredFields.filter((field) => !payload[field]);

    if (missingFields.length > 0) {
      throw new Error(
        `Missing required deployment fields: ${missingFields.join(", ")}`,
      );
    }

    // Validate authentication method
    if (!payload.githubToken && !payload.sshKey && payload.isPrivate) {
      throw new Error("Authentication required for private repository");
    }
  }
}

module.exports = new DeployController();
