const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");

/**
 * MongoDB Connection Utility for HAProxy TLS termination
 *
 * This utility provides a secure connection to MongoDB with TLS enabled by default.
 * After the migration from Traefik to HAProxy, TLS termination is handled by HAProxy.
 * The SNI-based routing is used to direct traffic to the correct MongoDB instance.
 */
class MongoConnection {
  constructor() {
    // Get configuration from environment variables
    this.host = process.env.MONGO_HOST || "localhost";
    this.port = process.env.MONGO_PORT || "27017";
    this.username = process.env.MONGO_MANAGER_USERNAME;
    this.password = process.env.MONGO_MANAGER_PASSWORD;
    this.database = process.env.MONGO_DATABASE || "admin";
    this.useTls = process.env.MONGO_USE_TLS !== "false"; // Default to true
    this.serverId = process.env.SERVER_ID || "dev-server-id";
    this.mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";

    // TLS certificate paths
    const isDev = process.env.NODE_ENV === "development";
    const basePath = isDev
      ? path.join(__dirname, "..", "dev-cloudlunacy")
      : "/opt/cloudlunacy";

    this.certsDir = process.env.MONGO_CERTS_DIR || path.join(basePath, "certs");
    this.caPath =
      process.env.MONGO_CA_PATH || path.join(this.certsDir, "ca.crt");

    // Connection instance
    this.client = null;
    this.db = null;
  }

  /**
   * Get MongoDB connection URI
   * @returns {string} MongoDB connection URI
   */
  getUri() {
    const credentials =
      this.username && this.password
        ? `${this.username}:${this.password}@`
        : "";

    // IMPORTANT FIX: Always use the agent subdomain format for HAProxy routing
    // This enables SNI-based routing to reach the correct MongoDB instance
    const host = `${this.serverId}.${this.mongoDomain}`;

    // Add proper TLS parameters for HAProxy-proxied connections
    const tlsParams = this.useTls
      ? "?tls=true&tlsAllowInvalidCertificates=true&directConnection=true"
      : "?directConnection=true";

    const uri = `mongodb://${credentials}${host}:${this.port}/${this.database}${tlsParams}`;
    logger.debug(`Generated MongoDB URI: ${uri.replace(/:[^:]*@/, ":***@")}`);

    return uri;
  }

  /**
   * Get TLS options for MongoDB connection
   *
   * With HAProxy, we don't need to verify certificates on the agent side
   * because HAProxy handles TLS termination
   *
   * @returns {Object} TLS options
   */
  getTlsOptions() {
    if (!this.useTls) {
      return {};
    }

    // With HAProxy, we allow invalid certificates and hostnames
    // because TLS verification is handled by HAProxy
    return {
      tlsAllowInvalidCertificates: true,
      tlsAllowInvalidHostnames: true,
    };
  }

  /**
   * Connect to MongoDB through HAProxy
   * @returns {Promise<MongoClient>} MongoDB client
   */
  async connect() {
    if (this.client) {
      return this.client;
    }

    const uri = this.getUri();
    const options = {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000, // Increase socket timeout
      connectTimeoutMS: 10000, // Increase connect timeout
      maxPoolSize: 5, // Limit pool size for better management
      retryWrites: false, // Disable retry writes for initial connection
      ...this.getTlsOptions(),
    };

    // Log connection details for troubleshooting
    logger.info(
      `Connecting to MongoDB through HAProxy at ${this.serverId}.${
        this.mongoDomain
      }:${this.port} with TLS ${this.useTls ? "enabled" : "disabled"}`,
    );

    // Log the DNS hostname resolution for troubleshooting
    try {
      const { execSync } = require("child_process");
      const hostname = `${this.serverId}.${this.mongoDomain}`;
      const dnsOutput = execSync(
        `dig +short ${hostname} || echo "DNS resolution failed"`,
      )
        .toString()
        .trim();
      logger.info(
        `DNS resolution for ${hostname}: ${dnsOutput || "No records found"}`,
      );
    } catch (dnsErr) {
      logger.warn(
        `Could not resolve DNS for MongoDB hostname: ${dnsErr.message}`,
      );
    }

    try {
      // Create a new MongoDB client
      this.client = new MongoClient(uri, options);

      // Try to establish a connection
      await this.client.connect();
      this.db = this.client.db(this.database);

      // Test the connection with a simple command
      await this.db.command({ ping: 1 });

      logger.info("Successfully connected to MongoDB through HAProxy");
      return this.client;
    } catch (error) {
      logger.error(`Failed to connect to MongoDB: ${error.message}`);

      // Provide more detailed error information for troubleshooting
      if (error.message.includes("ECONNREFUSED")) {
        logger.error(
          `Connection refused: Make sure HAProxy is running and listening on port ${this.port}`,
        );
        logger.error(
          `Also verify that the HAProxy configuration has the MongoDB frontend enabled`,
        );
      } else if (error.message.includes("ETIMEDOUT")) {
        logger.error(
          `Connection timeout: Check network connectivity and firewall settings`,
        );
      } else if (
        error.message.includes("certificate") ||
        error.message.includes("TLS")
      ) {
        logger.error(
          `TLS certificate error: Check HAProxy SSL configuration and agent certificates`,
        );

        // Try connecting without TLS as a fallback if TLS fails
        if (this.useTls) {
          logger.info("Attempting fallback connection without TLS...");
          try {
            // Set a flag for this connection attempt only
            this.useTls = false;
            const noTlsUri = this.getUri();
            const noTlsOptions = {
              serverSelectionTimeoutMS: 5000,
              socketTimeoutMS: 10000,
              connectTimeoutMS: 10000,
            };

            const tempClient = new MongoClient(noTlsUri, noTlsOptions);
            await tempClient.connect();
            const response = await tempClient
              .db(this.database)
              .command({ ping: 1 });
            await tempClient.close();

            logger.info(
              "Fallback connection without TLS succeeded. Please check your TLS configuration.",
            );
            logger.info(
              "You may need to update your environment to set MONGO_USE_TLS=false if TLS is not properly configured.",
            );

            // Reset the flag after the attempt
            this.useTls = true;
          } catch (fallbackErr) {
            logger.error(
              `Fallback connection also failed: ${fallbackErr.message}`,
            );
            // Reset the flag after the attempt
            this.useTls = true;
          }
        }
      }

      throw error;
    }
  }

  // ... existing code ...
}

// Export singleton instance
module.exports = new MongoConnection();
