/**
 * Queue Service
 *
 * Handles communication with RabbitMQ message broker.
 * Provides methods for consuming commands, publishing results,
 * publishing logs, and sending heartbeats.
 */

const amqp = require("amqplib");
const logger = require("../../utils/logger");
const config = require("../config");
const os = require("os");
const fs = require("fs").promises;
const crypto = require("crypto");

class QueueService {
  constructor() {
    // Configure connection options
    this.rabbitmqUrl = process.env.RABBITMQ_URL || "";
    this.connection = null;
    this.channel = null;
    this.serverId = config.serverId;

    // Updated queue names to match new backend specification
    this.queues = {
      COMMANDS: `commands.${this.serverId}`, // Server-specific command queue
      RESULTS: "results",
      LOGS: "logs", // Exchange name
      HEARTBEATS: "heartbeats",
    };

    this.initialized = false;
    this.heartbeatInterval = null;
    this.reconnectTimeout = null;
    this.reconnectDelay = 5000; // Start with 5 seconds
    this.maxReconnectDelay = 60000; // Maximum 1 minute
  }

  /**
   * Initialize the connection to RabbitMQ
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    if (this.initialized) return true;

    try {
      // If URL not in environment variable, try to load from encrypted storage
      if (!this.rabbitmqUrl) {
        await this.loadRabbitMQCredentials();
      }

      // Check if RabbitMQ URL is configured after attempting to load
      if (!this.rabbitmqUrl) {
        logger.warn(
          "RabbitMQ URL not configured, queue service will not be available",
        );
        return false;
      }

      // Log connection attempt without exposing full credentials in logs
      const redactedUrl = this.redactConnectionString(this.rabbitmqUrl);
      logger.info(`Connecting to RabbitMQ at ${redactedUrl}...`);

      this.connection = await amqp.connect(this.rabbitmqUrl);
      this.channel = await this.connection.createChannel();

      // Ensure queues exist
      await this.channel.assertQueue(this.queues.COMMANDS, { durable: true });
      await this.channel.assertQueue(this.queues.RESULTS, { durable: true });
      await this.channel.assertQueue(this.queues.HEARTBEATS, { durable: true });

      // Create exchange for logs
      await this.channel.assertExchange(this.queues.LOGS, "fanout", {
        durable: true,
      });

      // Setup reconnection handler
      this.connection.on("error", (err) => {
        logger.error("RabbitMQ connection error:", err);
        this.handleDisconnect();
      });

      this.connection.on("close", () => {
        if (this.initialized) {
          logger.warn(
            "RabbitMQ connection closed unexpectedly, attempting to reconnect...",
          );
          this.handleDisconnect();
        } else {
          logger.info("RabbitMQ connection closed");
        }
      });

      this.initialized = true;
      logger.info("Queue service initialized successfully");
      return true;
    } catch (error) {
      logger.error(`Failed to connect to RabbitMQ: ${error.message}`);
      this.handleDisconnect();
      return false;
    }
  }

  /**
   * Try to load RabbitMQ credentials from encrypted storage
   * @returns {Promise<boolean>} Success status
   */
  async loadRabbitMQCredentials() {
    try {
      // Path where encrypted credentials are stored
      const credentialsPath =
        process.env.RABBITMQ_CREDENTIALS_PATH ||
        "/opt/cloudlunacy/rabbitmq-credentials";

      // Check if credentials file exists
      try {
        await fs.access(credentialsPath);
      } catch (accessError) {
        logger.warn(
          `No stored RabbitMQ credentials found at ${credentialsPath}`,
        );
        return false;
      }

      // Read encrypted credentials
      const encryptedCredentials = await fs.readFile(credentialsPath, "utf8");

      // Try to get the encryption key
      try {
        // In a real implementation, this would be properly integrated with
        // the auth service's key derivation function
        const authService = require("../services/authenticationService");
        const encryptionKey = await authService.getEncryptionKey();

        // Decrypt the credentials
        this.rabbitmqUrl = authService.decryptData(
          encryptedCredentials,
          encryptionKey,
        );

        logger.info(
          "Successfully loaded RabbitMQ credentials from encrypted storage",
        );
        return true;
      } catch (keyError) {
        logger.error(`Failed to get encryption key: ${keyError.message}`);
        return false;
      }
    } catch (error) {
      logger.error(`Error loading RabbitMQ credentials: ${error.message}`);
      return false;
    }
  }

  /**
   * Redact sensitive information from connection string for logging
   * @param {string} connectionString - The RabbitMQ connection string
   * @returns {string} - Redacted connection string
   */
  redactConnectionString(connectionString) {
    try {
      // Replace password with asterisks in connection string
      return connectionString.replace(/:([^:@]+)@/, ":***@");
    } catch (error) {
      return "Invalid connection string";
    }
  }

  /**
   * Handle disconnection and reconnection logic
   */
  handleDisconnect() {
    this.initialized = false;
    this.clearResources();

    // Use exponential backoff for reconnection
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(() => {
      logger.info("Attempting to reconnect to RabbitMQ...");
      this.initialize()
        .then((success) => {
          if (success) {
            logger.info("Successfully reconnected to RabbitMQ");
            this.reconnectDelay = 5000; // Reset the delay
          } else {
            // Increase the delay for next attempt (exponential backoff)
            this.reconnectDelay = Math.min(
              this.reconnectDelay * 2,
              this.maxReconnectDelay,
            );
          }
        })
        .catch((err) => {
          logger.error("Failed to reconnect to RabbitMQ:", err);
          // Increase the delay for next attempt (exponential backoff)
          this.reconnectDelay = Math.min(
            this.reconnectDelay * 2,
            this.maxReconnectDelay,
          );
        });
    }, this.reconnectDelay);
  }

  /**
   * Clear connection resources
   */
  async clearResources() {
    if (this.channel) {
      try {
        await this.channel.close();
      } catch (error) {
        logger.error("Error closing channel:", error);
      }
      this.channel = null;
    }

    if (this.connection) {
      try {
        await this.connection.close();
      } catch (error) {
        logger.error("Error closing connection:", error);
      }
      this.connection = null;
    }

    // Clear the heartbeat interval if it's running
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Shut down the queue service
   * @returns {Promise<boolean>} Success status
   */
  async shutdown() {
    logger.info("Shutting down queue service...");
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.initialized = false;
    await this.clearResources();
    logger.info("Queue service shut down successfully");
    return true;
  }

  /**
   * Publish a result to the results queue
   * @param {Object} result Result object to publish
   * @returns {Promise<boolean>} Success status
   */
  async publishResult(result) {
    try {
      if (!this.initialized) {
        const initSuccess = await this.initialize();
        if (!initSuccess) return false;
      }

      logger.debug(
        `Publishing result for job ${result.jobId}: ${result.status}`,
      );

      const success = this.channel.sendToQueue(
        this.queues.RESULTS,
        Buffer.from(JSON.stringify(result)),
        { persistent: true },
      );

      if (!success) {
        logger.warn("Queue is full, result message was not sent");
      }

      return success;
    } catch (error) {
      logger.error(`Error publishing result: ${error.message}`);
      this.handleDisconnect();
      return false;
    }
  }

  /**
   * Publish a log message to the logs exchange
   * @param {Object} logMessage Log message to publish
   * @returns {Promise<boolean>} Success status
   */
  async publishLog(logMessage) {
    try {
      if (!this.initialized) {
        const initSuccess = await this.initialize();
        if (!initSuccess) return false;
      }

      logger.debug(
        `Publishing log for job ${logMessage.jobId}: ${logMessage.content.substring(0, 50)}...`,
      );

      const success = this.channel.publish(
        this.queues.LOGS,
        "", // No routing key for fanout exchange
        Buffer.from(JSON.stringify(logMessage)),
        { persistent: true },
      );

      if (!success) {
        logger.warn("Exchange is full, log message was not sent");
      }

      return success;
    } catch (error) {
      logger.error(`Error publishing log: ${error.message}`);
      this.handleDisconnect();
      return false;
    }
  }

  /**
   * Publish a heartbeat to the heartbeats queue
   * @param {Object} heartbeat Heartbeat message to publish
   * @returns {Promise<boolean>} Success status
   */
  async publishHeartbeat(heartbeat) {
    try {
      if (!this.initialized) {
        const initSuccess = await this.initialize();
        if (!initSuccess) return false;
      }

      const success = this.channel.sendToQueue(
        this.queues.HEARTBEATS,
        Buffer.from(JSON.stringify(heartbeat)),
        { persistent: true },
      );

      if (!success) {
        logger.warn("Queue is full, heartbeat message was not sent");
      }

      return success;
    } catch (error) {
      logger.error(`Error publishing heartbeat: ${error.message}`);
      this.handleDisconnect();
      return false;
    }
  }

  /**
   * Start sending heartbeats at regular intervals
   * @param {number} interval Interval in milliseconds, defaults to 30 seconds
   * @returns {Promise<boolean>} Success status
   */
  startHeartbeats(interval = 30000) {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(async () => {
      try {
        // Get system metrics
        const metrics = this.collectSystemMetrics();

        // Send heartbeat
        await this.publishHeartbeat({
          vpsId: this.serverId,
          status: "online",
          timestamp: new Date().toISOString(),
          metrics,
        });
      } catch (error) {
        logger.error(`Failed to send heartbeat: ${error.message}`);
      }
    }, interval);

    logger.info(`Started sending heartbeats every ${interval / 1000} seconds`);
    return true;
  }

  /**
   * Collect system metrics for heartbeat
   * @returns {Object} System metrics
   */
  collectSystemMetrics() {
    try {
      // Get CPU load average (last 1, 5, and 15 minutes)
      const loadAvg = os.loadavg();

      // Get memory usage
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const memoryUsage = ((totalMem - freeMem) / totalMem) * 100;

      // Get uptime in seconds
      const uptime = os.uptime();

      // TODO: Add disk usage - requires additional libraries or shell commands
      // For now, using a placeholder
      const diskUsage = 0;

      // CPU usage is complicated to get accurately in Node.js
      // For now, using a simple estimation based on load average
      const cpuCount = os.cpus().length;
      const cpuUsage = (loadAvg[0] / cpuCount) * 100;

      return {
        cpu: parseFloat(cpuUsage.toFixed(1)),
        memory: parseFloat(memoryUsage.toFixed(1)),
        disk: parseFloat(diskUsage.toFixed(1)),
        uptime: Math.floor(uptime),
        load: loadAvg.map((load) => parseFloat(load.toFixed(2))),
      };
    } catch (error) {
      logger.error(`Error collecting system metrics: ${error.message}`);
      return {
        cpu: 0,
        memory: 0,
        disk: 0,
        uptime: 0,
        load: [0, 0, 0],
      };
    }
  }

  /**
   * Consume messages from the commands queue
   * @param {Function} callback Function to call with received messages
   * @returns {Promise<Object>} Consumer tag
   */
  async consumeCommands(callback) {
    try {
      if (!this.initialized) {
        const initSuccess = await this.initialize();
        if (!initSuccess) {
          throw new Error("Failed to initialize queue service");
        }
      }

      logger.info(`Starting to consume messages from ${this.queues.COMMANDS}`);

      return this.channel.consume(
        this.queues.COMMANDS,
        async (message) => {
          if (!message) return;

          try {
            const job = JSON.parse(message.content.toString());
            logger.info(`Processing job: ${job.id} of type ${job.actionType}`);

            await this.publishLog({
              jobId: job.id,
              content: `Starting processing of job ${job.id} (${job.actionType})`,
              timestamp: new Date().toISOString(),
            });

            try {
              await callback(job);

              // Acknowledge the message - we've processed it successfully
              this.channel.ack(message);

              logger.info(`Job ${job.id} processed successfully`);
            } catch (error) {
              logger.error(`Error processing command: ${error.message}`);

              // Send error result
              await this.publishResult({
                jobId: job.id,
                status: "FAILED",
                error: error.message,
              });

              // Log the error
              await this.publishLog({
                jobId: job.id,
                content: `Job failed: ${error.message}`,
                timestamp: new Date().toISOString(),
              });

              // Negative acknowledgment, message goes back to queue
              // if we've tried fewer than 3 times (using message.fields.deliveryTag as a counter)
              if (message.fields.deliveryTag < 3) {
                this.channel.nack(message, false, true);
                logger.warn(
                  `Job ${job.id} failed, returning to queue for retry (attempt ${message.fields.deliveryTag})`,
                );
              } else {
                // If we've tried 3 times, just acknowledge and move on
                logger.warn(
                  `Job ${job.id} failed after multiple attempts, acknowledging`,
                );
                this.channel.ack(message);
              }
            }
          } catch (parseError) {
            logger.error(`Error parsing message: ${parseError.message}`);
            // Bad message format, just acknowledge it
            this.channel.ack(message);
          }
        },
        { noAck: false },
      );
    } catch (error) {
      logger.error(`Error consuming commands: ${error.message}`);
      this.handleDisconnect();
      throw error;
    }
  }
}

module.exports = new QueueService();
