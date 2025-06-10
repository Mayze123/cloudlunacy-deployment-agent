/**
 * CommandHandler
 *
 * Central logic for processing commands from both Queue and WebSocket sources.
 * Handles job distribution to appropriate controllers based on job type.
 */

const logger = require("../../utils/logger");
const deployController = require("./deployController");
const databaseController = require("./databaseController");
const repositoryController = require("./repositoryController");
const messageHandler = require("./messageHandler");
const queueService = require("../services/queueService");
const { ALL_JOB_TYPES, normalizeActionType } = require("../constants/jobTypes");
const ResponseFormatter = require("../utils/responseFormatter");

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
      logger.info("Initializing command handler...");
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
   * @param {Object} msg Raw AMQP message object (optional)
   * @param {Object} channel AMQP channel instance (optional)
   * @returns {Promise<Object>} Processing result
   */
  async processJob(job, msg = null, channel = null) {
    try {
      // Normalize the job object using standardized formatter
      const normalizedJob = ResponseFormatter.normalizeJob(job);

      // Log job details for debugging
      logger.info(
        `Received command: ${normalizedJob.actionType} (ID: ${normalizedJob.id})`,
      );
      logger.debug(`Job details: ${JSON.stringify(normalizedJob)}`);

      // Log RPC metadata if available
      if (msg && msg.properties) {
        if (msg.properties.replyTo) {
          logger.info(`Reply-to queue: ${msg.properties.replyTo}`);
        }
        if (msg.properties.correlationId) {
          logger.info(`Correlation ID: ${msg.properties.correlationId}`);
        }
      }

      // Normalize and determine job type
      let jobType = normalizeActionType(normalizedJob.actionType);

      // Handle special cases for list_services
      if (normalizedJob.actionType === "list_services") {
        jobType = ALL_JOB_TYPES.LIST_SERVICES;
      }

      if (!jobType) {
        throw new Error(
          "Job type/command not specified. Please ensure the message includes a 'jobType', 'type', 'command', or 'actionType' field.",
        );
      }

      // Create adapter and log start of processing
      const adapter = this.createQueueAdapter(normalizedJob.id);

      await this.logJobStart(normalizedJob.id, jobType);

      // Process the job based on its determined type
      const result = await this.routeJobToHandler(
        normalizedJob,
        jobType,
        adapter,
        msg,
        channel,
      );

      // Format the result using standardized formatter
      const formattedResult =
        result.success === false
          ? ResponseFormatter.error(
              normalizedJob.id,
              jobType,
              result.error || result.message,
              result.result || result.data,
            )
          : ResponseFormatter.success(
              normalizedJob.id,
              jobType,
              result.result || result.data,
              result.message,
            );

      // If this was an RPC request (has replyTo and correlationId) and it's not already
      // handled by the specific handler, send response here
      if (
        msg &&
        channel &&
        msg.properties &&
        msg.properties.replyTo &&
        msg.properties.correlationId &&
        jobType !== ALL_JOB_TYPES.LIST_SERVICES
      ) {
        try {
          const rpcResponse = ResponseFormatter.rpcResponse(
            msg.properties.correlationId,
            formattedResult,
          );

          channel.sendToQueue(
            msg.properties.replyTo,
            Buffer.from(JSON.stringify(rpcResponse)),
            { correlationId: msg.properties.correlationId },
          );
          logger.info(
            `Sent standardized RPC response to ${msg.properties.replyTo} with correlationId ${msg.properties.correlationId}`,
          );
        } catch (rpcError) {
          logger.error(`Failed to send RPC response: ${rpcError.message}`);
        }
      }

      return formattedResult;
    } catch (error) {
      logger.error(`Error processing job: ${error.message}`);

      // Create standardized error response
      const jobId = job?.id || job?.jobId || "unknown";
      const jobType = job?.actionType || job?.jobType || "unknown";
      const errorResponse = ResponseFormatter.error(jobId, jobType, error);

      // Try to publish error if we have a job ID
      if (jobId !== "unknown") {
        await this.publishJobFailure(jobId, error);
      }

      // Send RPC error response if applicable
      if (
        msg &&
        channel &&
        msg.properties &&
        msg.properties.replyTo &&
        msg.properties.correlationId
      ) {
        try {
          const rpcErrorResponse = ResponseFormatter.rpcResponse(
            msg.properties.correlationId,
            null,
            error,
          );

          channel.sendToQueue(
            msg.properties.replyTo,
            Buffer.from(JSON.stringify(rpcErrorResponse)),
            { correlationId: msg.properties.correlationId },
          );
        } catch (rpcError) {
          logger.error(
            `Failed to send RPC error response: ${rpcError.message}`,
          );
        }
      }

      return {
        success: false,
        error: error.message,
        jobId: job.id || job.jobId,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Determine the type of job from various properties (legacy method)
   * @param {Object} job The job object
   * @returns {string|null} The determined job type or null if undetermined
   * @deprecated Use normalizeActionType from constants instead
   */
  determineJobType(job) {
    // Try direct type definitions first
    let jobType = job.jobType || job.type || job.command || job.actionType;

    // Normalize using the standardized function
    if (jobType) {
      return normalizeActionType(jobType);
    }

    // Legacy inference logic for backwards compatibility
    if (job.operation) {
      // Infer from operation field
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
        jobType = ALL_JOB_TYPES.DEPLOY_APPLICATION;
      }
    } else if (job.databaseType || job.dbType) {
      // Infer from database-related fields
      jobType = ALL_JOB_TYPES.INSTALL_DATABASE;
    } else if (job.repositoryUrl || job.repoUrl) {
      // Infer from repository-related fields
      jobType = job.branch
        ? ALL_JOB_TYPES.CLONE_REPOSITORY
        : ALL_JOB_TYPES.UPDATE_REPOSITORY;
    } else if (job.parameters) {
      // Infer from parameters structure
      if (job.parameters.dbType) {
        jobType = ALL_JOB_TYPES.INSTALL_DATABASE;
      } else if (job.parameters.repositoryUrl) {
        jobType = ALL_JOB_TYPES.DEPLOY_APPLICATION;
      } else if (
        job.parameters.dbName &&
        job.parameters.username &&
        job.parameters.password
      ) {
        // Likely a database credential update
        jobType = ALL_JOB_TYPES.UPDATE_DATABASE_CREDENTIALS;
      }
    }

    return jobType || null;
  }

  /**
   * Log the start of job processing
   * @param {string} jobId The job ID
   * @param {string} jobType The job type
   * @returns {Promise<void>}
   */
  async logJobStart(jobId, jobType) {
    try {
      await queueService.publishLog({
        jobId: jobId,
        content: `Starting job ${jobId} (${jobType})`,
        timestamp: new Date().toISOString(),
      });

      await queueService.publishResult({
        jobId: jobId,
        status: "PROCESSING",
        result: {
          message: `Agent ${queueService.serverId || "unknown"} is processing the job`,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.warn(`Failed to log job start: ${error.message}`);
      // Continue processing even if logging fails
    }
  }

  /**
   * Publish job failure information
   * @param {string} jobId The job ID
   * @param {Error} error The error object
   * @returns {Promise<void>}
   */
  async publishJobFailure(jobId, error) {
    try {
      await queueService.publishResult({
        jobId: jobId,
        status: "FAILED",
        error: error.message,
      });

      await queueService.publishLog({
        jobId: jobId,
        content: `Job failed: ${error.message}`,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      logger.error(`Failed to publish job failure: ${e.message}`);
    }
  }

  /**
   * Route the job to the appropriate handler based on job type
   * @param {Object} job The job object
   * @param {string} jobType The job type
   * @param {Object} adapter Queue adapter for responses
   * @param {Object} msg Raw AMQP message (optional)
   * @param {Object} channel AMQP channel (optional)
   * @returns {Promise<Object>} Processing result
   */
  async routeJobToHandler(job, jobType, adapter, msg = null, channel = null) {
    switch (jobType) {
      // Deployment commands - standardized
      case ALL_JOB_TYPES.DEPLOY_APPLICATION:
        return await this.handleDeploymentJob(job, adapter);

      // System management
      case ALL_JOB_TYPES.LIST_SERVICES:
        return await this.handleListServicesJob(job, adapter, msg, channel);

      // Container log streaming
      case ALL_JOB_TYPES.STREAM_CONTAINER_LOGS:
        return await this.handleStreamContainerLogsJob(
          job,
          adapter,
          msg,
          channel,
        );

      case "stop_container_log_stream": // Special case - not in constants yet
        return await this.handleStopContainerLogStreamJob(
          job,
          adapter,
          msg,
          channel,
        );

      // Database commands - standardized
      case ALL_JOB_TYPES.INSTALL_DATABASE:
      case ALL_JOB_TYPES.CREATE_DATABASE:
      case ALL_JOB_TYPES.INSTALL_DATABASE_SYSTEM:
        return await this.handleDatabaseJob(job, adapter, "install");

      case ALL_JOB_TYPES.BACKUP_DATABASE:
        return await this.handleDatabaseJob(job, adapter, "backup");

      case ALL_JOB_TYPES.RESTORE_DATABASE:
        return await this.handleDatabaseJob(job, adapter, "restore");

      case ALL_JOB_TYPES.UPDATE_DATABASE_CREDENTIALS:
      case ALL_JOB_TYPES.UPDATE_MONGODB_CREDENTIALS:
        return await this.handleMongoCredentialsUpdateJob(job, adapter);

      // Repository/Git commands - standardized
      case ALL_JOB_TYPES.CLONE_REPOSITORY:
      case ALL_JOB_TYPES.UPDATE_REPOSITORY:
        return await this.handleRepositoryJob(job, adapter);

      // Handle other command types
      default:
        logger.warn(`Unknown job type: ${jobType}`);
        throw new Error(`Unsupported job type: ${jobType}`);
    }
  }

  /**
   * Create a WebSocket-like adapter for queue responses
   * @param {string} jobId The job ID
   * @returns {Object} WebSocket-like object
   */
  createQueueAdapter(jobId) {
    return {
      readyState: 1, // Simulating OPEN WebSocket state
      send: async (data) => {
        try {
          const message = JSON.parse(data);

          // Handle different message types
          switch (message.type) {
            case "status":
            case "deployment_status":
              // Handle deployment status updates
              let resultStatus = "PROCESSING";
              if (
                message.status === "success" ||
                message.status === "completed" ||
                message.success === true
              ) {
                resultStatus = "SUCCESS";
              } else if (
                message.status === "failed" ||
                message.status === "error" ||
                message.success === false
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
            case "database_installation_failed":
            case "database_operation_completed":
              // Handle database operation status
              await queueService.publishResult({
                jobId: jobId,
                status: message.success === false ? "FAILED" : "SUCCESS",
                result: message,
                error: message.error || null,
              });

              await queueService.publishLog({
                jobId: jobId,
                content: `Database operation ${message.success === false ? "failed" : "completed"}: ${JSON.stringify(message)}`,
                timestamp: new Date().toISOString(),
              });
              break;

            case "error":
              // Handle error messages
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

            case "log":
              // Send log message
              await queueService.publishLog({
                jobId: jobId,
                content:
                  message.content || message.message || JSON.stringify(message),
                level: message.level || "info",
                timestamp: message.timestamp || new Date().toISOString(),
              });
              break;

            default:
              // For other message types, publish as log
              await queueService.publishLog({
                jobId: jobId,
                content: `Agent message: ${JSON.stringify(message)}`,
                timestamp: new Date().toISOString(),
              });
          }
        } catch (error) {
          logger.error(
            `Error processing message in queue adapter: ${error.message}`,
          );

          // Try to publish error as log
          try {
            await queueService.publishLog({
              jobId: jobId,
              content: `Error processing message: ${error.message}`,
              timestamp: new Date().toISOString(),
            });

            // Also publish as result for visibility
            await queueService.publishResult({
              jobId: jobId,
              status: "FAILED",
              error: `Message processing error: ${error.message}`,
            });
          } catch (e) {
            logger.error(`Failed to publish error: ${e.message}`);
          }
        }
      },
    };
  }

  /**
   * Handle deployment related jobs
   * @param {Object} job The job object
   * @param {Object} adapter Queue adapter for responses
   * @returns {Promise<Object>} Result of the deployment job
   */
  async handleDeploymentJob(job, adapter) {
    try {
      logger.info(`Processing deployment job: ${job.id || job.jobId}`);

      if (job.parameters) {
        // Handle job in core format (with parameters object)
        await queueService.publishLog({
          jobId: job.id,
          content: `Starting deployment from ${job.parameters.repositoryUrl}`,
          timestamp: new Date().toISOString(),
        });

        // Generate a proper deploymentId from the job ID
        const jobId = job.id;
        const deploymentId = job.parameters.deploymentId;

        const message = {
          type: "deploy_app",
          requestId: jobId,
          payload: {
            deploymentId: deploymentId, // Use the properly formatted deploymentId
            jobId: jobId, // Keep track of the original jobId too
            appType: job.parameters.appType || "nodejs",
            repositoryUrl: job.parameters.repositoryUrl,
            branch: job.parameters.branch,
            githubToken: job.parameters.githubToken,
            environment: job.parameters.environment || "production",
            // Use serviceName directly or fall back to legacy appName field for backward compatibility
            serviceName: job.parameters.serviceName || job.parameters.appName,
            // Domain is optional - will be generated from serviceName if not provided
            domain: job.parameters.domain,
            envVarsToken: job.parameters.envVarsToken,
            // Flag to enable auto-detection of app type if needed
            autoDetectAppType: true,
          },
        };

        // Route to appropriate controller based on app type
        if (
          message.payload.appType?.toLowerCase() === "mongodb" ||
          message.payload.appType?.toLowerCase() === "mongo"
        ) {
          await databaseController.handleDatabaseDeployment(
            message.payload,
            adapter,
          );
        } else {
          await deployController.handleDeployApp(message, adapter);
        }
      } else {
        // Handle job in controller format (flat object)
        const deploymentParams = {
          repositoryUrl: job.repositoryUrl || job.repoUrl,
          branch: job.branch,
          deploymentId: job.deploymentId || job.id || job.jobId,
          projectName: job.projectName || job.name,
          environmentName:
            job.environmentName || job.environment || "production",
          configOptions: job.config || job.configOptions || {},
          forceRebuild: job.forceRebuild || false,
        };

        // Call deployment controller
        await deployController.deployApplication(deploymentParams, adapter);
      }

      return {
        success: true,
        jobId: job.id || job.jobId,
        message: "Deployment processed successfully",
        timestamp: new Date().toISOString(),
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
   * @param {Object} job The job object
   * @param {Object} adapter Queue adapter for responses
   * @param {string} [defaultOperation="install"] Default operation if not specified
   * @returns {Promise<Object>} Result of the database job
   */
  async handleDatabaseJob(job, adapter, defaultOperation = "install") {
    try {
      logger.info(`Processing database job: ${job.id || job.jobId}`);

      // Standardize the job structure based on known patterns
      let dbParams;

      // Check which format we're dealing with
      if (job.parameters) {
        // Core command handler format (parameters object)
        logger.info("Processing job in core format (parameters object)");
        dbParams = {
          operation: defaultOperation,
          dbType: job.parameters.dbType,
          dbName: job.parameters.dbName,
          username: job.parameters.username,
          password: job.parameters.password,
          options: job.parameters.options || {},
          installationId: job.id,
          backupPath: job.parameters.backupPath,
        };
      } else {
        // Controller format (flat object)
        logger.info("Processing job in controller format (flat object)");
        dbParams = {
          operation: job.operation || job.operationType || defaultOperation,
          dbType: job.databaseType || job.dbType,
          dbName: job.databaseName || job.name || job.dbName,
          username: job.credentials?.username || job.username,
          password: job.credentials?.password || job.password,
          options: job.options || {},
          installationId: job.id || job.jobId,
          backupPath: job.backupPath,
        };
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

      // Return success response since the handleDatabaseManagement communicates via the adapter
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
          operation: job.operation || defaultOperation,
          error: error.message,
        }),
      );

      throw error;
    }
  }

  /**
   * Handle repository related jobs
   * @param {Object} job The job object
   * @param {Object} adapter Queue adapter for responses
   * @returns {Promise<Object>} Result of the repository job
   */
  async handleRepositoryJob(job, adapter) {
    try {
      logger.info(`Processing repository job: ${job.id || job.jobId}`);

      // Map job parameters to repository controller format
      const repoParams = {
        operation:
          job.operation || (job.jobType === "repo_clone" ? "clone" : "pull"),
        repositoryUrl:
          job.parameters?.repositoryUrl || job.repositoryUrl || job.repoUrl,
        branch: job.parameters?.branch || job.branch,
        targetPath: job.parameters?.targetPath || job.targetPath || job.path,
        credentials: job.parameters?.credentials || job.credentials || {},
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
   * Handle service installation job
   * @param {Object} job The job object
   * @param {Object} adapter Queue adapter for responses
   * @returns {Promise<Object>} Result
   */
  async handleServiceInstallation(job, adapter) {
    try {
      await queueService.publishLog({
        jobId: job.id || job.jobId,
        content: `Starting installation of ${job.parameters?.serviceType || "unknown"} service`,
        timestamp: new Date().toISOString(),
      });

      // Not yet implemented - this is a placeholder for future implementation
      throw new Error("Service installation is not yet implemented");
    } catch (error) {
      logger.error(`Service installation job failed: ${error.message}`);

      // Send failure message via adapter
      adapter.send(
        JSON.stringify({
          type: "service_installation_failed",
          status: "failed",
          error: error.message,
        }),
      );

      throw error;
    }
  }

  /**
   * Handle service restart job
   * @param {Object} job The job object
   * @param {Object} adapter Queue adapter for responses
   * @returns {Promise<Object>} Result
   */
  async handleServiceRestart(job, adapter) {
    try {
      await queueService.publishLog({
        jobId: job.id || job.jobId,
        content: `Starting restart of service ${job.parameters?.serviceName || "unknown"}`,
        timestamp: new Date().toISOString(),
      });

      // Not yet implemented - this is a placeholder for future implementation
      throw new Error("Service restart is not yet implemented");
    } catch (error) {
      logger.error(`Service restart job failed: ${error.message}`);

      // Send failure message via adapter
      adapter.send(
        JSON.stringify({
          type: "service_restart_failed",
          status: "failed",
          error: error.message,
        }),
      );

      throw error;
    }
  }

  /**
   * Handle firewall configuration job
   * @param {Object} job The job object
   * @param {Object} adapter Queue adapter for responses
   * @returns {Promise<Object>} Result
   */
  async handleFirewallConfiguration(job, adapter) {
    try {
      await queueService.publishLog({
        jobId: job.id || job.jobId,
        content: `Starting firewall configuration with ${job.parameters?.rules?.length || 0} rules`,
        timestamp: new Date().toISOString(),
      });

      // Not yet implemented - this is a placeholder for future implementation
      throw new Error("Firewall configuration is not yet implemented");
    } catch (error) {
      logger.error(`Firewall configuration job failed: ${error.message}`);

      // Send failure message via adapter
      adapter.send(
        JSON.stringify({
          type: "firewall_configuration_failed",
          status: "failed",
          error: error.message,
        }),
      );

      throw error;
    }
  }

  /**
   * Handle list_services RPC request
   * @param {Object} job The job object
   * @param {Object} adapter Queue adapter for responses
   * @param {Object} msg Raw AMQP message
   * @param {Object} channel AMQP channel
   * @returns {Promise<Object>} Result of listing services
   */
  async handleListServicesJob(job, adapter, msg, channel) {
    try {
      logger.info(`Processing list_services request`);
      logger.info(`Incoming msg.properties:, ${JSON.stringify(msg)}`);
      if (
        !msg ||
        !channel ||
        !msg.properties ||
        !msg.properties.replyTo ||
        !msg.properties.correlationId
      ) {
        throw new Error("Missing RPC metadata (replyTo or correlationId)");
      }

      // Use child_process to run docker ps command
      const { exec } = require("child_process");

      // Update format to include container ID (added .ID at the beginning)
      const dockerCommand =
        'docker ps --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}"';

      exec(dockerCommand, async (error, stdout, stderr) => {
        if (error) {
          logger.error(`Error executing docker ps: ${error.message}`);

          // Send error response back on the replyTo queue
          channel.sendToQueue(
            msg.properties.replyTo,
            Buffer.from(
              JSON.stringify({
                success: false,
                error: `Failed to list containers: ${error.message}`,
                timestamp: new Date().toISOString(),
              }),
            ),
            { correlationId: msg.properties.correlationId },
          );

          return;
        }

        if (stderr) {
          logger.warn(`Docker command stderr: ${stderr}`);
        }

        // Parse the output to create an array of container objects with IDs
        const containers = stdout
          .trim()
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => {
            const [id, name, image, status] = line.split("|");
            return { id, name, image, status };
          });

        logger.info(`Found ${containers.length} running containers`);

        // Send the container list as response
        const response = {
          success: true,
          containers,
          count: containers.length,
          timestamp: new Date().toISOString(),
        };

        // Send response back to the replyTo queue with the correlationId
        channel.sendToQueue(
          msg.properties.replyTo,
          Buffer.from(JSON.stringify(response)),
          { correlationId: msg.properties.correlationId },
        );

        logger.info(
          `Sent container list to ${msg.properties.replyTo} with correlationId ${msg.properties.correlationId}`,
        );
      });

      // Return a success response to the agent's job processing system
      // Note: The actual RPC response is sent in the exec callback
      return {
        success: true,
        message: "list_services request is being processed",
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`list_services job failed: ${error.message}`);

      // Try to send RPC error response
      if (
        msg &&
        channel &&
        msg.properties &&
        msg.properties.replyTo &&
        msg.properties.correlationId
      ) {
        try {
          channel.sendToQueue(
            msg.properties.replyTo,
            Buffer.from(
              JSON.stringify({
                success: false,
                error: error.message,
                timestamp: new Date().toISOString(),
              }),
            ),
            { correlationId: msg.properties.correlationId },
          );
        } catch (rpcError) {
          logger.error(
            `Failed to send RPC error response: ${rpcError.message}`,
          );
        }
      }

      throw error;
    }
  }

  /**
   * Handle MongoDB credentials update job
   * @param {Object} job The job object
   * @param {Object} adapter Queue adapter for responses
   * @returns {Promise<Object>} Result of the credentials update
   */
  async handleMongoCredentialsUpdateJob(job, adapter) {
    try {
      logger.info(
        `Processing MongoDB credentials update job: ${job.id || job.jobId}`,
      );

      // Extract parameters
      const params = job.parameters || {};
      const jobId = job.id || job.jobId;

      // Log the start of the operation
      await queueService.publishLog({
        jobId: jobId,
        content: `Starting MongoDB credentials update for database: ${params.dbName}`,
        timestamp: new Date().toISOString(),
      });

      // Validate required parameters
      const requiredParams = [
        "databaseId",
        "dbName",
        "username",
        "password",
        "adminUser",
        "adminPassword",
      ];
      const missingParams = requiredParams.filter((param) => !params[param]);

      if (missingParams.length > 0) {
        throw new Error(
          `Missing required parameters: ${missingParams.join(", ")}`,
        );
      }

      // MongoDB connection configuration
      const { MongoClient } = require("mongodb");
      const port = params.port || 27017;
      const host = params.host || "localhost";
      const adminUri = `mongodb://${params.adminUser}:${encodeURIComponent(params.adminPassword)}@${host}:${port}/admin?directConnection=true`;

      logger.info(
        `Connecting to MongoDB as admin to update credentials for user ${params.username}`,
      );

      // Connect to MongoDB as admin
      const client = new MongoClient(adminUri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000,
      });

      await client.connect();

      // Execute user credential update commands
      try {
        const adminDb = client.db("admin");

        // Check if the user exists
        const users = await adminDb.command({
          usersInfo: { user: params.username, db: params.dbName },
        });
        const userExists = users.users && users.users.length > 0;

        if (userExists) {
          // Update existing user
          await adminDb.command({
            updateUser: params.username,
            pwd: params.password,
            roles: [
              { role: "readWrite", db: params.dbName },
              { role: "dbAdmin", db: params.dbName },
            ],
          });

          logger.info(
            `Successfully updated MongoDB user ${params.username} in database ${params.dbName}`,
          );
        } else {
          // Create new user
          await adminDb.command({
            createUser: params.username,
            pwd: params.password,
            roles: [
              { role: "readWrite", db: params.dbName },
              { role: "dbAdmin", db: params.dbName },
            ],
          });

          logger.info(
            `Created new MongoDB user ${params.username} in database ${params.dbName}`,
          );
        }

        // Send success message via adapter
        adapter.send(
          JSON.stringify({
            type: "database_operation_completed",
            operation: "update_mongodb_credentials",
            status: "success",
            success: true,
            message: `MongoDB user credentials updated successfully for ${params.username}`,
            dbName: params.dbName,
            databaseId: params.databaseId,
            timestamp: new Date().toISOString(),
          }),
        );

        return {
          success: true,
          jobId: jobId,
          message: `MongoDB credentials updated successfully for user ${params.username} in database ${params.dbName}`,
          timestamp: new Date().toISOString(),
        };
      } finally {
        // Close the MongoDB connection
        await client.close();
        logger.info("MongoDB connection closed");
      }
    } catch (error) {
      logger.error(`MongoDB credentials update job failed: ${error.message}`);

      // Send failure message via adapter
      adapter.send(
        JSON.stringify({
          type: "database_operation_failed",
          operation: "update_mongodb_credentials",
          status: "failed",
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        }),
      );

      throw error;
    }
  }

  /**
   * Handle stream_container_logs command
   * @param {Object} job The job object with container log streaming parameters
   * @param {Object} adapter Queue adapter for responses
   * @param {Object} msg Raw AMQP message
   * @param {Object} channel AMQP channel
   * @returns {Promise<Object>} Result of starting log stream
   */
  async handleStreamContainerLogsJob(job, adapter, msg, channel) {
    try {
      logger.info(
        `Processing stream_container_logs request for container ${job.containerId || job.parameters?.containerId}`,
      );

      // Import the containerLogService
      const containerLogService = require("../services/containerLogService");

      // Extract parameters - support both flat structure and parameters object
      const containerId = job.containerId || job.parameters?.containerId;
      const streamId = job.streamId || job.parameters?.streamId;
      const options = job.options || job.parameters?.options || {};

      // Use correlationId from the message for routing log chunks
      const correlationId = msg?.properties?.correlationId;

      // Validate required parameters
      if (!containerId) {
        throw new Error("Missing required parameter: containerId");
      }

      if (!streamId) {
        throw new Error("Missing required parameter: streamId");
      }

      if (!correlationId) {
        throw new Error("Missing correlationId from message properties");
      }

      logger.info(
        `Starting container log stream for ${containerId} with stream ID ${streamId}`,
      );

      // Start the log stream
      const result = await containerLogService.startContainerLogStream({
        containerId,
        streamId,
        correlationId,
        options,
      });

      // Send response if this was an RPC request
      if (msg && channel && msg.properties && msg.properties.replyTo) {
        channel.sendToQueue(
          msg.properties.replyTo,
          Buffer.from(JSON.stringify(result)),
          { correlationId: correlationId },
        );

        logger.info(
          `Sent log stream start response to ${msg.properties.replyTo}`,
        );
      }

      return result;
    } catch (error) {
      logger.error(`Failed to start container log stream: ${error.message}`);

      // Send error response if this was an RPC request
      if (
        msg &&
        channel &&
        msg.properties &&
        msg.properties.replyTo &&
        msg.properties.correlationId
      ) {
        try {
          channel.sendToQueue(
            msg.properties.replyTo,
            Buffer.from(
              JSON.stringify({
                success: false,
                error: error.message,
                timestamp: new Date().toISOString(),
              }),
            ),
            { correlationId: msg.properties.correlationId },
          );
        } catch (rpcError) {
          logger.error(
            `Failed to send RPC error response: ${rpcError.message}`,
          );
        }
      }

      throw error;
    }
  }

  /**
   * Handle stop_container_log_stream command
   * @param {Object} job The job object with stream ID to stop
   * @param {Object} adapter Queue adapter for responses
   * @param {Object} msg Raw AMQP message
   * @param {Object} channel AMQP channel
   * @returns {Promise<Object>} Result of stopping log stream
   */
  async handleStopContainerLogStreamJob(job, adapter, msg, channel) {
    try {
      // Extract parameters - support both flat structure and parameters object
      const streamId = job.streamId || job.parameters?.streamId;
      const reason =
        job.reason || job.parameters?.reason || "Stream stopped by request";

      // Use correlationId from the message for routing log chunks
      const correlationId = msg?.properties?.correlationId;

      // Validate required parameters
      if (!streamId) {
        throw new Error("Missing required parameter: streamId");
      }

      if (!correlationId) {
        throw new Error("Missing correlationId from message properties");
      }

      logger.info(
        `Processing stop_container_log_stream request for stream ID: ${streamId}`,
      );

      // Import the containerLogService
      const containerLogService = require("../services/containerLogService");

      // Stop the log stream
      const result = await containerLogService.stopContainerLogStream(
        streamId,
        correlationId,
        reason,
      );

      // Send response if this was an RPC request
      if (msg && channel && msg.properties && msg.properties.replyTo) {
        channel.sendToQueue(
          msg.properties.replyTo,
          Buffer.from(JSON.stringify(result)),
          { correlationId: correlationId },
        );

        logger.info(
          `Sent log stream stop response to ${msg.properties.replyTo}`,
        );
      }

      return result;
    } catch (error) {
      logger.error(`Failed to stop container log stream: ${error.message}`);

      // Send error response if this was an RPC request
      if (
        msg &&
        channel &&
        msg.properties &&
        msg.properties.replyTo &&
        msg.properties.correlationId
      ) {
        try {
          channel.sendToQueue(
            msg.properties.replyTo,
            Buffer.from(
              JSON.stringify({
                success: false,
                error: error.message,
                timestamp: new Date().toISOString(),
              }),
            ),
            { correlationId: msg.properties.correlationId },
          );
        } catch (rpcError) {
          logger.error(
            `Failed to send RPC error response: ${rpcError.message}`,
          );
        }
      }

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
}

module.exports = new CommandHandler();
