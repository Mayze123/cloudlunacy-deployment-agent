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
      // Log job details for debugging
      logger.info(
        `Received command: ${job.actionType || job.jobType || job.type || job.command || "unknown"}`,
      );
      logger.debug(`Job details: ${JSON.stringify(job)}`);

      // Log RPC metadata if available
      if (msg && msg.properties) {
        if (msg.properties.replyTo) {
          logger.info(`Reply-to queue: ${msg.properties.replyTo}`);
        }
        if (msg.properties.correlationId) {
          logger.info(`Correlation ID: ${msg.properties.correlationId}`);
        }
      }

      // Extract key job information
      const jobId = job.id || job.jobId;

      // Determine job type through various methods
      let jobType = this.determineJobType(job);

      // Check for "list_services" special case
      if (job.actionType === "list_services") {
        jobType = "list_services";
      }

      if (!jobType) {
        throw new Error(
          "Job type/command not specified. Please ensure the message includes a 'jobType', 'type', 'command', or 'actionType' field.",
        );
      }

      // Create adapter and log start of processing
      const adapter = this.createQueueAdapter(jobId);

      await this.logJobStart(jobId, jobType);

      // Process the job based on its determined type
      const result = await this.routeJobToHandler(
        job,
        jobType,
        adapter,
        msg,
        channel,
      );

      // If this was an RPC request (has replyTo and correlationId) and it's not already
      // handled by the specific handler, send response here
      if (
        msg &&
        channel &&
        msg.properties &&
        msg.properties.replyTo &&
        msg.properties.correlationId &&
        jobType !== "list_services"
      ) {
        try {
          channel.sendToQueue(
            msg.properties.replyTo,
            Buffer.from(JSON.stringify(result)),
            { correlationId: msg.properties.correlationId },
          );
          logger.info(
            `Sent RPC response to ${msg.properties.replyTo} with correlationId ${msg.properties.correlationId}`,
          );
        } catch (rpcError) {
          logger.error(`Failed to send RPC response: ${rpcError.message}`);
        }
      }

      return result;
    } catch (error) {
      logger.error(`Error processing job: ${error.message}`);

      // Try to publish error if we have a job ID
      if (job.id || job.jobId) {
        const jobId = job.id || job.jobId;
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

      return {
        success: false,
        error: error.message,
        jobId: job.id || job.jobId,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Determine the type of job from various properties
   * @param {Object} job The job object
   * @returns {string|null} The determined job type or null if undetermined
   */
  determineJobType(job) {
    // Try direct type definitions first
    let jobType = job.jobType || job.type || job.command || job.actionType;

    // If job type isn't explicitly defined, try to infer it
    if (!jobType) {
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
          jobType = "deployment";
        }
      } else if (job.databaseType || job.dbType) {
        // Infer from database-related fields
        jobType = "database_install";
      } else if (job.repositoryUrl || job.repoUrl) {
        // Infer from repository-related fields
        jobType = job.branch ? "repo_clone" : "repo_pull";
      } else if (job.parameters) {
        // Infer from parameters structure
        if (job.parameters.dbType) {
          jobType = "database_install";
        } else if (job.parameters.repositoryUrl) {
          jobType = "deployment";
        }
      }
    }

    return jobType ? jobType.toLowerCase() : null;
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
      // Deployment commands
      case "deploy":
      case "deployment":
      case "deploy_app":
        return await this.handleDeploymentJob(job, adapter);

      // List services command (RPC)
      case "list_services":
        return await this.handleListServicesJob(job, adapter, msg, channel);

      // Database commands
      case "database_create":
      case "database_install":
      case "database_setup":
      case "install_database":
      case "create_database":
        return await this.handleDatabaseJob(job, adapter, "install");

      case "backup_database":
        return await this.handleDatabaseJob(job, adapter, "backup");

      case "restore_database":
        return await this.handleDatabaseJob(job, adapter, "restore");

      // Repository/Git commands
      case "repo_clone":
      case "repo_pull":
        return await this.handleRepositoryJob(job, adapter);

      // Service management
      case "service_installation":
      case "install_service":
        return await this.handleServiceInstallation(job, adapter);

      case "service_restart":
      case "restart_service":
        return await this.handleServiceRestart(job, adapter);

      // Firewall configuration
      case "configure_firewall":
      case "firewall_configure":
        return await this.handleFirewallConfiguration(job, adapter);

      // Direct message processing (for backward compatibility)
      case "message":
        return await messageHandler.handleMessage(job.message, adapter);

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

        const message = {
          type: "deploy_app",
          requestId: job.id,
          payload: {
            deploymentId: job.id,
            appType: job.parameters.appType || "nodejs",
            appName: job.parameters.appName,
            repositoryOwner: this.parseRepositoryOwner(
              job.parameters.repositoryUrl,
            ),
            repositoryName: this.parseRepositoryName(
              job.parameters.repositoryUrl,
            ),
            repositoryUrl: job.parameters.repositoryUrl,
            branch: job.parameters.branch || "main",
            githubToken: job.parameters.githubToken,
            environment: job.parameters.environment || "production",
            serviceName: job.parameters.appName,
            domain: job.parameters.domain,
            envVarsToken: job.parameters.envVarsToken,
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
          branch: job.branch || "main",
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
        branch: job.parameters?.branch || job.branch || "main",
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

      // Execute docker ps with custom format to get container name, image, and status
      const dockerCommand =
        'docker ps --format "{{.Names}}|{{.Image}}|{{.Status}}"';

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

        // Parse the output to create an array of container objects
        const containers = stdout
          .trim()
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => {
            const [name, image, status] = line.split("|");
            return { name, image, status };
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
