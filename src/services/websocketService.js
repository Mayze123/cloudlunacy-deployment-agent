/**
 * WebSocket Service
 *
 * Handles WebSocket connections and message processing.
 * Provides functions for sending messages to the backend.
 */

const WebSocket = require("ws");
const logger = require("../../utils/logger");
const config = require("../config");
const messageHandler = require("../controllers/messageHandler");

class WebSocketService {
  constructor() {
    this.ws = null;
    this.retryCount = 0;
    this.retryDelay = config.websocket.initialRetryDelay;
    this.pingInterval = null;
    this.pingTimeout = null;
    this.PING_INTERVAL = 30000; // 30 seconds
    this.PING_TIMEOUT = 5000; // 5 seconds
    // Store reference to authenticationService to avoid circular dependency
    this.authService = null;
    this.initialized = false;
  }

  /**
   * Initialize the WebSocket service
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      if (this.initialized) {
        return true;
      }

      logger.info("Initializing WebSocket service...");

      // Get a reference to the authentication service to avoid circular dependencies
      try {
        const authService = require("./authenticationService");
        this.setAuthService(authService);

        // Schedule the connection to be established after initialization
        // This allows other services to complete initialization first
        setImmediate(async () => {
          try {
            logger.info("Initiating WebSocket connection with backend...");
            await authService.authenticateAndConnect();
          } catch (connectError) {
            logger.error(
              `Error establishing WebSocket connection: ${connectError.message}`,
            );
          }
        });
      } catch (error) {
        logger.warn(`Could not load authentication service: ${error.message}`);
      }

      this.initialized = true;
      logger.info("WebSocket service initialized successfully");
      return true;
    } catch (error) {
      logger.error(`Failed to initialize WebSocket service: ${error.message}`);
      return false;
    }
  }

  /**
   * Shutdown the WebSocket service
   * @returns {Promise<boolean>} Success status
   */
  async shutdown() {
    try {
      // Clear intervals and timeouts
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }

      if (this.pingTimeout) {
        clearTimeout(this.pingTimeout);
        this.pingTimeout = null;
      }

      // Close the WebSocket connection if it exists
      if (this.ws) {
        if (this.ws.readyState === WebSocket.OPEN) {
          // Send a goodbye message
          this.sendMessage("goodbye", { reason: "Agent shutting down" });

          // Close the connection
          this.ws.close(1000, "Agent shutting down");
        } else if (this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.terminate();
        }

        this.ws = null;
      }

      this.initialized = false;
      logger.info("WebSocket service shut down successfully");
      return true;
    } catch (error) {
      logger.error(`Error shutting down WebSocket service: ${error.message}`);
      return false;
    }
  }

  /**
   * Set the auth service reference to avoid circular dependency
   * @param {Object} authService - Authentication service instance
   */
  setAuthService(authService) {
    this.authService = authService;
  }

  /**
   * Establishes a WebSocket connection with retry mechanism.
   * @param {string} wsUrl WebSocket URL.
   */
  establishConnection(wsUrl) {
    logger.info(`Attempting to establish WebSocket connection to: ${wsUrl}`);

    // Get the correct WebSocket token from authentication service
    let websocketToken = config.api.token; // Default fallback
    try {
      const authService = require("./authenticationService");
      websocketToken = authService.getWebSocketToken();
      logger.info("Using WebSocket token from authentication service");
    } catch (error) {
      logger.warn(
        "Could not get WebSocket token from auth service, using API token as fallback",
      );
    }

    this.ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${websocketToken}`,
      },
    });

    this.setupEventHandlers();
  }

  /**
   * Set up WebSocket event handlers.
   */
  setupEventHandlers() {
    this.ws.on("message", (data) => {
      try {
        const message = JSON.parse(data);
        messageHandler.handleMessage(message, this.ws);
      } catch (error) {
        logger.error("Failed to parse message:", error);
      }
    });

    this.ws.on("open", () => {
      logger.info("WebSocket connection established.");
      this.retryCount = 0;
      this.retryDelay = config.websocket.initialRetryDelay;

      // Log detailed connection information
      logger.info(`Connected to backend at ${this.ws.url}`);
      logger.info(`Connection ready state: ${this.ws.readyState}`);

      // Send registration message
      this.sendMessage("register", { serverId: config.serverId });
      logger.info(
        `Registration message sent for server ID: ${config.serverId}`,
      );

      // Setup ping/pong for connection health monitoring
      this.pingInterval = setInterval(() => {
        this.ws.ping();
        this.pingTimeout = setTimeout(() => {
          logger.warn("No pong received - closing connection");
          this.ws.terminate();
        }, this.PING_TIMEOUT);
      }, this.PING_INTERVAL);
    });

    this.ws.on("pong", () => clearTimeout(this.pingTimeout));

    this.ws.on("close", () => {
      this.handleConnectionClose();
    });

    this.ws.on("error", (error) => {
      logger.error("WebSocket error:", error);
      this.ws.close();
    });
  }

  /**
   * Handle WebSocket connection close.
   */
  handleConnectionClose() {
    logger.warn("WebSocket connection closed.");

    // Clear intervals and timeouts
    clearInterval(this.pingInterval);
    clearTimeout(this.pingTimeout);

    // Implement reconnect with exponential backoff
    if (this.retryCount < config.websocket.reconnectMaxRetries) {
      // Only log every few attempts to reduce noise
      if (this.retryCount === 0 || this.retryCount % 3 === 0) {
        logger.warn(
          `Reconnecting in ${this.retryDelay / 1000} seconds... (Attempt ${this.retryCount + 1}/${config.websocket.reconnectMaxRetries})`,
        );
      }

      setTimeout(() => {
        // If authService reference exists, use it directly
        if (this.authService) {
          this.authService.authenticateAndConnect();
        } else {
          // Otherwise, dynamically require to avoid circular dependency
          if (this.retryCount === 0 || this.retryCount % 3 === 0) {
            logger.info("No auth service reference set, loading dynamically");
          }
          try {
            const authService = require("./authenticationService");
            authService.authenticateAndConnect();
          } catch (error) {
            logger.error("Failed to load authenticationService:", error);
          }
        }
      }, this.retryDelay);

      this.retryCount++;
      this.retryDelay *= 2; // Exponential backoff
    } else {
      logger.error(
        "Maximum reconnect attempts reached. Please check the connection.",
      );
    }
  }

  /**
   * Check if the WebSocket is connected
   * @returns {boolean} True if WebSocket is connected
   */
  isConnected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Send a message to the backend.
   * @param {string} type Message type.
   * @param {Object} payload Message payload.
   */
  sendMessage(type, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.error("Cannot send message: WebSocket is not connected");
      return false;
    }

    try {
      this.ws.send(JSON.stringify({ type, ...payload }));
      return true;
    } catch (error) {
      logger.error(`Error sending message: ${error.message}`);
      return false;
    }
  }
}

module.exports = new WebSocketService();
