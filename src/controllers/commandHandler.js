/**
 * Command Handler
 *
 * Processes commands received via RabbitMQ or WebSocket.
 * Distributes commands to appropriate controllers based on command type.
 */

const logger = require("../../utils/logger");
const deployController = require("./deployController");
const databaseController = require("./databaseController");
const repositoryController = require("./repositoryController");
const messageHandler = require("./messageHandler");

/**
 * Process a job/command received from the queue
 * @param {Object} job - The job object from RabbitMQ
 * @returns {Promise<Object>} Result of processing the job
 */
async function processJob(job) {
  try {
    // Log fuller job details for debugging in case of malformed messages
    logger.info(
      `Received command: ${job.actionType || job.jobType || job.type || job.command || "unknown"}`,
    );
    logger.info(`Processing job: ${JSON.stringify(job)}`);

    // Extract key job information
    const jobId = job.id || job.jobId;

    // Try different fields that could contain the command type
    // Including actionType as used in core/commandHandler.js
    let jobType = job.jobType || job.type || job.command || job.actionType;

    // If still no job type, try to infer it from other properties
    if (!jobType) {
      if (job.operation) {
        // If it has an operation field, infer the type
        if (
          job.operation.startsWith("db_") ||
          job.operation.includes("database")
        ) {
          jobType = "database_" + job.operation.replace("db_", "");
        } else if (
          job.operation.startsWith("repo_") ||
          job.operation.includes("git")
        ) {
          jobType = "repo_" + job.operation.replace("repo_", "");
        } else if (job.operation.includes("deploy")) {
          jobType = "deployment";
        }
      } else if (job.databaseType || job.dbType) {
        // If it has database-related fields, assume it's a database job
        jobType = "database_install";
      } else if (job.repositoryUrl || job.repoUrl) {
        // If it has repo-related fields, assume it's a repo job
        jobType = job.branch ? "repo_clone" : "repo_pull";
      } else if (job.parameters && job.parameters.dbType) {
        // Support for parameters structure as in core/commandHandler.js
        jobType = "database_install";
        job.dbType = job.parameters.dbType;
      } else if (job.parameters && job.parameters.repositoryUrl) {
        // Support for parameters structure as in core/commandHandler.js
        jobType = "deployment";
        job.repositoryUrl = job.parameters.repositoryUrl;
      }
    }

    if (!jobType) {
      throw new Error(
        "Job type/command not specified. Please ensure the message includes a 'jobType', 'type', 'command', or 'actionType' field.",
      );
    }

    // Create a WebSocket-like adapter to reuse existing message handler code
    const queueMsgAdapter = createQueueMsgAdapter(jobId);

    // Process based on command type
    switch (jobType.toLowerCase()) {
      // Deployment commands
      case "deploy":
      case "deployment":
      case "deploy_app":
        return await handleDeploymentJob(job, queueMsgAdapter);

      // Database commands
      case "database_create":
      case "database_install":
      case "database_setup":
      case "install_database":
      case "create_database":
      case "backup_database":
      case "restore_database":
        return await handleDatabaseJob(job, queueMsgAdapter);

      // Repository/Git commands
      case "repo_clone":
      case "repo_pull":
        return await handleRepositoryJob(job, queueMsgAdapter);

      // Direct message processing (for backward compatibility)
      case "message":
        return await messageHandler.handleMessage(job.message, queueMsgAdapter);

      // Handle other command types
      default:
        logger.warn(`Unknown job type: ${jobType}`);
        throw new Error(`Unsupported job type: ${jobType}`);
    }
  } catch (error) {
    logger.error(`Error processing job: ${error.message}`);
    return {
      success: false,
      error: error.message,
      jobId: job.id || job.jobId,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Handle deployment related jobs
 * @param {Object} job - The job object
 * @param {Object} adapter - Queue message adapter (WebSocket-like)
 * @returns {Promise<Object>} Result of the deployment job
 */
async function handleDeploymentJob(job, adapter) {
  try {
    logger.info(`Processing deployment job: ${job.id || job.jobId}`);

    // Map job parameters to deployment controller format
    const deploymentParams = {
      repositoryUrl: job.repositoryUrl || job.repoUrl,
      branch: job.branch || "main",
      deploymentId: job.deploymentId || job.id || job.jobId,
      projectName: job.projectName || job.name,
      environmentName: job.environmentName || job.environment || "production",
      configOptions: job.config || job.configOptions || {},
      forceRebuild: job.forceRebuild || false,
    };

    // Call deployment controller
    const result = await deployController.deployApplication(
      deploymentParams,
      adapter,
    );
    return {
      success: result.success,
      deploymentId: deploymentParams.deploymentId,
      message: result.message || "Deployment processed",
      details: result,
    };
  } catch (error) {
    logger.error(`Deployment job failed: ${error.message}`);
    // Send failure message via adapter
    adapter.send(
      JSON.stringify({
        type: "deployment_status",
        status: "failed",
        error: error.message,
      }),
    );

    throw error;
  }
}

/**
 * Handle database related jobs
 * @param {Object} job - The job object from RabbitMQ
 * @param {Object} adapter - Queue message adapter (WebSocket-like)
 * @returns {Promise<Object>} Result of the database job
 */
async function handleDatabaseJob(job, adapter) {
  try {
    logger.info(`Processing database job: ${job.id || job.jobId}`);

    // Standardize the job structure based on known patterns
    let dbParams;

    // Check which format we're dealing with
    if (job.parameters) {
      // Core command handler format (parameters object)
      logger.info("Processing job in core format (parameters object)");
      dbParams = {
        operation:
          job.actionType === "install_database"
            ? "install"
            : job.parameters.operation || "install",
        dbType: job.parameters.dbType,
        dbName: job.parameters.dbName,
        username: job.parameters.username,
        password: job.parameters.password,
        options: job.parameters.options || {},
        installationId: job.id,
      };
    } else if (job.databaseType || job.dbType) {
      // Controller format (flat object)
      logger.info("Processing job in controller format (flat object)");
      dbParams = {
        operation: job.operation || job.operationType || "install",
        dbType: job.databaseType || job.dbType,
        dbName: job.databaseName || job.name,
        username: job.credentials?.username || job.username,
        password: job.credentials?.password || job.password,
        options: job.options || {},
        installationId: job.id || job.jobId,
      };
    } else {
      throw new Error(
        "Invalid database job format: Missing required parameters",
      );
    }

    // Validate required parameters
    const requiredParams = ["dbType", "dbName", "installationId"];
    const missingParams = requiredParams.filter((param) => !dbParams[param]);

    if (missingParams.length > 0) {
      throw new Error(
        `Missing required database parameters: ${missingParams.join(", ")}`,
      );
    }

    logger.info(
      `Database operation: ${dbParams.operation} on ${dbParams.dbType} database: ${dbParams.dbName}`,
    );

    // Handle database operation using handleDatabaseManagement
    await databaseController.handleDatabaseManagement(dbParams, adapter);

    // Return success response since the handleDatabaseManagement doesn't return a value
    // but communicates via the adapter
    return {
      success: true,
      jobId: job.id || job.jobId,
      message: `Database ${dbParams.operation} operation processed for ${dbParams.dbType} database: ${dbParams.dbName}`,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`Database job failed: ${error.message}`);
    // Send failure message via adapter
    adapter.send(
      JSON.stringify({
        type: "database_operation_failed",
        status: "failed",
        operation: job.operation || "unknown",
        error: error.message,
      }),
    );

    throw error;
  }
}

/**
 * Handle repository related jobs
 * @param {Object} job - The job object
 * @param {Object} adapter - Queue message adapter (WebSocket-like)
 * @returns {Promise<Object>} Result of the repository job
 */
async function handleRepositoryJob(job, adapter) {
  try {
    logger.info(`Processing repository job: ${job.id || job.jobId}`);

    // Map job parameters to repository controller format
    const repoParams = {
      operation:
        job.operation || (job.jobType === "repo_clone" ? "clone" : "pull"),
      repositoryUrl: job.repositoryUrl || job.repoUrl,
      branch: job.branch || "main",
      targetPath: job.targetPath || job.path,
      credentials: job.credentials || {},
    };

    // Call repository controller
    const result = await repositoryController.processRepositoryOperation(
      repoParams,
      adapter,
    );
    return {
      success: result.success,
      jobId: job.id || job.jobId,
      operation: repoParams.operation,
      message: result.message || "Repository operation processed",
      details: result,
    };
  } catch (error) {
    logger.error(`Repository job failed: ${error.message}`);
    // Send failure message via adapter
    adapter.send(
      JSON.stringify({
        type: "repo_operation_failed",
        status: "failed",
        operation: job.operation || "unknown",
        error: error.message,
      }),
    );

    throw error;
  }
}

/**
 * Create a WebSocket-like adapter for queue responses
 * This allows reusing code that expects a WebSocket connection
 * @param {string} jobId - The job ID to associate with messages
 * @returns {Object} WebSocket-like object
 */
function createQueueMsgAdapter(jobId) {
  // Get reference to queueService (importing here to avoid circular dependency)
  const queueService = require("../services/queueService");

  return {
    readyState: 1, // Simulating OPEN WebSocket state
    send: function (data) {
      try {
        // Parse the message
        const message = JSON.parse(data);

        // Handle different message types
        switch (message.type) {
          case "status":
          case "deployment_status":
          case "database_installed":
          case "database_installation_failed":
          case "database_operation_completed":
            // Publish result message
            queueService.publishResult({
              jobId: jobId,
              status:
                message.status === "success" ||
                message.status === "completed" ||
                message.success === true
                  ? "SUCCESS"
                  : message.status === "failed" || message.success === false
                    ? "FAILED"
                    : "PROCESSING",
              result: message,
              error: message.error || null,
            });
            break;

          case "error":
            // Handle error messages
            queueService.publishResult({
              jobId: jobId,
              status: "FAILED",
              error: message.error || "Unknown error",
            });
            break;

          case "log":
            // Send log message
            queueService.publishLog({
              jobId: jobId,
              content:
                message.content || message.message || JSON.stringify(message),
              level: message.level || "info",
              timestamp: message.timestamp || new Date().toISOString(),
            });
            break;

          default:
            // For other message types, publish as log
            queueService.publishLog({
              jobId: jobId,
              content: `Agent message: ${JSON.stringify(message)}`,
              timestamp: new Date().toISOString(),
            });
        }
      } catch (error) {
        logger.error(
          `Error processing message in queue adapter: ${error.message}`,
        );
        // Try to publish error as result
        try {
          const queueService = require("../services/queueService");
          queueService.publishResult({
            jobId: jobId,
            status: "FAILED",
            error: `Message processing error: ${error.message}`,
          });
        } catch (e) {
          logger.error(`Failed to publish error result: ${e.message}`);
        }
      }
    },
  };
}

/**
 * Initialize the command handler
 * @returns {Promise<boolean>} Success status
 */
async function initialize() {
  try {
    logger.info("Initializing command handler...");

    // Nothing complex to initialize at the moment
    // In the future, this could set up event listeners, pre-load modules, etc.

    logger.info("Command handler initialized successfully");
    return true;
  } catch (error) {
    logger.error(`Failed to initialize command handler: ${error.message}`);
    return false;
  }
}

module.exports = {
  processJob,
  handleDeploymentJob,
  handleDatabaseJob,
  handleRepositoryJob,
  initialize,
};
