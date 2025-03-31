/**
 * Configuration Service
 *
 * Manages the agent's configuration settings and environment variables.
 */

const fs = require("fs").promises;
const path = require("path");
const logger = require("../../utils/logger");
const config = require("../config");

class ConfigService {
  constructor() {
    this.configLoaded = false;
  }

  /**
   * Initialize the configuration service
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      logger.info("Initializing configuration service...");

      // Load environment variables if they're not already loaded
      if (!this.configLoaded) {
        await this.loadConfig();
      }

      logger.info("Configuration service initialized successfully");
      return true;
    } catch (error) {
      logger.error(
        `Failed to initialize configuration service: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Load configuration from environment and/or config files
   * @returns {Promise<boolean>} Success status
   */
  async loadConfig() {
    try {
      logger.info("Loading configuration...");

      // First priority: Environment variables (already set in config.js)

      // Second priority: .env file in development or /opt/cloudlunacy/.env in production
      const envFilePath = config.isDevelopment
        ? path.join(process.cwd(), ".env.dev")
        : "/opt/cloudlunacy/.env";

      try {
        // Check if environment file exists
        await fs.access(envFilePath);

        logger.info(`Loading environment from ${envFilePath}`);
        // We don't need to load it here as dotenv should have already done this
        // Just log that we found it
      } catch (err) {
        // File doesn't exist, but we can continue with environment variables
        logger.warn(
          `Environment file not found at ${envFilePath}, using existing environment variables`,
        );
      }

      // Validate critical configuration is available
      this.validateConfig();

      this.configLoaded = true;
      logger.info("Configuration loaded successfully");
      return true;
    } catch (error) {
      logger.error(`Failed to load configuration: ${error.message}`);
      return false;
    }
  }

  /**
   * Validate required configuration variables
   * @throws {Error} If critical configuration is missing
   */
  validateConfig() {
    // Make sure critical configuration is available
    const criticalVars = [
      { key: "serverId", value: config.serverId, name: "SERVER_ID" },
      {
        key: "api.frontApiUrl",
        value: config.api.frontApiUrl,
        name: "FRONT_API_URL",
      },
      { key: "api.token", value: config.api.token, name: "AGENT_API_TOKEN" },
    ];

    const missingVars = criticalVars.filter((v) => !v.value);

    if (missingVars.length > 0) {
      const missingList = missingVars.map((v) => v.name).join(", ");
      const errorMsg = `Missing critical configuration variables: ${missingList}`;
      logger.error(errorMsg);

      if (!config.isDevelopment) {
        throw new Error(errorMsg);
      } else {
        logger.warn(
          "In development mode, continuing despite missing configuration",
        );
      }
    }
  }

  /**
   * Get a configuration value
   * @param {string} key Configuration key
   * @param {*} defaultValue Default value if not found
   * @returns {*} Configuration value
   */
  get(key, defaultValue = null) {
    // Split the key by dots to support nested properties
    const parts = key.split(".");
    let current = config;

    for (const part of parts) {
      if (current === undefined || current === null) {
        return defaultValue;
      }
      current = current[part];
    }

    return current !== undefined ? current : defaultValue;
  }
}

module.exports = new ConfigService();
