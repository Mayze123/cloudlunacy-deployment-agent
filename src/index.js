/**
 * CloudLunacy Deployment Agent
 * Main Entry Point
 *
 * This script is the entry point for the CloudLunacy Deployment Agent installed on a user's VPS.
 * It sets up the agent services, establishes connections with the backend,
 * and handles the initialization of all required modules.
 */

const logger = require("./utils/logger");
const config = require("./config");
const authService = require("./services/authenticationService");
const metricsService = require("./services/metricsService");
const databaseManager = require("./utils/databaseManager");
const { ensureDeploymentPermissions } = require("./utils/permissionCheck");
const express = require("express");

/**
 * Initialize MongoDB connection if needed
 * @returns {boolean} - Success status
 */
const initializeMongoDB = () => {
  // In the new architecture, MongoDB TLS termination is handled by HAProxy on the front server.
  logger.info(
    "MongoDB initialization: TLS verification is handled by HAProxy on the front server.",
  );
  return true;
};

/**
 * Initialize health check server
 * Allows the platform to determine if the agent is running
 */
const startHealthServer = () => {
  const app = express();
  const port = process.env.HEALTH_PORT || 8081;

  app.get("/health", (req, res) => {
    res.status(200).send({ status: "ok" });
  });

  app.listen(port, () => {
    logger.info(`Health check server listening on port ${port}`);
  });
};

/**
 * Main initialization function
 * Sets up the agent and connects to the backend
 */
async function init() {
  try {
    logger.info("Starting CloudLunacy Deployment Agent...");

    // Check if MongoDB initialization is needed
    if (
      process.env.MONGODB_ENABLED === "true" ||
      process.env.DATABASE_ENABLED === "true"
    ) {
      const mongoInitSuccess = initializeMongoDB();
      if (!mongoInitSuccess) {
        logger.error(
          "MongoDB initialization failed, but continuing agent startup...",
        );
      }
    }

    // Ensure deployment permissions
    await ensureDeploymentPermissions();

    // Start health check server
    startHealthServer();

    // Authenticate with backend and establish WebSocket connection
    await authService.authenticateAndConnect();

    // Start metrics collection
    metricsService.startMetricsCollection();

    logger.info("CloudLunacy Deployment Agent initialized successfully");
  } catch (error) {
    logger.error(`Initialization failed: ${error.message}`, error);
    process.exit(1);
  }
}

// Handle process termination gracefully
process.on("SIGINT", () => {
  logger.info("Received SIGINT signal. Shutting down gracefully...");
  metricsService.stopMetricsCollection();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM signal. Shutting down gracefully...");
  metricsService.stopMetricsCollection();
  process.exit(0);
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception:", error);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled promise rejection:", reason);
});

// Start the application
init();
