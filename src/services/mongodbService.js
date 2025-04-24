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
  async initialize() {
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
        return false;
      }

      // Initialize the MongoDB manager
      const initSuccess = await mongoManager.initialize();
      if (!initSuccess) {
        throw new Error("Failed to initialize MongoDB manager");
      }

      // Register with front server if we have the required config
      if (config.api.frontApiUrl && config.api.jwt) {
        await this.registerWithFrontServer();
      } else {
        logger.warn(
          "Missing front API URL or JWT, cannot register MongoDB with front server",
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
