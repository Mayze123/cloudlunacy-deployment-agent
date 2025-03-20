const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");

/**
 * MongoDB Connection Utility
 * Provides a secure connection to MongoDB with TLS enabled by default
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

    const tlsParam = this.useTls
      ? "?tls=true&directConnection=true"
      : "?directConnection=true";

    return `mongodb://${credentials}${this.host}:${this.port}/${this.database}${tlsParam}`;
  }

  /**
   * Get TLS options for MongoDB connection
   * @returns {Object} TLS options
   */
  getTlsOptions() {
    if (!this.useTls) {
      return {};
    }

    // Check if CA certificate exists
    if (!fs.existsSync(this.caPath)) {
      logger.warn(
        `CA certificate not found at ${this.caPath}. TLS verification will be disabled.`,
      );
      return {
        tlsAllowInvalidCertificates: true,
        tlsAllowInvalidHostnames: true,
      };
    }

    return {
      tlsCAFile: this.caPath,
      tlsAllowInvalidHostnames: process.env.NODE_ENV === "development", // Only in development
    };
  }

  /**
   * Connect to MongoDB
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
      `Connecting to MongoDB at ${this.host}:${this.port} with TLS ${this.useTls ? "enabled" : "disabled"}`,
    );

    try {
      this.client = new MongoClient(uri, options);
      await this.client.connect();
      this.db = this.client.db(this.database);

      logger.info("Successfully connected to MongoDB");
      return this.client;
    } catch (error) {
      logger.error(`Failed to connect to MongoDB: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get database instance
   * @returns {Promise<Db>} MongoDB database instance
   */
  async getDb() {
    if (!this.db) {
      await this.connect();
    }
    return this.db;
  }

  /**
   * Close MongoDB connection
   */
  async close() {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      logger.info("MongoDB connection closed");
    }
  }
}

// Export singleton instance
module.exports = new MongoConnection();
