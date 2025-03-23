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

    // When using HAProxy, we connect via the agent subdomain
    // This is important for SNI-based routing
    const host =
      this.host === "localhost" || this.host === "127.0.0.1"
        ? `${this.serverId}.${this.mongoDomain}` // Use agent subdomain for local connections
        : this.host; // Use direct IP for external connections

    const tlsParam = this.useTls
      ? "?tls=true&directConnection=true"
      : "?directConnection=true";

    return `mongodb://${credentials}${host}:${this.port}/${this.database}${tlsParam}`;
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
      `Connecting to MongoDB through HAProxy at ${this.host}:${
        this.port
      } with TLS ${this.useTls ? "enabled" : "disabled"}`,
    );

    try {
      this.client = new MongoClient(uri, options);
      await this.client.connect();
      this.db = this.client.db(this.database);

      logger.info("Successfully connected to MongoDB through HAProxy");
      return this.client;
    } catch (error) {
      logger.error(`Failed to connect to MongoDB: ${error.message}`);
      throw error;
    }
  }

  // ... existing code ...
}

// Export singleton instance
module.exports = new MongoConnection();
