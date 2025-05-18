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
      this.deployer = ZeroDowntimeDeployer; // ZeroDowntimeDeployer is already an instance
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
        `Starting deployment process for ${payload.serviceName || "application"}`,
      );

      // Validate required fields
      this.validateDeployPayload(payload);

      // Initialize deployer if not already done
      const deployer = this.getDeployer();

      // All deployments now use GitHub token authentication
      logger.info("Deploying with GitHub App authentication");

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
      "serviceName",
      "repositoryUrl",
      "appType",
      "githubToken",
      "envVarsToken",
    ];

    const missingFields = requiredFields.filter((field) => !payload[field]);

    if (missingFields.length > 0) {
      throw new Error(
        `Missing required deployment fields: ${missingFields.join(", ")}`,
      );
    }

    // No need to check for sshKey or isPrivate - we're only supporting githubToken now
  }
}

module.exports = new DeployController();
