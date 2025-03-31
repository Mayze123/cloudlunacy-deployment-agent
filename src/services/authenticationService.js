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
    // Set the reference to this service in websocketService to avoid circular dependency
    websocketService.setAuthService(this);
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

      logger.info(
        "Authenticating with backend server for WebSocket connection...",
      );

      // Updated to use the backend API endpoint for WebSocket authentication
      const response = await axios.post(
        `${config.api.backendUrl}/api/agents/authenticate`,
        {
          agentToken: config.serverId,
          serverId: config.api.token,
        },
        {
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      // Check if we received a JWT token in the response and store it
      if (response.data.token) {
        await this.storeJwtToken(response.data.token);
        logger.info("Authentication successful, received JWT token");
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
        `Backend authentication failed with status ${
          error.response.status
        }: ${JSON.stringify(error.response.data)}`,
      );
    } else if (error.request) {
      logger.error("No response received from backend:", error.request);
    } else {
      logger.error("Error in backend authentication request:", error.message);
    }
  }
}

module.exports = new AuthenticationService();
