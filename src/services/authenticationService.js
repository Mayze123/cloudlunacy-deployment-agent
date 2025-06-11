/**
 * Authentication Service
 *
 * Handles authentication with the backend server.
 * Manages JWT tokens, RabbitMQ credentials, and websocket connections.
 */

const axios = require("axios");
const fs = require("fs").promises;
const crypto = require("crypto");
const logger = require("../../utils/logger");
const config = require("../config");
const websocketService = require("./websocketService");
const enhancedWebSocketService = require("./enhancedWebSocketService");
const queueService = require("./queueService");

// Constants
const CRYPTO_ALGORITHM = "aes-256-cbc";
const RABBITMQ_CREDENTIALS_PATH =
  process.env.RABBITMQ_CREDENTIALS_PATH ||
  "/opt/cloudlunacy/rabbitmq-credentials";

class AuthenticationService {
  constructor() {
    this.initialized = false;
    this.isConnected = false;
    this.usingWebsocketFallback = false;
    this.commandConsumer = null;
    this.websocketToken = null; // Store WebSocket token separately
  }

  /**
   * Initialize the authentication service
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      logger.info("Initializing authentication service...");

      // Initialize based on available connections
      await this.authenticateAndConnect();

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
   * Authenticate with the backend and establish connections.
   * First, try RabbitMQ, then fallback to WebSocket if needed.
   */
  async authenticateAndConnect() {
    try {
      if (!config.api.backendUrl) {
        logger.error(
          "Backend URL not configured, cannot connect to backend services",
        );
        return;
      }

      logger.info(
        `Authenticating with backend service at ${config.api.backendUrl}...`,
      );

      try {
        // First try to authenticate with the backend server
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
            timeout: 10000, // 10 second timeout
          },
        );

        logger.info(`response.data ${response.data}`);

        // Check if we received a JWT token in the response and store it
        if (response.data.jwt) {
          await this.storeJwtToken(response.data.jwt);
        }

        // Extract connection details from response based on updated backend API
        const { wsUrl, rabbitmq, agentToken } = response.data;
        logger.info(
          `🚀 ~ AuthenticationService ~ authenticateAndConnect ~ rabbitmq: ${rabbitmq}`,
        );

        // Store the WebSocket token for future use
        if (agentToken) {
          this.websocketToken = agentToken;
          logger.info("WebSocket authentication token received from backend");
        } else {
          logger.warn("No WebSocket token provided by backend");
        }

        // Always establish WebSocket connection for heartbeats and metrics
        if (wsUrl) {
          logger.info(`WebSocket URL received from backend: ${wsUrl}`);

          // Try enhanced WebSocket service first
          try {
            logger.info(
              "Establishing enhanced WebSocket service for heartbeats and metrics",
            );
            await enhancedWebSocketService.initialize();
            await enhancedWebSocketService.connect();

            // Setup event handlers
            enhancedWebSocketService.on("connected", () => {
              logger.info("Enhanced WebSocket service connected successfully");
              this.isConnected = true;
            });

            enhancedWebSocketService.on("registered", () => {
              logger.info("Agent registered with enhanced WebSocket service");
            });

            enhancedWebSocketService.on("disconnected", () => {
              logger.warn("Enhanced WebSocket service disconnected");
              // Don't set isConnected to false here as RabbitMQ might still be working
            });

            enhancedWebSocketService.on("error", (error) => {
              logger.error(
                `Enhanced WebSocket service error: ${error.message}`,
              );
            });
          } catch (enhancedError) {
            logger.warn(
              `Enhanced WebSocket service failed: ${enhancedError.message}`,
            );
            logger.info("Falling back to legacy WebSocket service");

            try {
              // Fallback to legacy WebSocket service
              websocketService.establishConnection(wsUrl);
              logger.info(
                "Legacy WebSocket service established for heartbeats",
              );
            } catch (legacyError) {
              logger.error(
                `Legacy WebSocket service also failed: ${legacyError.message}`,
              );
            }
          }
        } else {
          logger.warn(
            "No WebSocket URL provided - heartbeats and metrics will not be sent",
          );
        }

        // Try RabbitMQ connection for command processing if details were provided
        if (rabbitmq && rabbitmq.url) {
          logger.info("RabbitMQ connection details received from backend");

          try {
            // Store RabbitMQ URL in environment variable for immediate use
            process.env.RABBITMQ_URL = rabbitmq.url;

            // Store the RabbitMQ credentials securely for future use
            await this.storeRabbitMQConfig(rabbitmq.url);

            // Initialize the queue service
            logger.info("Initializing queue service with RabbitMQ URL");
            const queueInitialized = await queueService.initialize();

            if (queueInitialized) {
              logger.info(
                "Successfully connected to RabbitMQ for command processing",
              );

              // Start consuming messages from the command queue
              logger.info("Setting up command queue consumer");
              this.commandConsumer = await queueService.consumeCommands(
                async (job, msg, channel) => {
                  try {
                    // Pass the job, message and channel to the command handler for processing
                    await require("../controllers/commandHandler").processJob(
                      job,
                      msg,
                      channel,
                    );
                  } catch (error) {
                    logger.error(
                      `Error processing job from queue: ${error.message}`,
                    );
                  }
                },
              );

              if (this.commandConsumer) {
                logger.info(
                  "Command queue consumer set up successfully with consumer tag: " +
                    (this.commandConsumer.consumerTag ||
                      JSON.stringify(this.commandConsumer)),
                );

                // Note: We don't start RabbitMQ heartbeats anymore as WebSocket handles all heartbeats
                logger.info(
                  "Using WebSocket for heartbeats instead of RabbitMQ",
                );
              } else {
                logger.error(
                  "Failed to set up command consumer - no consumer tag returned",
                );
              }
            } else {
              logger.warn(
                "Failed to initialize queue service for command processing",
              );
            }
          } catch (queueError) {
            logger.error(
              `Failed to connect to RabbitMQ: ${queueError.message}`,
            );
            logger.info(
              "Will use WebSocket for command communication as fallback",
            );
            this.usingWebsocketFallback = true;
          }
        } else {
          logger.warn(
            "No RabbitMQ connection details provided by server, using WebSocket for all communication",
          );
          this.usingWebsocketFallback = true;
        }

        // Ensure we're marked as connected if either WebSocket or RabbitMQ succeeded
        if (!this.isConnected && wsUrl) {
          logger.error(
            "Failed to establish any connection to backend services",
          );
          throw new Error("No communication channel established with backend");
        }
      } catch (error) {
        logger.warn(`Could not connect to backend service: ${error.message}`);
        logger.warn("Agent will run in standalone mode with Traefik only");

        // Continue without connection in Traefik-only mode
        // This allows the agent to work with Traefik for proxying even without backend connection
      }
    } catch (error) {
      this.handleAuthenticationError(error);
    }
  }

  /**
   * Securely store the RabbitMQ connection details
   * @param {string} rabbitmqUrl - The RabbitMQ connection URL
   * @returns {Promise<void>}
   */
  async storeRabbitMQConfig(rabbitmqUrl) {
    try {
      logger.info(`🚀 rabbitmqUrl: ${rabbitmqUrl}`);
      // Set environment variable for immediate use only - not persistent across restarts
      process.env.RABBITMQ_URL = rabbitmqUrl;

      // For environments that support secure credential storage
      if (process.env.USE_SECURE_CREDENTIAL_STORAGE === "true") {
        try {
          // In production environments, you might integrate with a secrets manager
          // like HashiCorp Vault, AWS Secrets Manager, or similar service
          // This is just a placeholder for that implementation
          await this.storeInSecretManager("rabbitmq_url", rabbitmqUrl);
          logger.info("RabbitMQ credentials stored in secure secrets manager");
        } catch (secretError) {
          logger.warn(
            `Failed to store in secrets manager: ${secretError.message}`,
          );
          // Fall back to file-based storage with encryption
          await this.storeEncryptedCredentials(rabbitmqUrl);
        }
      } else {
        // Fall back to file-based storage with encryption
        await this.storeEncryptedCredentials(rabbitmqUrl);
      }

      logger.info("RabbitMQ URL stored securely for this session");
    } catch (error) {
      logger.warn(`Failed to store RabbitMQ configuration: ${error.message}`);
      // Still keep the environment variable for this session only
    }
  }

  /**
   * Store credentials in an encrypted file
   * @param {string} rabbitmqUrl - The RabbitMQ connection URL
   * @returns {Promise<void>}
   */
  async storeEncryptedCredentials(rabbitmqUrl) {
    try {
      // Make sure credentials directory exists
      const credentialsDir = RABBITMQ_CREDENTIALS_PATH.substring(
        0,
        RABBITMQ_CREDENTIALS_PATH.lastIndexOf("/"),
      );
      await fs.mkdir(credentialsDir, { recursive: true });

      // Get or generate an encryption key based on a combination of:
      // 1. Server-specific information (hardware ID, machine ID)
      // 2. The JWT token (which is unique to this agent instance)
      const encryptionKey = await this.getEncryptionKey();

      // Encrypt the connection URL before storing it
      const encryptedCredentials = this.encryptData(rabbitmqUrl, encryptionKey);

      // Save encrypted connection URL with restricted permissions
      await fs.writeFile(RABBITMQ_CREDENTIALS_PATH, encryptedCredentials, {
        encoding: "utf8",
        mode: 0o600, // Owner read/write only
      });

      logger.info(
        `RabbitMQ connection details stored securely (encrypted) at ${RABBITMQ_CREDENTIALS_PATH}`,
      );
    } catch (error) {
      logger.warn(
        `Failed to store encrypted RabbitMQ credentials: ${error.message}`,
      );
    }
  }

  /**
   * Get or generate an encryption key for securing credentials
   * @returns {Promise<string>} Encryption key
   */
  async getEncryptionKey() {
    try {
      // Use serverId as the primary key source for consistency
      // This ensures stable encryption/decryption across agent restarts
      if (config.serverId) {
        logger.info("Using server ID for encryption key generation");
        return config.serverId;
      }

      // Fallback to JWT only if serverId is not available
      const jwtToken = config.api.jwt || process.env.AGENT_JWT;
      if (jwtToken) {
        logger.info("Using JWT for encryption key generation (fallback)");
        return jwtToken;
      }

      logger.warn(
        "No server ID or JWT available for encryption key generation",
      );
      return "cloudlunacy-agent-fallback-key";
    } catch (error) {
      logger.error(`Failed to generate encryption key: ${error.message}`);
      throw error;
    }
  }

  /**
   * Encrypt data using the encryption key
   * @param {string} data - Data to encrypt
   * @param {string} encryptionKey - Encryption key
   * @returns {string} Encrypted data as hex string
   */
  encryptData(data, encryptionKey) {
    // Generate a secure IV
    const iv = crypto.randomBytes(16);

    // Create a key from the encryption key using SHA-256
    const key = crypto.createHash("sha256").update(encryptionKey).digest();

    // Create cipher
    const cipher = crypto.createCipheriv(CRYPTO_ALGORITHM, key, iv);

    // Encrypt
    let encrypted = cipher.update(data, "utf8", "hex");
    encrypted += cipher.final("hex");

    // Return IV + encrypted data (IV is needed for decryption)
    return iv.toString("hex") + encrypted;
  }

  /**
   * Store a secret in a secure secrets manager
   * @param {string} key - Secret key
   * @param {string} value - Secret value
   * @returns {Promise<void>}
   */
  async storeInSecretManager(key, value) {
    // This is a placeholder for integration with a secrets manager
    // In a real environment, this would connect to HashiCorp Vault, AWS Secrets Manager, etc.
    throw new Error("Secrets manager integration not implemented");
  }

  /**
   * Get the WebSocket authentication token
   * @returns {string|null} The WebSocket token or null if not available
   */
  getWebSocketToken() {
    return this.websocketToken || config.api.token; // Fallback to API token if WebSocket token not available
  }

  /**
   * Handle authentication errors
   * @param {Error} error Error that occurred
   */
  handleAuthenticationError(error) {
    logger.error(`Authentication error: ${error.message}`);

    // If we're in standalone mode, we can continue without authentication
    if (config.standalone) {
      logger.warn("Agent will run in standalone mode with Traefik only");
      return;
    }

    // Otherwise log detailed error information for debugging
    if (error.response) {
      logger.error(`Response status: ${error.response.status}`);
      logger.error(`Response data: ${JSON.stringify(error.response.data)}`);
    }

    logger.error(
      "Fatal authentication error, agent requires backend connection",
    );
  }

  /**
   * Store JWT token for future use
   * @param {string} jwt JWT token
   * @returns {Promise<void>}
   */
  async storeJwtToken(jwt) {
    try {
      // Save the JWT to environment variable for immediate use
      process.env.AGENT_JWT = jwt;
      config.api.jwt = jwt;

      // Save to the config file for persistence
      const tokenPath = process.env.TOKEN_PATH || "/opt/cloudlunacy/token.jwt";
      await fs.writeFile(tokenPath, jwt, "utf8");
      logger.info(`JWT token stored to ${tokenPath}`);
    } catch (error) {
      logger.warn(`Failed to store JWT: ${error.message}`);
    }
  }

  /**
   * Check if we're using the WebSocket fallback
   * @returns {boolean} True if using WebSocket fallback
   */
  isUsingWebSocketFallback() {
    return this.usingWebsocketFallback;
  }

  /**
   * Check if we're connected to either RabbitMQ or WebSocket
   * @returns {boolean} True if connected
   */
  checkConnection() {
    return this.isConnected;
  }

  /**
   * Shutdown the authentication service
   * @returns {Promise<boolean>} Success status
   */
  async shutdown() {
    try {
      logger.info("Shutting down authentication service...");

      this.initialized = false;
      this.isConnected = false;

      logger.info("Authentication service shut down successfully");
      return true;
    } catch (error) {
      logger.error(
        `Error shutting down authentication service: ${error.message}`,
      );
      return false;
    }
  }
}

module.exports = new AuthenticationService();
