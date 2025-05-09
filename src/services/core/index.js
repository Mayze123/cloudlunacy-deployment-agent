/**
 * Core Services Orchestrator
 *
 * Central point for initializing and managing all core services.
 */

const logger = require("../../../utils/logger");
const configService = require("../configService");
const authService = require("../authenticationService");
const certificateService = require("../certificateService");
const deploymentService = require("../deploymentService");
const websocketService = require("../websocketService");
const metricsService = require("../metricsService");
const mongodbService = require("../mongodbService");
const queueService = require("../queueService");
const commandHandler = require("../../core/commandHandler");

/**
 * Initialize all core services
 * @returns {Promise<boolean>} Success status
 */
async function initializeServices() {
  try {
    logger.info("Initializing core services...");

    // Step 1: Initialize configuration service
    const configInitialized = await configService.initialize();
    if (!configInitialized) {
      throw new Error("Failed to initialize configuration service");
    }

    // Step 2: Initialize certificate service
    const certInitialized = await certificateService.initialize();
    if (!certInitialized) {
      logger.warn(
        "Certificate service initialization failed, continuing without certificates",
      );
    }

    // Step 3: Initialize command handler
    const commandHandlerInitialized = await commandHandler.initialize();
    if (!commandHandlerInitialized) {
      logger.warn(
        "Command handler initialization failed, continuing with limited functionality",
      );
    }

    // Step 4: Initialize authentication service and WebSocket fallback
    const authInitialized = await authService.initialize();
    if (!authInitialized) {
      logger.warn(
        "Authentication service initialization failed, continuing in limited mode",
      );
    }

    // Step 5: Initialize queue service
    const queueInitialized = await queueService.initialize();
    if (!queueInitialized) {
      logger.warn(
        "Queue service initialization failed, will attempt to use WebSocket fallback",
      );
    } else {
      // Start sending heartbeats
      queueService.startHeartbeats();

      // Setup command processor
      await setupCommandProcessor();
    }

    // Step 6: Initialize MongoDB service if it's enabled
    if (
      typeof configService.isMongoDBEnabled === "function" &&
      configService.isMongoDBEnabled()
    ) {
      // Skip connection attempts at startup if specified in config
      const skipConnectionAttempts = process.env.MONGO_SKIP_CONNECT === "true";

      // Always try to restart MongoDB if it's installed but not running
      const forceStartIfInstalled = true;

      logger.info(
        `MongoDB connection attempts will ${skipConnectionAttempts ? "be skipped" : "be attempted"} at startup`,
      );

      const mongoInitialized = await mongodbService.initialize({
        skipConnectionAttempts: skipConnectionAttempts,
        registerWithFrontServer:
          process.env.MONGO_REGISTER_WITH_FRONT === "true",
        forceStartIfInstalled: forceStartIfInstalled,
      });

      if (!mongoInitialized) {
        logger.warn(
          "MongoDB service initialization failed, continuing without MongoDB",
        );
      }
    } else if (
      typeof configService.get === "function" &&
      configService.get("database.mongodb.enabled")
    ) {
      // Alternative way to check if MongoDB is enabled
      logger.info("MongoDB is enabled, initializing service...");

      const mongoInitialized = await mongodbService.initialize({
        skipConnectionAttempts: process.env.MONGO_SKIP_CONNECT === "true",
        registerWithFrontServer:
          process.env.MONGO_REGISTER_WITH_FRONT === "true",
        forceStartIfInstalled: true,
      });

      if (!mongoInitialized) {
        logger.warn(
          "MongoDB service initialization failed, continuing without MongoDB",
        );
      }
    } else {
      logger.info("MongoDB is not enabled, skipping initialization");
    }

    // Step 7: Initialize deployment service
    const deploymentInitialized = await deploymentService.initialize();
    if (!deploymentInitialized) {
      throw new Error("Failed to initialize deployment service");
    }

    // Step 8: Initialize WebSocket service for fallback
    const websocketInitialized = await websocketService.initialize();
    if (!websocketInitialized && !queueInitialized) {
      throw new Error(
        "Failed to initialize both Queue and WebSocket services, cannot continue",
      );
    }

    // Step 9: Initialize metrics service
    const metricsInitialized = await metricsService.initialize();
    if (!metricsInitialized) {
      logger.warn(
        "Metrics service initialization failed, continuing without metrics",
      );
    }

    logger.info("Core services initialized successfully");
    return true;
  } catch (error) {
    logger.error(`Failed to initialize core services: ${error.message}`);
    return false;
  }
}

/**
 * Set up command processor to handle incoming RabbitMQ jobs
 */
async function setupCommandProcessor() {
  try {
    await queueService.consumeCommands(async (job) => {
      // Use the command handler to process the job
      return await commandHandler.processJob(job);
    });

    logger.info("Command processor successfully configured");
  } catch (error) {
    logger.error(`Failed to set up command processor: ${error.message}`);
    throw error;
  }
}

/**
 * Create a WebSocket-like adapter that sends messages to RabbitMQ
 * This allows us to reuse existing code that expects a WebSocket
 * @param {string} jobId The job ID
 * @returns {Object} A WebSocket-like object
 */
function createQueueWebSocketAdapter(jobId) {
  return {
    readyState: 1, // Simulate OPEN state
    send: function (data) {
      try {
        const message = JSON.parse(data);

        // Handle different message types
        switch (message.type) {
          case "status":
          case "deployment_status":
          case "database_installed":
          case "database_installation_failed":
          case "database_operation_completed":
            // Convert to a result message for the job
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

          default:
            // For any other message type, just log it
            queueService.publishLog({
              jobId: jobId,
              content: `Agent message: ${JSON.stringify(message)}`,
              timestamp: new Date().toISOString(),
            });
        }
      } catch (error) {
        logger.error(
          `Error processing WebSocket message in adapter: ${error.message}`,
        );
      }
    },
  };
}

/**
 * Gracefully shutdown all services
 * @returns {Promise<boolean>} Success status
 */
async function shutdownServices() {
  try {
    logger.info("Gracefully shutting down core services...");

    // Shutdown metrics service first (non-critical)
    await metricsService.shutdown();

    // Shutdown queue service
    await queueService.shutdown();

    // Shutdown WebSocket service
    await websocketService.shutdown();

    // Shutdown deployment service
    await deploymentService.shutdown();

    // Shutdown MongoDB service if it's enabled
    if (
      typeof configService.isMongoDBEnabled === "function" &&
      configService.isMongoDBEnabled()
    ) {
      await mongodbService.shutdown();
    } else if (
      typeof configService.get === "function" &&
      configService.get("database.mongodb.enabled")
    ) {
      await mongodbService.shutdown();
    }

    // Shutdown certificate service
    await certificateService.shutdown();

    // Shutdown authentication service
    await authService.shutdown();

    // Shutdown configuration service last
    await configService.shutdown();

    logger.info("All core services shut down successfully");
    return true;
  } catch (error) {
    logger.error(`Error during service shutdown: ${error.message}`);
    return false;
  }
}

module.exports = {
  initializeServices,
  shutdownServices,
  // Export individual services for direct access if needed
  services: {
    config: configService,
    auth: authService,
    certificate: certificateService,
    deployment: deploymentService,
    websocket: websocketService,
    metrics: metricsService,
    mongodb: mongodbService,
    queue: queueService,
    commandHandler: commandHandler,
  },
};
