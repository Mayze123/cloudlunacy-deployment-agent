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

    // Step 2: Initialize authentication service and login
    const authInitialized = await authService.initialize();
    if (!authInitialized) {
      throw new Error("Failed to initialize authentication service");
    }

    // Step 3: Initialize certificate service
    const certInitialized = await certificateService.initialize();
    if (!certInitialized) {
      throw new Error("Failed to initialize certificate service");
    }

    // Step 4: Initialize MongoDB service (if enabled)
    if (configService.get("database.mongodb.enabled")) {
      // Check if MongoDB database connections are really needed
      // This prevents unnecessary connection attempts at startup
      const skipConnectionAttempts =
        process.env.MONGO_SKIP_CONNECTION === "true" ||
        !process.env.MONGO_FORCE_CONNECT === "true";

      logger.info(
        `MongoDB connection attempts will ${skipConnectionAttempts ? "be skipped" : "be attempted"} at startup`,
      );

      const mongoInitialized = await mongodbService.initialize({
        skipConnectionAttempts: skipConnectionAttempts,
        registerWithFrontServer:
          process.env.MONGO_REGISTER_WITH_FRONT === "true",
      });

      if (!mongoInitialized) {
        logger.warn(
          "MongoDB service initialization failed, continuing without MongoDB",
        );
      }
    }

    // Step 5: Initialize deployment service
    const deploymentInitialized = await deploymentService.initialize();
    if (!deploymentInitialized) {
      throw new Error("Failed to initialize deployment service");
    }

    // Step 6: Initialize WebSocket service
    const websocketInitialized = await websocketService.initialize();
    if (!websocketInitialized) {
      throw new Error("Failed to initialize WebSocket service");
    }

    // Step 7: Initialize metrics service
    const metricsInitialized = await metricsService.initialize();
    if (!metricsInitialized) {
      logger.warn(
        "Metrics service initialization failed, continuing without metrics",
      );
    }

    logger.info("All core services initialized successfully");
    return true;
  } catch (error) {
    logger.error(`Core services initialization failed: ${error.message}`);
    return false;
  }
}

/**
 * Gracefully shutdown all services
 * @returns {Promise<boolean>} Success status
 */
async function shutdownServices() {
  try {
    logger.info("Shutting down core services...");

    // Shutdown in reverse order of initialization
    await metricsService.shutdown();
    await websocketService.shutdown();
    await deploymentService.shutdown();

    if (configService.get("database.mongodb.enabled")) {
      // MongoDB shutdown handled by the process exit handler
      logger.info("MongoDB will be shut down by the process exit handler");
    }

    logger.info("All core services shut down successfully");
    return true;
  } catch (error) {
    logger.error(`Error shutting down core services: ${error.message}`);
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
  },
};
