/**
 * Message Handler
 *
 * Processes incoming WebSocket messages and routes them
 * to the appropriate handlers.
 */

const logger = require("../../utils/logger");
const deployController = require("./deployController");
const databaseController = require("./databaseController");
const repositoryController = require("./repositoryController");

class MessageHandler {
  /**
   * Handle incoming messages from the backend.
   * @param {Object} message - The message object.
   * @param {WebSocket} ws - The WebSocket connection object.
   */
  handleMessage(message, ws) {
    // Log detailed message information for debugging
    try {
      const messagePayloadStr = JSON.stringify(message.payload || {});
      const truncatedPayload =
        messagePayloadStr.length > 500
          ? messagePayloadStr.substring(0, 500) + "..."
          : messagePayloadStr;

      logger.info(`Received message of type: ${message.type}`);
      logger.info(`Message ID: ${message.requestId || "none"}`);
      logger.info(`Message payload: ${truncatedPayload}`);
    } catch (error) {
      logger.error(`Error logging message details: ${error.message}`);
    }

    try {
      switch (message.type) {
        case "deploy_app":
          // Check if this is a database deployment
          if (
            message.payload &&
            ["mongodb", "mongo"].includes(
              message.payload.appType?.toLowerCase(),
            )
          ) {
            logger.info("Routing MongoDB deployment to database controller");
            databaseController.handleDatabaseDeployment(message.payload, ws);
          } else {
            // Regular application deployment
            logger.info(
              `Deploying application: ${message.payload?.appName || "unnamed"} (${message.payload?.appType || "unknown type"})`,
            );
            deployController.handleDeployApp(message, ws);
          }
          break;

        case "create_database":
          logger.info(
            `Creating database: ${message.payload?.dbName || "unnamed"} (${message.payload?.dbType || "unknown type"})`,
          );
          databaseController.createDatabase(message.payload, ws);
          break;

        case "manage_database":
          logger.info(
            `Managing database: ${message.payload?.dbName || "unnamed"}, Operation: ${message.payload?.operation || "unknown"}`,
          );
          databaseController.handleDatabaseManagement(message.payload, ws);
          break;

        case "install_database":
          logger.info(
            `Installing database: ${message.payload?.dbType || "unknown type"}`,
          );
          // Route to the appropriate handler
          databaseController.handleDatabaseManagement(
            {
              ...message.payload,
              operation: "install",
            },
            ws,
          );
          break;

        case "mongodb_status_check":
          logger.info(
            `Checking MongoDB status: ${message.payload?.dbName || "all databases"}`,
          );
          databaseController.checkMongoDBStatus(message.payload, ws);
          break;

        case "check_repository":
          logger.info(
            `Checking repository access: ${message.payload?.repositoryUrl || "unknown repository"}`,
          );
          repositoryController.checkRepositoryAccess(message.payload, ws);
          break;

        case "register_ack":
          this.handleRegistrationAcknowledgement(message, ws);
          break;

        default:
          this.handleUnknownMessageType(message, ws);
      }
    } catch (error) {
      this.handleMessageError(error, message, ws);
    }
  }

  /**
   * Handle registration acknowledgement from the backend.
   * @param {Object} message - The message object.
   * @param {WebSocket} ws - The WebSocket connection object.
   */
  handleRegistrationAcknowledgement(message, ws) {
    logger.info("Registration acknowledged by backend server");

    // If there are any specific actions needed upon registration confirmation,
    // they can be implemented here

    // Optionally send a confirmation back to the backend
    if (ws && ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: "register_ack_received",
          requestId: message.requestId || null,
        }),
      );
    }
  }

  /**
   * Handle unknown message types.
   * @param {Object} message - The message object.
   * @param {WebSocket} ws - The WebSocket connection object.
   */
  handleUnknownMessageType(message, ws) {
    logger.warn(`Unknown message type: ${message.type}`);

    // Notify backend about unsupported message type
    if (ws && ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: `Unsupported message type: ${message.type}`,
          requestId: message.requestId || null,
        }),
      );
    }
  }

  /**
   * Handle errors that occur during message processing.
   * @param {Error} error - The error that occurred.
   * @param {Object} message - The original message object.
   * @param {WebSocket} ws - The WebSocket connection object.
   */
  handleMessageError(error, message, ws) {
    logger.error(`Error processing message of type ${message.type}:`, error);

    // Send error message back to the backend
    if (ws && ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: error.message,
          requestId: message.requestId || null,
          messageType: message.type,
        }),
      );
    }
  }
}

module.exports = new MessageHandler();
