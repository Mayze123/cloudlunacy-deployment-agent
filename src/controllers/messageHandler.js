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
    logger.info(`Received message of type: ${message.type}`);

    try {
      switch (message.type) {
        case "deploy_app":
          deployController.handleDeployApp(message, ws);
          break;

        case "create_database":
          databaseController.createDatabase(message.payload, ws);
          break;

        case "manage_database":
          databaseController.handleDatabaseManagement(message.payload, ws);
          break;

        case "check_repository":
          repositoryController.checkRepositoryAccess(message.payload, ws);
          break;

        default:
          this.handleUnknownMessageType(message, ws);
      }
    } catch (error) {
      this.handleMessageError(error, message, ws);
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
