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
      // In development mode, skip the actual authentication
      if (config.isDevelopment) {
        logger.info("Development mode: Skipping backend authentication");
        // Use a mock WebSocket URL for development that works with Docker
        const wsUrl = "ws://host.docker.internal:8080/agent";
        logger.info(`Using development WebSocket URL: ${wsUrl}`);
        websocketService.establishConnection(wsUrl);
        this.usingWebsocketFallback = true;
        this.isConnected = true;
        return;
      }

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
        const { wsUrl, rabbitmq } = response.data;
        logger.info(
          "🚀 ~ AuthenticationService ~ authenticateAndConnect ~ rabbitmq:",
          rabbitmq,
        );

        // Log the full authentication response for debugging (redact any sensitive info)
        const responseCopy = { ...response.data };
        if (responseCopy.rabbitmq && responseCopy.rabbitmq.url) {
          responseCopy.rabbitmq.url = responseCopy.rabbitmq.url.replace(
            /:([^:@]+)@/,
            ":***@",
          );
        }
        logger.info(`Authentication response: ${JSON.stringify(responseCopy)}`);

        // Try RabbitMQ connection first if rabbitmq details were provided
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
              logger.info("Successfully connected to RabbitMQ");

              // Start consuming messages from the command queue
              logger.info("Setting up command queue consumer");
              this.commandConsumer = await queueService.consumeCommands(
                async (job) => {
                  try {
                    // Pass the job to the command handler for processing
                    await require("../controllers/commandHandler").processJob(
                      job,
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

                // Start sending heartbeats
                queueService.startHeartbeats();

                this.isConnected = true;
                return;
              } else {
                logger.error(
                  "Failed to set up command consumer - no consumer tag returned",
                );
              }
            } else {
              logger.warn(
                "Failed to initialize queue service, will try WebSocket fallback",
              );
            }
          } catch (queueError) {
            logger.error(
              `Failed to connect to RabbitMQ: ${queueError.message}`,
            );
            logger.info("Falling back to WebSocket communication");
          }
        } else {
          logger.warn(
            "No RabbitMQ connection details provided by server, using WebSocket fallback",
          );
        }

        // Fallback to WebSocket if RabbitMQ connection failed or URL not provided
        if (wsUrl) {
          logger.info(`WebSocket URL received from backend: ${wsUrl}`);
          websocketService.establishConnection(wsUrl);
          this.usingWebsocketFallback = true;
          this.isConnected = true;
        } else {
          throw new Error(
            "Neither RabbitMQ nor WebSocket URL provided by backend.",
          );
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

      // Log success with redacted URL (hide password)
      const redactedUrl = rabbitmqUrl.replace(/:([^:@]+)@/, ":***@");
      logger.info(`Using RabbitMQ server: ${redactedUrl}`);
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
   * Store JWT token to file for persistence.
   * @param {string} token - JWT token to store
   */
  async storeRabbitMQConfig(rabbitmqUrl) {
    try {
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

      // Log success with redacted URL (hide password)
      const redactedUrl = rabbitmqUrl.replace(/:([^:@]+)@/, ":***@");
      logger.info(`Using RabbitMQ server: ${redactedUrl}`);
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
      // For security, we save to a protected credentials file
      const credentialsPath =
        process.env.RABBITMQ_CREDENTIALS_PATH ||
        "/opt/cloudlunacy/rabbitmq-credentials";

      // Make sure credentials directory exists
      const credentialsDir = credentialsPath.substring(
        0,
        credentialsPath.lastIndexOf("/"),
      );
      await fs.mkdir(credentialsDir, { recursive: true });

      // Get or generate an encryption key based on a combination of:
      // 1. Server-specific information (hardware ID, machine ID)
      // 2. The JWT token (which is unique to this agent instance)
      const encryptionKey = await this.getEncryptionKey();

      // Encrypt the connection URL before storing it
      const encryptedCredentials = this.encryptData(rabbitmqUrl, encryptionKey);

      // Save encrypted connection URL with restricted permissions
      await fs.writeFile(credentialsPath, encryptedCredentials, {
        encoding: "utf8",
        mode: 0o600, // Owner read/write only
      });

      logger.info(
        `RabbitMQ connection details stored securely (encrypted) at ${credentialsPath}`,
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
    // Use a combination of machine-specific information and our JWT for the key
    // This means even if someone gets the file, they'd need both the agent's
    // machine access and the JWT to decrypt it
    try {
      // In a real implementation, you'd use crypto.scrypt or a similar
      // key derivation function with hardware-specific identifiers

      // For simplicity in this example, we'll use the JWT as the basis
      // but in production you should use proper cryptographic methods
      const jwtToken = config.api.jwt || process.env.AGENT_JWT;
      if (!jwtToken) {
        throw new Error("No JWT available for encryption key generation");
      }

      // In real implementation, combine with hardware identifiers
      // like MAC address, disk ID, etc.
      return jwtToken;
    } catch (error) {
      logger.error(`Failed to generate encryption key: ${error.message}`);
      throw error;
    }
  }

  /**
   * Encrypt data with a key
   * @param {string} data - Data to encrypt
   * @param {string} key - Encryption key
   * @returns {string} Encrypted data
   */
  encryptData(data, key) {
    try {
      // In a real implementation, you would:
      // 1. Use crypto.createCipheriv with a proper IV
      // 2. Use AES-256-GCM or similar authenticated encryption
      // 3. Store the IV with the ciphertext

      // This is a placeholder for actual encryption
      // DO NOT use this in production - implement proper encryption
      const crypto = require("crypto");
      const cipher = crypto.createCipher("aes-256-cbc", key);
      let encrypted = cipher.update(data, "utf8", "hex");
      encrypted += cipher.final("hex");
      return encrypted;
    } catch (error) {
      logger.error(`Encryption failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Decrypt data with a key
   * @param {string} encryptedData - Encrypted data
   * @param {string} key - Encryption key
   * @returns {string} Decrypted data
   */
  decryptData(encryptedData, key) {
    try {
      // This is a placeholder for actual decryption
      // DO NOT use this in production - implement proper decryption
      const crypto = require("crypto");
      const decipher = crypto.createDecipher("aes-256-cbc", key);
      let decrypted = decipher.update(encryptedData, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    } catch (error) {
      logger.error(`Decryption failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Placeholder for integration with a secrets manager
   * @param {string} key - Secret key
   * @param {string} value - Secret value
   * @returns {Promise<void>}
   */
  async storeInSecretManager(key, value) {
    // This would be replaced with actual integration code for your chosen
    // secrets manager service (HashiCorp Vault, AWS Secrets Manager, etc.)
    throw new Error("Secrets manager integration not implemented");
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
