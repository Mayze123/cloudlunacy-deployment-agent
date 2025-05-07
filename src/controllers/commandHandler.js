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
    logger.info(
      `Processing job: ${JSON.stringify({
        id: job.id || job.jobId,
        type: job.jobType || job.type || job.command,
        serverId: job.serverId,
      })}`,
    );

    // Extract key job information
    const jobId = job.id || job.jobId;
    const jobType = job.jobType || job.type || job.command;

    if (!jobType) {
      throw new Error("Job type/command not specified");
    }

    // Create a WebSocket-like adapter to reuse existing message handler code
    const queueMsgAdapter = createQueueMsgAdapter(jobId);

    // Process based on command type
    switch (jobType.toLowerCase()) {
      // Deployment commands
      case "deploy":
      case "deployment":
        return await handleDeploymentJob(job, queueMsgAdapter);

      // Database commands
      case "database_create":
      case "database_install":
      case "database_setup":
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
 * @param {Object} job - The job object
 * @param {Object} adapter - Queue message adapter (WebSocket-like)
 * @returns {Promise<Object>} Result of the database job
 */
async function handleDatabaseJob(job, adapter) {
  try {
    logger.info(`Processing database job: ${job.id || job.jobId}`);

    // Map job parameters to database controller format
    const dbParams = {
      operationType: job.operation || job.operationType || "install",
      databaseType: job.databaseType || "mongodb",
      version: job.version || "latest",
      name: job.databaseName || job.name,
      credentials: job.credentials || {},
      options: job.options || {},
    };

    // Call database controller based on operation type
    let result;
    switch (dbParams.operationType.toLowerCase()) {
      case "install":
      case "setup":
        result = await databaseController.setupDatabase(dbParams, adapter);
        break;

      case "backup":
        result = await databaseController.backupDatabase(dbParams, adapter);
        break;

      case "restore":
        result = await databaseController.restoreDatabase(dbParams, adapter);
        break;

      default:
        throw new Error(
          `Unsupported database operation: ${dbParams.operationType}`,
        );
    }

    return {
      success: result.success,
      jobId: job.id || job.jobId,
      message: result.message || "Database operation processed",
      details: result,
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

module.exports = {
  processJob,
  handleDeploymentJob,
  handleDatabaseJob,
  handleRepositoryJob,
};
