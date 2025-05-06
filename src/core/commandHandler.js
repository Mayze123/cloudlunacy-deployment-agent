/**
 * Command Handler
 *
 * Central logic for processing commands from both Queue and WebSocket sources.
 * This adapter allows using the existing controllers with the new queue-based system.
 */

const logger = require("../../utils/logger");
const deployController = require("../controllers/deployController");
const databaseController = require("../controllers/databaseController");
const repositoryController = require("../controllers/repositoryController");
const queueService = require("../services/queueService");

class CommandHandler {
  constructor() {
    this.initialized = false;
  }

  /**
   * Initialize the command handler
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      this.initialized = true;
      logger.info("Command handler initialized successfully");
      return true;
    } catch (error) {
      logger.error(`Failed to initialize command handler: ${error.message}`);
      return false;
    }
  }

  /**
   * Process a job from the queue
   * @param {Object} job Job object from the queue
   * @returns {Promise<Object>} Processing result
   */
  async processJob(job) {
    logger.info(`Processing job ${job.id} of type ${job.actionType}`);

    try {
      // Create a WebSocket-like adapter for the controllers to send results
      const wsAdapter = this.createQueueAdapter(job.id);

      // First, log the start of job processing
      await queueService.publishLog({
        jobId: job.id,
        content: `Starting job ${job.id} (${job.actionType})`,
        timestamp: new Date().toISOString(),
      });

      // Publish a result update to indicate we've started processing
      await queueService.publishResult({
        jobId: job.id,
        status: "PROCESSING",
        result: {
          message: `Agent ${queueService.serverId} is processing the job`,
          timestamp: new Date().toISOString(),
        },
      });

      // Map the job action type to the appropriate handler
      switch (job.actionType) {
        case "deploy_app":
          return await this.handleDeployApp(job, wsAdapter);

        case "install_database":
          return await this.handleDatabaseInstallation(job, wsAdapter);

        case "create_database":
          return await this.handleDatabaseCreation(job, wsAdapter);

        case "configure_firewall":
          return await this.handleFirewallConfiguration(job, wsAdapter);

        case "install_service":
          return await this.handleServiceInstallation(job, wsAdapter);

        case "backup_database":
          return await this.handleDatabaseBackup(job, wsAdapter);

        case "restore_database":
          return await this.handleDatabaseRestore(job, wsAdapter);

        case "restart_service":
          return await this.handleServiceRestart(job, wsAdapter);

        default:
          throw new Error(`Unknown action type: ${job.actionType}`);
      }
    } catch (error) {
      logger.error(`Error processing job ${job.id}: ${error.message}`);

      // Publish error result
      await queueService.publishResult({
        jobId: job.id,
        status: "FAILED",
        error: error.message,
      });

      // Log the error
      await queueService.publishLog({
        jobId: job.id,
        content: `Job failed: ${error.message}`,
        timestamp: new Date().toISOString(),
      });

      throw error;
    }
  }

  /**
   * Create a WebSocket-like adapter for the queue
   * @param {string} jobId Job ID
   * @returns {Object} WebSocket-like adapter
   */
  createQueueAdapter(jobId) {
    return {
      readyState: 1, // WebSocket.OPEN
      send: async function (data) {
        try {
          const message = JSON.parse(data);

          // Map different message types to appropriate queue operations
          switch (message.type) {
            case "deployment_status":
              // Map deployment status updates to job results
              let resultStatus = "PROCESSING";
              if (
                message.status === "success" ||
                message.status === "completed"
              ) {
                resultStatus = "SUCCESS";
              } else if (
                message.status === "failed" ||
                message.status === "error"
              ) {
                resultStatus = "FAILED";
              }

              await queueService.publishResult({
                jobId: jobId,
                status: resultStatus,
                result: message,
                error: message.error || null,
              });

              // Also log the status update
              await queueService.publishLog({
                jobId: jobId,
                content:
                  message.message || `Deployment status: ${message.status}`,
                timestamp: new Date().toISOString(),
              });
              break;

            case "database_installed":
            case "database_operation_completed":
              // Handle database operation completion
              await queueService.publishResult({
                jobId: jobId,
                status: "SUCCESS",
                result: message,
              });

              await queueService.publishLog({
                jobId: jobId,
                content: `Database operation completed: ${JSON.stringify(message)}`,
                timestamp: new Date().toISOString(),
              });
              break;

            case "database_installation_failed":
            case "error":
              // Handle errors
              await queueService.publishResult({
                jobId: jobId,
                status: "FAILED",
                error: message.error || "Unknown error",
              });

              await queueService.publishLog({
                jobId: jobId,
                content: `Error: ${message.error || "Unknown error"}`,
                timestamp: new Date().toISOString(),
              });
              break;

            default:
              // For any other message type, log it
              await queueService.publishLog({
                jobId: jobId,
                content: `Message: ${JSON.stringify(message)}`,
                timestamp: new Date().toISOString(),
              });
          }
        } catch (error) {
          logger.error(
            `Error processing message in queue adapter: ${error.message}`,
          );

          // Log the error
          await queueService.publishLog({
            jobId: jobId,
            content: `Error processing message: ${error.message}`,
            timestamp: new Date().toISOString(),
          });
        }
      },
    };
  }

  /**
   * Handle deploy app job
   * @param {Object} job Job object
   * @param {Object} wsAdapter WebSocket-like adapter
   * @returns {Promise<Object>} Result
   */
  async handleDeployApp(job, wsAdapter) {
    try {
      // Log start of deployment
      await queueService.publishLog({
        jobId: job.id,
        content: `Starting deployment from ${job.parameters.repositoryUrl}`,
        timestamp: new Date().toISOString(),
      });

      // Convert job parameters to the format expected by the deployment controller
      const message = {
        type: "deploy_app",
        requestId: job.id,
        payload: {
          deploymentId: job.id,
          appType: job.parameters.appType || "nodejs",
          appName: job.parameters.appName,
          // Parse repo owner and name from repository URL
          repositoryOwner: this.parseRepositoryOwner(
            job.parameters.repositoryUrl,
          ),
          repositoryName: this.parseRepositoryName(
            job.parameters.repositoryUrl,
          ),
          branch: job.parameters.branch || "main",
          githubToken: job.parameters.githubToken,
          environment: job.parameters.environment || "production",
          serviceName: job.parameters.appName,
          domain: job.parameters.domain,
          envVarsToken: job.parameters.envVarsToken,
        },
      };

      // Use the existing deployment controller to handle the deployment
      if (
        message.payload.appType?.toLowerCase() === "mongodb" ||
        message.payload.appType?.toLowerCase() === "mongo"
      ) {
        await databaseController.handleDatabaseDeployment(
          message.payload,
          wsAdapter,
        );
      } else {
        await deployController.handleDeployApp(message, wsAdapter);
      }

      return { success: true };
    } catch (error) {
      logger.error(`Error handling deploy app job: ${error.message}`);
      throw error;
    }
  }

  /**
   * Parse repository owner from repository URL
   * @param {string} repositoryUrl Repository URL
   * @returns {string} Repository owner
   */
  parseRepositoryOwner(repositoryUrl) {
    try {
      // Handle different Git URL formats
      if (repositoryUrl.includes("github.com")) {
        // GitHub URL format: https://github.com/owner/repo.git or git@github.com:owner/repo.git
        const ownerRepoPart = repositoryUrl
          .split("github.com")[1]
          .replace(":", "/")
          .split("/");
        return ownerRepoPart[1];
      } else if (repositoryUrl.includes("gitlab.com")) {
        // GitLab URL format: https://gitlab.com/owner/repo.git or git@gitlab.com:owner/repo.git
        const ownerRepoPart = repositoryUrl
          .split("gitlab.com")[1]
          .replace(":", "/")
          .split("/");
        return ownerRepoPart[1];
      } else if (repositoryUrl.includes("bitbucket.org")) {
        // Bitbucket URL format: https://bitbucket.org/owner/repo.git or git@bitbucket.org:owner/repo.git
        const ownerRepoPart = repositoryUrl
          .split("bitbucket.org")[1]
          .replace(":", "/")
          .split("/");
        return ownerRepoPart[1];
      } else {
        // Generic approach for other Git providers
        const parts = repositoryUrl.split("/");
        return parts[parts.length - 2];
      }
    } catch (error) {
      logger.warn(
        `Could not parse repository owner from URL ${repositoryUrl}: ${error.message}`,
      );
      return "unknown";
    }
  }

  /**
   * Parse repository name from repository URL
   * @param {string} repositoryUrl Repository URL
   * @returns {string} Repository name
   */
  parseRepositoryName(repositoryUrl) {
    try {
      // Extract the repository name from the URL and remove .git extension if present
      const parts = repositoryUrl.split("/");
      const repoNameWithExt = parts[parts.length - 1];
      return repoNameWithExt.replace(".git", "");
    } catch (error) {
      logger.warn(
        `Could not parse repository name from URL ${repositoryUrl}: ${error.message}`,
      );
      return "unknown";
    }
  }

  /**
   * Handle database installation job
   * @param {Object} job Job object
   * @param {Object} wsAdapter WebSocket-like adapter
   * @returns {Promise<Object>} Result
   */
  async handleDatabaseInstallation(job, wsAdapter) {
    try {
      // Log start of database installation
      await queueService.publishLog({
        jobId: job.id,
        content: `Starting installation of ${job.parameters.dbType}`,
        timestamp: new Date().toISOString(),
      });

      // Convert job parameters to the format expected by the database controller
      const payload = {
        installationId: job.id,
        dbType: job.parameters.dbType,
        operation: "install",
        dbName: job.parameters.dbName,
        username: job.parameters.username,
        password: job.parameters.password,
        options: job.parameters.options,
      };

      // Use the existing database controller to handle the installation
      await databaseController.handleDatabaseManagement(payload, wsAdapter);

      return { success: true };
    } catch (error) {
      logger.error(
        `Error handling database installation job: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Handle database creation job
   * @param {Object} job Job object
   * @param {Object} wsAdapter WebSocket-like adapter
   * @returns {Promise<Object>} Result
   */
  async handleDatabaseCreation(job, wsAdapter) {
    try {
      // Log start of database creation
      await queueService.publishLog({
        jobId: job.id,
        content: `Starting creation of database ${job.parameters.dbName}`,
        timestamp: new Date().toISOString(),
      });

      // Convert job parameters to the format expected by the database controller
      const payload = {
        installationId: job.id,
        dbType: job.parameters.dbType,
        operation: "create",
        dbName: job.parameters.dbName,
        username: job.parameters.username,
        password: job.parameters.password,
      };

      // Use the existing database controller to handle the creation
      await databaseController.createDatabase(payload, wsAdapter);

      return { success: true };
    } catch (error) {
      logger.error(`Error handling database creation job: ${error.message}`);
      throw error;
    }
  }

  /**
   * Handle firewall configuration job
   * @param {Object} job Job object
   * @param {Object} wsAdapter WebSocket-like adapter
   * @returns {Promise<Object>} Result
   */
  async handleFirewallConfiguration(job, wsAdapter) {
    await queueService.publishLog({
      jobId: job.id,
      content: `Starting firewall configuration with ${job.parameters.rules.length} rules`,
      timestamp: new Date().toISOString(),
    });

    // Not yet implemented - this is a placeholder for future implementation
    throw new Error("Firewall configuration is not yet implemented");
  }

  /**
   * Handle service installation job
   * @param {Object} job Job object
   * @param {Object} wsAdapter WebSocket-like adapter
   * @returns {Promise<Object>} Result
   */
  async handleServiceInstallation(job, wsAdapter) {
    await queueService.publishLog({
      jobId: job.id,
      content: `Starting installation of ${job.parameters.serviceType} service`,
      timestamp: new Date().toISOString(),
    });

    // Not yet implemented - this is a placeholder for future implementation
    throw new Error("Service installation is not yet implemented");
  }

  /**
   * Handle database backup job
   * @param {Object} job Job object
   * @param {Object} wsAdapter WebSocket-like adapter
   * @returns {Promise<Object>} Result
   */
  async handleDatabaseBackup(job, wsAdapter) {
    try {
      // Log start of database backup
      await queueService.publishLog({
        jobId: job.id,
        content: `Starting backup of database ${job.parameters.dbName} (${job.parameters.dbType})`,
        timestamp: new Date().toISOString(),
      });

      // Convert job parameters to the format expected by the database controller
      const payload = {
        installationId: job.id,
        dbType: job.parameters.dbType,
        operation: "backup",
        dbName: job.parameters.dbName,
        backupPath: job.parameters.backupPath,
      };

      // Use the existing database controller to handle the backup
      await databaseController.handleDatabaseManagement(payload, wsAdapter);

      return { success: true };
    } catch (error) {
      logger.error(`Error handling database backup job: ${error.message}`);
      throw error;
    }
  }

  /**
   * Handle database restore job
   * @param {Object} job Job object
   * @param {Object} wsAdapter WebSocket-like adapter
   * @returns {Promise<Object>} Result
   */
  async handleDatabaseRestore(job, wsAdapter) {
    try {
      // Log start of database restore
      await queueService.publishLog({
        jobId: job.id,
        content: `Starting restoration of database ${job.parameters.dbName} (${job.parameters.dbType})`,
        timestamp: new Date().toISOString(),
      });

      // Convert job parameters to the format expected by the database controller
      const payload = {
        installationId: job.id,
        dbType: job.parameters.dbType,
        operation: "restore",
        dbName: job.parameters.dbName,
        backupPath: job.parameters.backupPath,
      };

      // Use the existing database controller to handle the restore
      await databaseController.handleDatabaseManagement(payload, wsAdapter);

      return { success: true };
    } catch (error) {
      logger.error(`Error handling database restore job: ${error.message}`);
      throw error;
    }
  }

  /**
   * Handle service restart job
   * @param {Object} job Job object
   * @param {Object} wsAdapter WebSocket-like adapter
   * @returns {Promise<Object>} Result
   */
  async handleServiceRestart(job, wsAdapter) {
    await queueService.publishLog({
      jobId: job.id,
      content: `Starting restart of service ${job.parameters.serviceName}`,
      timestamp: new Date().toISOString(),
    });

    // Not yet implemented - this is a placeholder for future implementation
    throw new Error("Service restart is not yet implemented");
  }
}

module.exports = new CommandHandler();
