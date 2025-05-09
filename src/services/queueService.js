/**
 * Queue Service
 *
 * Handles RabbitMQ connections and message processing.
 * Provides methods for publishing and consuming messages.
 */

const amqp = require("amqplib");
const fs = require("fs").promises;
const crypto = require("crypto");
const logger = require("../../utils/logger");
const config = require("../config");

// Configuration constants
const RECONNECT_DELAY = 5000; // 5 seconds
const MAX_RECONNECT_ATTEMPTS = 10;
const CRYPTO_ALGORITHM = "aes-256-cbc";
const RABBITMQ_CREDENTIALS_PATH =
  process.env.RABBITMQ_CREDENTIALS_PATH ||
  "/opt/cloudlunacy/rabbitmq-credentials";

class QueueService {
  constructor() {
    this.connection = null;
    this.channel = null;
    this.reconnectAttempts = 0;
    this.connected = false;
    this.connectionPromise = null;
    this.initialized = false;
    this.heartbeatInterval = null;

    // Queue and exchange names
    this.exchanges = {
      commands: "agent.commands",
      results: "agent.results",
      logs: "agent.logs",
      heartbeats: "agent.heartbeats",
    };

    this.queues = {
      commands: `agent.commands.${config.serverId}`,
      results: `agent.results.${config.serverId}`,
      logs: `agent.logs.${config.serverId}`,
    };
  }

  /**
   * Initialize the queue service
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    logger.info("Initializing queue service...");

    try {
      // Try to connect to RabbitMQ
      await this.connect();

      this.initialized = true;
      logger.info("Queue service initialized successfully");
      return true;
    } catch (error) {
      logger.error(`Failed to initialize queue service: ${error.message}`);
      return false;
    }
  }

  /**
   * Load RabbitMQ credentials from storage
   * @returns {Promise<string>} RabbitMQ connection URL
   */
  async loadRabbitMQCredentials() {
    try {
      // First check if we have the URL in the environment variable (set during this session)
      if (process.env.RABBITMQ_URL) {
        logger.info("Using RabbitMQ URL from environment variable");
        return process.env.RABBITMQ_URL;
      }

      // Otherwise, try to load from encrypted storage
      logger.info(
        "Attempting to load RabbitMQ credentials from encrypted storage",
      );

      try {
        // Read the encrypted credentials file
        const encryptedData = await fs.readFile(
          RABBITMQ_CREDENTIALS_PATH,
          "utf8",
        );

        // Get the encryption key
        const encryptionKey = await this.getEncryptionKey();

        // Decrypt the data
        const rabbitmqUrl = this.decryptData(encryptedData, encryptionKey);

        logger.info(
          "Successfully loaded RabbitMQ credentials from encrypted storage",
        );
        return rabbitmqUrl;
      } catch (decryptError) {
        // If we can't decrypt, the file might be in plaintext format from an older version
        // or simply encrypted with a different key
        logger.warn(
          `Decryption failed: ${decryptError.message}. Checking for plaintext fallback...`,
        );

        // As a fallback, let's see if file might be in plaintext
        try {
          const data = await fs.readFile(RABBITMQ_CREDENTIALS_PATH, "utf8");
          if (data.startsWith("amqp://")) {
            logger.info("Found plaintext RabbitMQ URL in credentials file");
            return data.trim();
          } else {
            // The file exists but is neither decryptable nor plaintext
            throw new Error("Invalid credential format");
          }
        } catch (error) {
          throw decryptError; // Throw the original decryption error
        }
      }
    } catch (error) {
      logger.error(`Failed to load RabbitMQ credentials: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get encryption key for credential storage
   * Uses a combination of server ID and other unique identifiers
   * @returns {Promise<string>} Encryption key
   */
  async getEncryptionKey() {
    try {
      // Use serverId as the primary key source for consistency with AuthenticationService
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
      logger.warn(`Could not generate secure encryption key: ${error.message}`);
      // Fallback to a basic key (not ideal for production)
      return "cloudlunacy-agent-fallback-key";
    }
  }

  /**
   * Decrypt data using the encryption key
   * @param {string} encryptedData - The encrypted data (hex string)
   * @param {string} encryptionKey - The encryption key
   * @returns {string} Decrypted data
   */
  decryptData(encryptedData, encryptionKey) {
    try {
      // Extract the IV from the beginning of the encrypted data
      const iv = Buffer.from(encryptedData.slice(0, 32), "hex");
      const encryptedText = encryptedData.slice(32);

      // Create a key from the encryption key using SHA-256
      const key = crypto.createHash("sha256").update(encryptionKey).digest();

      // Create decipher
      const decipher = crypto.createDecipheriv(CRYPTO_ALGORITHM, key, iv);

      // Decrypt
      let decrypted = decipher.update(encryptedText, "hex", "utf8");
      decrypted += decipher.final("utf8");

      return decrypted;
    } catch (error) {
      logger.error(`Decryption error: ${error.message}`);
      throw new Error(
        `Failed to decrypt RabbitMQ credentials: ${error.message}`,
      );
    }
  }

  /**
   * Connect to RabbitMQ
   * @returns {Promise<void>}
   */
  async connect() {
    // Don't create multiple connection attempts
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = new Promise(async (resolve, reject) => {
      try {
        // Load RabbitMQ credentials
        const rabbitmqUrl = await this.loadRabbitMQCredentials();
        logger.info(
          "🚀 ~ QueueService ~ this.connectionPromise=newPromise ~ rabbitmqUrl:",
          rabbitmqUrl,
        );

        // Log connection attempt with redacted URL (hide password)
        const redactedUrl = rabbitmqUrl.replace(/:([^:@]+)@/, ":***@");
        logger.info(`Connecting to RabbitMQ at ${redactedUrl}...`);

        // Parse and modify the URL components
        try {
          // Parse the URL to extract its components
          const urlRegex = /^amqp:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)$/;
          const match = rabbitmqUrl.match(urlRegex);

          if (!match) {
            logger.warn("Invalid RabbitMQ URL format");
            throw new Error("Invalid RabbitMQ URL format");
          }

          const [, username, password, host, port, vhost] = match;

          // Ensure the vhost has a leading slash if it's not URL encoded
          let modifiedVhost = vhost;
          if (!vhost.startsWith("/") && vhost !== "%2F") {
            modifiedVhost = "/" + vhost;
            logger.info("Adding leading slash to vhost");
          }

          // URL encode the username, password, and vhost to handle special characters
          const encodedUsername = encodeURIComponent(username);
          logger.info(
            "🚀 ~ QueueService ~ this.connectionPromise=newPromise ~ const:",
            encodedUsername,
          );
          const encodedPassword = encodeURIComponent(password);
          logger.info(
            "🚀 ~ QueueService ~ this.connectionPromise=newPromise ~ encodedPassword:",
            encodedPassword,
          );
          const encodedVhost = encodeURIComponent(modifiedVhost);
          logger.info(
            "🚀 ~ QueueService ~ this.connectionPromise=newPromise ~ encodedVhost:",
            encodedVhost,
          );

          // Construct the modified URL
          const modifiedUrl = `amqp://${encodedUsername}:${encodedPassword}@${host}:${port}/${encodedVhost}`;
          logger.info("Using URL-encoded components for RabbitMQ connection");

          // Connection options with authentication mechanism explicitly set to PLAIN
          const socketOptions = {
            servername: host, // Set SNI if using TLS
          };

          const connectionOptions = {
            heartbeat: 30, // 30 seconds heartbeat
            locale: "en_US",
            timeout: 10000, // 10 second connection timeout
            frameMax: 0, // Default frame size
            channelMax: 0, // Default max channels
            vhost: modifiedVhost, // Explicit vhost setting
            authMechanism: ["PLAIN"], // Explicitly use PLAIN auth
            socket: socketOptions,
          };

          // Connect to RabbitMQ with timeout
          const connectPromise = amqp.connect(modifiedUrl, connectionOptions);

          // Add timeout to connection attempt
          const timeoutPromise = new Promise((_, rejectTimeout) => {
            setTimeout(
              () => rejectTimeout(new Error("Connection timeout")),
              10000,
            );
          });

          // Race the connection attempt against the timeout
          this.connection = await Promise.race([
            connectPromise,
            timeoutPromise,
          ]);

          // Set up connection event handlers
          this.connection.on("error", (err) => {
            logger.error(`RabbitMQ connection error: ${err.message}`);
            this.handleConnectionFailure();
          });

          this.connection.on("close", () => {
            logger.warn("RabbitMQ connection closed");
            this.handleConnectionFailure();
          });

          // Create a channel
          this.channel = await this.connection.createChannel();

          // Set up exchanges and queues
          await this.setupExchangesAndQueues();

          // Reset reconnect attempts on successful connection
          this.reconnectAttempts = 0;
          this.connected = true;
          this.connectionPromise = null;

          logger.info("Successfully connected to RabbitMQ");
          resolve();
        } catch (error) {
          logger.error(`Failed to connect to RabbitMQ: ${error.message}`);

          // As a fallback, try a direct connection without URL modifications
          try {
            logger.info("Trying fallback connection method...");

            // Attempt simplified connection with minimal options
            this.connection = await amqp.connect(rabbitmqUrl, {
              heartbeat: 30,
            });

            // Create a channel
            this.channel = await this.connection.createChannel();

            // Set up exchanges and queues
            await this.setupExchangesAndQueues();

            // Reset reconnect attempts on successful connection
            this.reconnectAttempts = 0;
            this.connected = true;
            this.connectionPromise = null;

            logger.info(
              "Successfully connected to RabbitMQ with fallback method",
            );
            resolve();
            return;
          } catch (fallbackError) {
            logger.error(
              `Fallback connection also failed: ${fallbackError.message}`,
            );
          }

          this.connected = false;
          this.connectionPromise = null;
          this.handleConnectionFailure();
          reject(error);
        }
      } catch (outerError) {
        logger.error(`Error in connect method: ${outerError.message}`);
        this.connected = false;
        this.connectionPromise = null;
        this.handleConnectionFailure();
        reject(outerError);
      }
    });

    return this.connectionPromise;
  }

  /**
   * Handle connection failure and attempt reconnection
   */
  handleConnectionFailure() {
    this.connected = false;
    this.connection = null;
    this.channel = null;
    this.connectionPromise = null;

    // Clear any existing heartbeat interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Attempt reconnection with exponential backoff
    if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = Math.min(
        RECONNECT_DELAY * Math.pow(1.5, this.reconnectAttempts),
        60000,
      );
      this.reconnectAttempts++;

      logger.info(
        `Attempting to reconnect to RabbitMQ in ${delay / 1000} seconds (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`,
      );

      setTimeout(() => {
        this.connect().catch((error) => {
          logger.error(`Reconnection attempt failed: ${error.message}`);
        });
      }, delay);
    } else {
      logger.error(
        `Maximum reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`,
      );
    }
  }

  /**
   * Set up exchanges and queues
   * @returns {Promise<void>}
   */
  async setupExchangesAndQueues() {
    try {
      // Create exchanges
      await this.channel.assertExchange(this.exchanges.commands, "direct", {
        durable: true,
      });
      await this.channel.assertExchange(this.exchanges.results, "direct", {
        durable: true,
      });
      await this.channel.assertExchange(this.exchanges.logs, "direct", {
        durable: true,
      });
      await this.channel.assertExchange(this.exchanges.heartbeats, "direct", {
        durable: true,
      });

      // Create queues with TTL (messages expire after 7 days)
      await this.channel.assertQueue(this.queues.commands, {
        durable: true,
        arguments: {
          "x-message-ttl": 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
          "x-queue-type": "classic",
        },
      });

      await this.channel.assertQueue(this.queues.results, {
        durable: true,
        arguments: {
          "x-message-ttl": 7 * 24 * 60 * 60 * 1000,
          "x-queue-type": "classic",
        },
      });

      await this.channel.assertQueue(this.queues.logs, {
        durable: true,
        arguments: {
          "x-message-ttl": 3 * 24 * 60 * 60 * 1000, // 3 days for logs
          "x-queue-type": "classic",
        },
      });

      // Bind queues to exchanges
      await this.channel.bindQueue(
        this.queues.commands,
        this.exchanges.commands,
        config.serverId,
      );
      await this.channel.bindQueue(
        this.queues.results,
        this.exchanges.results,
        config.serverId,
      );
      await this.channel.bindQueue(
        this.queues.logs,
        this.exchanges.logs,
        config.serverId,
      );

      logger.info("Successfully set up RabbitMQ exchanges and queues");
    } catch (error) {
      logger.error(`Failed to set up exchanges and queues: ${error.message}`);
      throw error;
    }
  }

  /**
   * Start sending heartbeats to RabbitMQ
   */
  startHeartbeats() {
    // Clear any existing heartbeat interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Send heartbeats every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      if (this.connected && this.channel) {
        try {
          this.channel.publish(
            this.exchanges.heartbeats,
            config.serverId,
            Buffer.from(
              JSON.stringify({
                serverId: config.serverId,
                timestamp: new Date().toISOString(),
                status: "active",
              }),
            ),
            { persistent: true },
          );
        } catch (error) {
          logger.warn(`Failed to send heartbeat: ${error.message}`);
        }
      }
    }, 30000); // 30 seconds

    logger.info("Started RabbitMQ heartbeat service");
  }

  /**
   * Consume commands from the command queue
   * @param {Function} callback - Function to call when a message is received
   * @returns {Promise<Object>} Consumer details
   */
  async consumeCommands(callback) {
    if (!this.connected) {
      await this.connect();
    }

    try {
      // Ensure we don't try to process too many messages at once
      this.channel.prefetch(5);

      // Start consuming messages
      const { consumerTag } = await this.channel.consume(
        this.queues.commands,
        async (msg) => {
          if (!msg) {
            logger.warn("Received null message from RabbitMQ");
            return;
          }

          try {
            // Parse the message
            const content = JSON.parse(msg.content.toString());
            logger.info(`Received command: ${content.jobType || "unknown"}`);

            try {
              // Process the message using the provided callback
              await callback(content);

              // Acknowledge the message if processing was successful
              this.channel.ack(msg);
            } catch (error) {
              logger.error(`Error processing command: ${error.message}`);

              // Reject the message and requeue it if it's a temporary error
              // For permanent errors, we should use nack with requeue=false
              // or send it to a dead letter queue
              const isTemporaryError = !error.permanent;
              this.channel.nack(msg, false, isTemporaryError);
            }
          } catch (parseError) {
            logger.error(
              `Failed to parse command message: ${parseError.message}`,
            );
            // Don't requeue if the message is invalid
            this.channel.nack(msg, false, false);
          }
        },
        { noAck: false }, // Manual acknowledgment
      );

      logger.info(
        `Command consumer set up successfully with tag: ${consumerTag}`,
      );
      return { consumerTag };
    } catch (error) {
      logger.error(`Failed to consume commands: ${error.message}`);
      throw error;
    }
  }

  /**
   * Publish a result message
   * @param {Object} result - Result object to publish
   * @returns {Promise<boolean>} Success status
   */
  async publishResult(result) {
    if (!this.connected) {
      await this.connect();
    }

    try {
      const success = this.channel.publish(
        this.exchanges.results,
        config.serverId,
        Buffer.from(
          JSON.stringify({
            ...result,
            serverId: config.serverId,
            timestamp: new Date().toISOString(),
          }),
        ),
        { persistent: true },
      );

      if (!success) {
        logger.warn(
          "Channel write buffer is full, result message was not published",
        );
      }

      return success;
    } catch (error) {
      logger.error(`Failed to publish result: ${error.message}`);
      return false;
    }
  }

  /**
   * Publish a log message
   * @param {Object} logMessage - Log message object to publish
   * @returns {Promise<boolean>} Success status
   */
  async publishLog(logMessage) {
    if (!this.connected) {
      await this.connect();
    }

    try {
      const success = this.channel.publish(
        this.exchanges.logs,
        config.serverId,
        Buffer.from(
          JSON.stringify({
            ...logMessage,
            serverId: config.serverId,
            timestamp: logMessage.timestamp || new Date().toISOString(),
          }),
        ),
        { persistent: true },
      );

      if (!success) {
        logger.warn(
          "Channel write buffer is full, log message was not published",
        );
      }

      return success;
    } catch (error) {
      logger.error(`Failed to publish log: ${error.message}`);
      return false;
    }
  }

  /**
   * Shutdown the queue service
   * @returns {Promise<boolean>} Success status
   */
  async shutdown() {
    try {
      logger.info("Shutting down queue service...");

      // Clear heartbeat interval
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }

      // Close channel and connection
      if (this.channel) {
        await this.channel.close();
        this.channel = null;
      }

      if (this.connection) {
        await this.connection.close();
        this.connection = null;
      }

      this.connected = false;
      this.initialized = false;

      logger.info("Queue service shut down successfully");
      return true;
    } catch (error) {
      logger.error(`Error shutting down queue service: ${error.message}`);
      return false;
    }
  }
}

module.exports = new QueueService();
