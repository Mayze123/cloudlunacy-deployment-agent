/**
 * CloudLunacy Deployment Agent
 *
 * Main entry point for the agent that manages deployment operations
 * and connects to the CloudLunacy infrastructure.
 */

const http = require("http");
const logger = require("../utils/logger");
const coreServices = require("./services/core");
const config = require("./config");
const fs = require("fs");
const path = require("path");

// Create necessary directories if they don't exist
function ensureDirectoriesExist() {
  const directories = [
    config.paths.base,
    config.paths.logs,
    config.paths.apps,
    config.paths.certs,
    config.paths.cache,
    config.paths.temp,
  ];

  for (const dir of directories) {
    if (!fs.existsSync(dir)) {
      logger.info(`Creating directory: ${dir}`);
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// Simple health check server
function startHealthServer() {
  try {
    const server = http.createServer((req, res) => {
      // Health check endpoint
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }),
        );
      }
      // MongoDB Compass connection string endpoint
      else if (req.url === "/api/mongodb/compass-connection") {
        // Import the MongoDB connection utility
        const mongoConnection = require("../utils/mongoConnection");

        // Generate connection string specifically for MongoDB Compass
        const connectionString = mongoConnection.getCompassConnectionString({
          username: config.database.mongodb.username || "admin",
          password: config.database.mongodb.password || "",
          database: "admin",
        });

        // Return the connection string as JSON
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(
          JSON.stringify({
            success: true,
            connection_string: connectionString,
            usage_info:
              "Use this connection string in MongoDB Compass to avoid SSL KEY_USAGE_BIT_INCORRECT errors",
            server_id: config.serverId,
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const port = process.env.HEALTH_PORT || 3006;
    server.listen(port, () => {
      logger.info(`Health check server running on port ${port}`);
      logger.info(
        `MongoDB Compass connection string available at: http://localhost:${port}/api/mongodb/compass-connection`,
      );
    });

    return server;
  } catch (error) {
    logger.error(`Failed to start health check server: ${error.message}`);
    return null;
  }
}

// Setup graceful shutdown
function setupGracefulShutdown(healthServer) {
  const shutdown = async () => {
    logger.info("Shutting down CloudLunacy Deployment Agent...");

    // Shutdown health check server
    if (healthServer) {
      await new Promise((resolve) => healthServer.close(resolve));
      logger.info("Health check server shut down");
    }

    // Shutdown container log streams if they exist
    try {
      const containerLogService = require("./services/containerLogService");
      await containerLogService.shutdownAllStreams();
      logger.info("Container log streams shut down");
    } catch (error) {
      logger.warn(
        `Error shutting down container log streams: ${error.message}`,
      );
    }

    // Shutdown all core services
    await coreServices.shutdownServices();

    logger.info("CloudLunacy Deployment Agent shut down complete");
    process.exit(0);
  };

  // Graceful shutdown on SIGTERM and SIGINT
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Handle uncaught exceptions
  process.on("uncaughtException", (error) => {
    logger.error(`Uncaught exception: ${error.message}`, {
      stack: error.stack,
    });
    shutdown().catch((err) => {
      logger.error(
        `Error during shutdown after uncaught exception: ${err.message}`,
      );
      process.exit(1);
    });
  });

  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason, promise) => {
    logger.error(`Unhandled promise rejection: ${reason}`, { promise });
  });
}

/**
 * Initialize and start the CloudLunacy Deployment Agent
 */
async function main() {
  try {
    logger.info("Starting CloudLunacy Deployment Agent...");
    logger.info(`Environment: ${config.environment}`);
    logger.info(`Server ID: ${config.serverId}`);

    // Create necessary directories
    ensureDirectoriesExist();

    // Start health check server
    const healthServer = startHealthServer();

    // Setup graceful shutdown
    setupGracefulShutdown(healthServer);

    // Initialize core services
    const servicesInitialized = await coreServices.initializeServices();
    if (!servicesInitialized) {
      throw new Error("Failed to initialize core services");
    }

    logger.info("CloudLunacy Deployment Agent started successfully");
  } catch (error) {
    logger.error(
      `Failed to start CloudLunacy Deployment Agent: ${error.message}`,
    );
    process.exit(1);
  }
}

// Start the agent
main().catch((error) => {
  logger.error(`Fatal error: ${error.message}`, { stack: error.stack });
  process.exit(1);
});
