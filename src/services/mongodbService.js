/**
 * MongoDB Service
 *
 * Handles MongoDB initialization and registration with the front server.
 * Uses Traefik for TLS termination and routing.
 */

const fs = require("fs").promises;
const path = require("path");
const axios = require("axios");
const logger = require("../../utils/logger");
const config = require("../config");
const mongoManager = require("../../utils/mongoManager");
const { getPublicIp } = require("../utils/networkUtils");

class MongoDBService {
  constructor() {
    this.initialized = false;
  }

  /**
   * Initialize the MongoDB service
   * @returns {Promise<boolean>} Success status
   */
  async initialize(options = {}) {
    try {
      if (this.initialized) {
        return true;
      }

      logger.info("Initializing MongoDB service...");

      // Check if MongoDB is enabled
      if (!config.database.mongodb.enabled) {
        logger.info(
          "MongoDB is not enabled in configuration, skipping initialization",
        );
        this.initialized = true; // Mark as initialized even though we're skipping
        return true;
      }

      // Check if we should skip connection attempts - this is a new option
      if (options.skipConnectionAttempts) {
        logger.info("Skipping MongoDB connection attempts as requested");
        this.initialized = true;
        return true;
      }

      // Check if MongoDB is actually installed/running - we'll check for the MongoDB process
      const isMongoRunning = await this.isMongoDBRunning();
      if (!isMongoRunning) {
        logger.info(
          "MongoDB does not appear to be running, skipping connection attempts",
        );
        this.initialized = true;
        return true;
      }

      // Initialize the MongoDB manager - but don't try to connect yet
      const initSuccess = await mongoManager.initialize({
        skipConnection: true,
      });
      if (!initSuccess) {
        throw new Error("Failed to initialize MongoDB manager");
      }

      // Register with front server only if explicitly enabled and we have the required config
      if (
        options.registerWithFrontServer &&
        config.api.frontApiUrl &&
        config.api.jwt
      ) {
        await this.registerWithFrontServer();
      } else {
        logger.info(
          "Skipping MongoDB registration with front server - not required for current operation",
        );
      }

      this.initialized = true;
      logger.info("MongoDB service initialized successfully");
      return true;
    } catch (error) {
      logger.error(`Failed to initialize MongoDB service: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if MongoDB is actually running
   * @returns {Promise<boolean>} Whether MongoDB is running
   */
  async isMongoDBRunning() {
    try {
      const { execSync } = require("child_process");
      // Try to detect if MongoDB is running using ps
      const output = execSync("ps aux | grep -v grep | grep mongod").toString();
      return output.includes("mongod");
    } catch (error) {
      // If command fails, MongoDB is likely not running
      logger.info("MongoDB process not detected on the system");
      return false;
    }
  }

  /**
   * Register MongoDB with the front server
   * @returns {Promise<boolean>} Success status
   */
  async registerWithFrontServer() {
    try {
      logger.info("Registering MongoDB with front server (Traefik)...");

      // Skip in development mode
      if (config.isDevelopment) {
        logger.info("Development mode: Using mock MongoDB registration");
        return true;
      }

      // Get the public IP address for registration
      const publicIp = await getPublicIp();

      // Use the MongoDB registration endpoint
      const response = await axios.post(
        `${config.api.frontApiUrl}/api/mongodb/register`,
        {
          agentId: config.serverId,
          targetIp: publicIp,
          targetPort: parseInt(config.database.mongodb.port, 10),
          useTls: true, // TLS is always enabled
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.api.jwt}`,
          },
        },
      );

      if (response.data && response.data.success) {
        logger.info(
          "MongoDB successfully registered with front server (Traefik)",
          {
            domain: response.data.domain,
            tlsEnabled: response.data.tlsEnabled,
            connectionString: response.data.connectionString,
          },
        );

        // Test the connection to confirm it's working
        try {
          const testConnection = await mongoManager.testConnection();
          if (testConnection.success) {
            logger.info(
              "MongoDB connection test successful after registration",
            );
          } else {
            logger.warn(
              `MongoDB connection test failed: ${testConnection.message}`,
            );
          }
        } catch (testErr) {
          logger.warn(`Error testing MongoDB connection: ${testErr.message}`);
        }

        return true;
      } else {
        logger.warn("Unexpected response when registering MongoDB", {
          response: response.data,
        });
        return false;
      }
    } catch (error) {
      logger.error(
        `Error registering MongoDB with front server: ${error.message}`,
      );
      if (error.response) {
        logger.error(
          `Response status: ${error.response.status}, data:`,
          error.response.data,
        );
      }
      return false;
    }
  }

  /**
   * Test the MongoDB connection
   * @returns {Promise<Object>} Test result
   */
  async testConnection() {
    return await mongoManager.testConnection();
  }

  /**
   * Get the MongoDB database instance
   * @returns {Promise<Object>} MongoDB database
   */
  async getDb() {
    return await mongoManager.getDb();
  }

  /**
   * Handle full MongoDB deployment process
   * @param {Object} options Deployment options
   * @returns {Promise<Object>} Deployment result
   */
  async deployMongoDB(options) {
    try {
      if (!this.initialized) {
        const initResult = await this.initialize();
        if (!initResult) {
          return {
            success: false,
            message: "Failed to initialize MongoDB service",
          };
        }
      }

      // Prepare MongoDB installation options
      const installOptions = {
        port: options.port || 27017,
        username: options.username,
        password: options.password,
        authEnabled: options.authEnabled !== false,
        useTls: true, // Always use TLS with Traefik
      };

      // Install MongoDB
      const installResult = await mongoManager.initialize();

      if (!installResult) {
        return {
          success: false,
          message: "Failed to initialize MongoDB",
        };
      }

      // Register with front server
      const registerResult = await this.registerWithFrontServer();

      if (!registerResult) {
        return {
          success: false,
          message: "Failed to register MongoDB with front server",
        };
      }

      // Test connection
      const testResult = await this.testConnection();

      return {
        success: true,
        message: "MongoDB deployment completed successfully",
        domain: `${config.serverId}.${config.database.mongodb.domain}`,
        connectionString: `mongodb://${config.database.mongodb.username}:***@${config.serverId}.${config.database.mongodb.domain}:27017/?tls=true`,
        connectionTest: testResult.success
          ? "Connection successful"
          : "Connection test failed",
      };
    } catch (error) {
      logger.error(`MongoDB deployment failed: ${error.message}`);
      return {
        success: false,
        message: `MongoDB deployment failed: ${error.message}`,
      };
    }
  }
}

module.exports = new MongoDBService();
