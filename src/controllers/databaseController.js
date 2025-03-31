/**
 * Database Controller
 *
 * Handles database creation and management operations.
 */

const logger = require("../../utils/logger");
const databaseManager = require("../../utils/databaseManager");
const config = require("../config");
const mongodbService = require("../services/mongodbService");

class DatabaseController {
  /**
   * Create a new database instance
   * @param {Object} payload - Database creation payload
   * @param {WebSocket} ws - WebSocket connection to respond on
   */
  async createDatabase(payload, ws) {
    try {
      logger.info(`Creating ${payload.dbType} database: ${payload.dbName}`);

      // Validate payload
      this.validateCreateDatabasePayload(payload);

      // Prepare options for database creation
      const options = {
        username: payload.username,
        password: payload.password,
        port: payload.port,
        authEnabled: payload.authEnabled !== false, // Default to true
        useTls: payload.useTls !== false, // Default to true
      };

      // Create the database
      const result = await databaseManager.handleDatabaseOperation(
        "install",
        payload.dbType,
        options,
      );

      // If creation failed, throw an error
      if (!result.success) {
        throw new Error(result.message || "Database creation failed");
      }

      // Register with front server if enabled
      if (payload.registerProxy && config.api.frontApiUrl) {
        const registrationResult =
          await databaseManager.registerWithFrontServer(
            payload.dbType,
            config.serverId, // Use agent ID from config
            payload.hostname || "localhost",
            payload.port,
            {
              useTls: true, // Always enable TLS with HAProxy Data Plane API
            },
            config.api.jwt,
          );

        if (!registrationResult.success) {
          logger.warn(
            `Database created but front server registration failed: ${registrationResult.message}`,
          );
          result.frontServerWarning = registrationResult.message;
        } else {
          result.domain = registrationResult.domain;
          result.useTls = registrationResult.useTls;
          logger.info(
            `Database registered successfully with domain: ${result.domain}`,
          );
        }
      }

      // Send success response
      this.sendResponse(ws, {
        type: "database_created",
        success: true,
        databaseId: payload.databaseId,
        result: {
          ...result,
          dbType: payload.dbType,
          dbName: payload.dbName,
        },
      });
    } catch (error) {
      logger.error(`Database creation failed: ${error.message}`);
      this.sendResponse(ws, {
        type: "database_error",
        success: false,
        error: error.message,
        databaseId: payload.databaseId,
      });
    }
  }

  /**
   * Handle database management operations
   * @param {Object} payload - Database management payload
   * @param {WebSocket} ws - WebSocket connection to respond on
   */
  async handleDatabaseManagement(payload, ws) {
    try {
      const { operation, dbType, dbName } = payload;
      logger.info(
        `Executing ${operation} operation on ${dbType} database: ${dbName}`,
      );

      // Validate payload
      this.validateDatabaseManagementPayload(payload);

      // Define operation mapping
      const operationMap = {
        status: "status",
        create_user: "createUser",
        delete_user: "deleteUser",
        uninstall: "uninstall",
        backup: "backup",
        restore: "restore",
      };

      // Check if operation is supported
      if (!operationMap[operation]) {
        throw new Error(`Unsupported database operation: ${operation}`);
      }

      // Prepare options based on operation type
      const options = {
        ...payload,
        dbName: payload.database || payload.dbName,
      };

      let result;

      // Handle different types of operations
      if (operation === "status" || operation === "uninstall") {
        // These operations use the database manager's handleDatabaseOperation
        result = await databaseManager.handleDatabaseOperation(
          operation === "uninstall" ? "uninstall" : "status",
          dbType,
          options,
        );
      } else if (operation === "create_user" || operation === "delete_user") {
        // These operations use specific user management functions
        const managerOperation =
          operation === "create_user" ? "createUser" : "deleteUser";
        result =
          await databaseManager.supportedDatabases[dbType].manager[
            managerOperation
          ](options);
      } else {
        // Backup and restore operations
        const managerOperation = operation;
        result =
          await databaseManager.supportedDatabases[dbType].manager[
            managerOperation
          ](options);
      }

      // If operation failed, throw an error
      if (!result.success) {
        throw new Error(
          result.message || `Database ${operation} operation failed`,
        );
      }

      // Send success response
      this.sendResponse(ws, {
        type: "database_operation_completed",
        success: true,
        operation,
        dbType,
        dbName,
        result,
      });
    } catch (error) {
      logger.error(`Database operation failed: ${error.message}`);
      this.sendResponse(ws, {
        type: "database_error",
        success: false,
        operation: payload.operation,
        error: error.message,
        dbType: payload.dbType,
        dbName: payload.dbName,
      });
    }
  }

  /**
   * Validate database creation payload
   * @param {Object} payload - Database creation payload
   * @throws {Error} If validation fails
   */
  validateCreateDatabasePayload(payload) {
    const requiredFields = ["dbType", "dbName", "databaseId"];
    const missingFields = requiredFields.filter((field) => !payload[field]);

    if (missingFields.length > 0) {
      throw new Error(
        `Missing required database fields: ${missingFields.join(", ")}`,
      );
    }

    // Validate database type
    const supportedDbTypes = Object.keys(databaseManager.supportedDatabases);
    if (!supportedDbTypes.includes(payload.dbType)) {
      throw new Error(
        `Unsupported database type: ${payload.dbType}. Supported types: ${supportedDbTypes.join(", ")}`,
      );
    }
  }

  /**
   * Validate database management payload
   * @param {Object} payload - Database management payload
   * @throws {Error} If validation fails
   */
  validateDatabaseManagementPayload(payload) {
    const requiredFields = ["operation", "dbType"];
    const missingFields = requiredFields.filter((field) => !payload[field]);

    if (missingFields.length > 0) {
      throw new Error(
        `Missing required database management fields: ${missingFields.join(", ")}`,
      );
    }

    // dbName or database is required
    if (!payload.dbName && !payload.database) {
      throw new Error("Either dbName or database field is required");
    }

    // Validate database type
    const supportedDbTypes = Object.keys(databaseManager.supportedDatabases);
    if (!supportedDbTypes.includes(payload.dbType)) {
      throw new Error(
        `Unsupported database type: ${payload.dbType}. Supported types: ${supportedDbTypes.join(", ")}`,
      );
    }

    // Validate operation
    const supportedOperations = [
      "status",
      "create_user",
      "delete_user",
      "uninstall",
      "backup",
      "restore",
    ];
    if (!supportedOperations.includes(payload.operation)) {
      throw new Error(
        `Unsupported operation: ${payload.operation}. Supported operations: ${supportedOperations.join(", ")}`,
      );
    }
  }

  /**
   * Send a response over the WebSocket
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} data - Response data
   */
  sendResponse(ws, data) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    } else {
      logger.warn("Unable to send response: WebSocket not connected");
    }
  }

  /**
   * Handle database deployment requests that come through the deployment message channel
   * This maintains backward compatibility with clients that use the deploy message type
   * @param {Object} payload - Deployment payload
   * @param {WebSocket} ws - WebSocket connection to respond on
   */
  async handleDatabaseDeployment(payload, ws) {
    try {
      const { deploymentId, appType, serviceName } = payload;

      logger.info(`Handling ${appType} deployment with ID: ${deploymentId}`);

      // Send initial status
      this.sendResponse(ws, {
        type: "status",
        payload: {
          deploymentId,
          status: "started",
          message: `Starting ${appType} deployment`,
          timestamp: new Date().toISOString(),
        },
      });

      // Convert deployment payload to database creation payload
      const dbPayload = {
        databaseId: deploymentId,
        dbType:
          appType.toLowerCase() === "mongo" ? "mongodb" : appType.toLowerCase(),
        dbName: serviceName,
        port: payload.port || 27017, // Default MongoDB port
        username: payload.username,
        password: payload.password,
        hostname: payload.hostname || "localhost",
        registerProxy: true,
        authEnabled: payload.authEnabled !== false,
      };

      // Handle specific database type
      if (dbPayload.dbType === "mongodb") {
        const result = await this.handleMongoDBDeployment(dbPayload);

        if (result.success) {
          this.sendResponse(ws, {
            type: "status",
            payload: {
              deploymentId,
              status: "success",
              message: "MongoDB deployment completed successfully",
              domain: result.domain,
              timestamp: new Date().toISOString(),
            },
          });
        } else {
          throw new Error(result.message || "MongoDB deployment failed");
        }
      } else {
        throw new Error(`Unsupported database type: ${dbPayload.dbType}`);
      }
    } catch (error) {
      logger.error(`Database deployment failed: ${error.message}`);
      this.sendResponse(ws, {
        type: "error",
        payload: {
          deploymentId: payload.deploymentId,
          status: "failed",
          message: error.message,
          timestamp: new Date().toISOString(),
        },
      });
    }
  }

  /**
   * Handle MongoDB-specific deployment logic
   * @param {Object} dbPayload - Database payload
   * @returns {Promise<Object>} Deployment result
   */
  async handleMongoDBDeployment(dbPayload) {
    try {
      // Use the dedicated MongoDB service for deployments
      const result = await mongodbService.deployMongoDB({
        port: dbPayload.port,
        username: dbPayload.username,
        password: dbPayload.password,
        authEnabled: dbPayload.authEnabled,
        dbName: dbPayload.dbName,
      });

      return result;
    } catch (error) {
      logger.error(`MongoDB deployment failed: ${error.message}`);
      return {
        success: false,
        message: `MongoDB deployment failed: ${error.message}`,
      };
    }
  }
}

module.exports = new DatabaseController();
