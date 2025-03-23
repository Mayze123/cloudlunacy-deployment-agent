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
      ...this.getTlsOptions(),
    };

    logger.info(
      `Connecting to MongoDB through HAProxy at ${this.serverId}.${
        this.mongoDomain
      }:${this.port} with TLS ${this.useTls ? "enabled" : "disabled"}`,
    );

    try {
      this.client = new MongoClient(uri, options);
      await this.client.connect();
      this.db = this.client.db(this.database);

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
      } else if (error.message.includes("certificate")) {
        logger.error(
          `TLS certificate error: Check that certificates are properly installed`,
        );
      }

      throw error;
    }
  }

  // ... existing code ...
}

// Export singleton instance
module.exports = new MongoConnection();
