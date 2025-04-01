/**
 * Authentication Service
 *
 * Handles authentication with the backend server.
 * Manages JWT tokens and websocket connections.
 */

const axios = require("axios");
const fs = require("fs").promises;
const logger = require("../../utils/logger");
const config = require("../config");
const websocketService = require("./websocketService");

class AuthenticationService {
  constructor() {
    this.initialized = false;
  }

  /**
   * Initialize the authentication service
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      if (this.initialized) {
        return true;
      }

      logger.info("Initializing authentication service...");

      // Check if we have a stored JWT token
      try {
        const jwtPath = config.paths.jwtFile;
        const jwtData = await fs.readFile(jwtPath, "utf8");
        const parsedData = JSON.parse(jwtData);

        if (parsedData && parsedData.token) {
          config.api.jwt = parsedData.token;
          process.env.AGENT_JWT = parsedData.token;
          logger.info(
            "Loaded JWT token from file (previously stored by install script)",
          );
        } else {
          logger.warn("JWT token file exists but contains no valid token");
        }
      } catch (readError) {
        logger.warn(`No JWT token file found: ${readError.message}`);
        logger.info(
          "JWT token should have been created by the installation script",
        );
        // This is not a critical error since we might be using a different auth mechanism
      }

      this.initialized = true;
      logger.info("Authentication service initialized successfully");
      return true;
    } catch (error) {
      logger.error(
        `Failed to initialize authentication service: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Authenticate with the backend and establish a WebSocket connection.
   */
  async authenticateAndConnect() {
    try {
      // In development mode, skip the actual authentication
      if (config.isDevelopment) {
        logger.info("Development mode: Skipping backend authentication");
        // Use a mock WebSocket URL for development that works with Docker
        const wsUrl = "ws://host.docker.internal:8080/agent";
        logger.info(`Using development WebSocket URL: ${wsUrl}`);
        websocketService.establishConnection(wsUrl);
        return;
      }

      logger.info("Authenticating with backend...");

      const response = await axios.post(
        `${config.api.backendUrl}/api/agent/authenticate`,
        {
          agentToken: config.api.token,
          serverId: config.serverId,
        },
        {
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      // Check if we received a JWT token in the response and store it
      if (response.data.jwt) {
        await this.storeJwtToken(response.data.jwt);
      }

      const { wsUrl } = response.data;
      if (!wsUrl) {
        throw new Error("WebSocket URL not provided by backend.");
      }

      logger.info(`WebSocket URL received: ${wsUrl}`);
      websocketService.establishConnection(wsUrl);
    } catch (error) {
      this.handleAuthenticationError(error);
    }
  }

  /**
   * Store JWT token to file for persistence.
   * @param {string} token - JWT token to store
   */
  async storeJwtToken(token) {
    try {
      // Update environment variable
      process.env.AGENT_JWT = token;
      config.api.jwt = token;

      // Store in file system for persistence
      await fs.writeFile(
        config.paths.jwtFile,
        JSON.stringify({ token }),
        "utf8",
      );

      logger.info("JWT token stored successfully");
    } catch (error) {
      logger.error(`Failed to store JWT token: ${error.message}`);
    }
  }

  /**
   * Handle authentication errors.
   * @param {Error} error Authentication error.
   */
  handleAuthenticationError(error) {
    if (error.response) {
      logger.error(
        `Authentication failed with status ${
          error.response.status
        }: ${JSON.stringify(error.response.data)}`,
      );
    } else if (error.request) {
      logger.error("No response received from backend:", error.request);
    } else {
      logger.error("Error in authentication request:", error.message);
    }
  }
}

module.exports = new AuthenticationService();
