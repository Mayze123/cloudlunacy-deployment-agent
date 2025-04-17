const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");

/**
 * MongoDB Connection Utility for HAProxy TLS termination
 *
 * This utility provides a secure connection to MongoDB with TLS enabled.
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
    // TLS is always enabled - no longer optional
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

    // Check certificate existence right at initialization
    this.checkCertificateFiles();
  }

  /**
   * Check if certificate files exist and log their status
   */
  checkCertificateFiles() {
    try {
      const certFiles = {
        ca: this.caPath,
        server_cert: path.join(this.certsDir, "server.crt"),
        server_key: path.join(this.certsDir, "server.key"),
        server_pem: path.join(this.certsDir, "server.pem"),
      };

      for (const [type, filePath] of Object.entries(certFiles)) {
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          logger.info(
            `Certificate ${type} exists at ${filePath} (${stats.size} bytes)`,
          );
        } else {
          logger.warn(`Certificate ${type} does not exist at ${filePath}`);
        }
      }
    } catch (error) {
      logger.error(`Error checking certificate files: ${error.message}`);
    }
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

    // IMPORTANT: Always use the agent subdomain format for HAProxy routing
    // This enables SNI-based routing to reach the correct MongoDB instance
    // Format: {agentId}.mongodb.cloudlunacy.uk
    const host = `${this.serverId}.${this.mongoDomain}`;

    // TLS is always enabled with HAProxy Data Plane API
    const tlsParams =
      "?tls=true&tlsAllowInvalidCertificates=true&directConnection=true";

    const uri = `mongodb://${credentials}${host}:${this.port}/${this.database}${tlsParams}`;
    logger.debug(`Generated MongoDB URI: ${uri.replace(/:[^:]*@/, ":***@")}`);

    return uri;
  }

  /**
   * Get TLS options for MongoDB connection
   *
   * With HAProxy Data Plane API, we don't need to verify certificates on the agent side
   * because HAProxy handles TLS termination
   *
   * @returns {Object} TLS options
   */
  getTlsOptions() {
    const tlsOptions = {
      tlsAllowInvalidCertificates: true,
      tlsAllowInvalidHostnames: true,
    };

    // Check and add CA certificate if it exists
    if (fs.existsSync(this.caPath)) {
      try {
        tlsOptions.tlsCAFile = this.caPath;
        logger.info(`Using CA certificate from: ${this.caPath}`);

        // Log the first few lines of the cert for verification
        const certContent = fs.readFileSync(this.caPath, "utf8");
        logger.info(
          `CA certificate begins with: ${certContent.substring(0, 50)}...`,
        );
      } catch (error) {
        logger.error(`Error loading CA certificate: ${error.message}`);
      }
    } else {
      logger.warn(`CA certificate file not found at: ${this.caPath}`);
    }

    return tlsOptions;
  }

  /**
   * Connect to MongoDB through HAProxy
   * @returns {Promise<MongoClient>} MongoDB client
   */
  async connect() {
    if (
      this.client &&
      this.client.topology &&
      this.client.topology.isConnected()
    ) {
      return this.client;
    }

    // Reset state if a previous attempt failed
    this.client = null;
    this.db = null;

    const uri = this.getUri();
    const tlsOptions = this.getTlsOptions();
    const options = {
      serverSelectionTimeoutMS: 30000, // Increased from 5000 to 30000
      socketTimeoutMS: 30000, // Increased from 10000 to 30000
      connectTimeoutMS: 30000, // Increased from 10000 to 30000
      maxPoolSize: 5, // Limit pool size for better management
      retryWrites: false, // Disable retry writes for initial connection
      ...tlsOptions,
    };

    // Log connection details for troubleshooting
    logger.info(
      `Connecting to MongoDB through HAProxy at ${this.serverId}.${
        this.mongoDomain
      }:${this.port} with TLS enabled`,
    );
    logger.info(`Using URI: ${uri.replace(/:[^:]*@/, ":***@")}`);
    logger.info(
      `Connection options: ${JSON.stringify({
        ...options,
        tlsCAFile: options.tlsCAFile ? "[set]" : "[not set]",
      })}`,
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

    // First attempt - Standard connection through HAProxy with TLS
    try {
      logger.info(
        "Attempting primary connection strategy: Through HAProxy with TLS",
      );
      // Create a new MongoDB client
      this.client = new MongoClient(uri, options);

      // Try to establish a connection
      await this.client.connect();

      // Verify connection with a ping before setting the db
      const adminDb = this.client.db("admin");
      await adminDb.command({ ping: 1 });

      // Only set this.db after successful connection verification
      this.db = this.client.db(this.database);

      logger.info("Successfully connected to MongoDB through HAProxy");
      return this.client;
    } catch (error) {
      logger.error(`First connection strategy failed: ${error.message}`);

      // Detailed error logging
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
      }

      // Reset client for next attempt
      if (this.client) {
        try {
          await this.client.close();
        } catch (closeErr) {
          // Ignore close errors
        }
        this.client = null;
      }

      // Second attempt - Try direct connection with TLS
      try {
        // Try connecting directly to the resolved IP with TLS
        logger.info(
          "Attempting fallback connection strategy: Direct IP with TLS",
        );

        // Get the IP from DNS resolution
        const { execSync } = require("child_process");
        const hostname = `${this.serverId}.${this.mongoDomain}`;
        const ip = execSync(`dig +short ${hostname}`).toString().trim();

        if (!ip) {
          logger.error(
            "Failed to resolve hostname to IP for direct connection",
          );
          throw new Error("DNS resolution failed");
        }

        // Build direct connection URI with IP
        const directUri = `mongodb://${
          this.username && this.password
            ? `${this.username}:${this.password}@`
            : ""
        }${ip}:${this.port}/${this.database}?tls=true&tlsAllowInvalidCertificates=true&directConnection=true`;

        logger.info(
          `Trying direct connection to IP: ${ip} (URI: ${directUri.replace(/:[^:]*@/, ":***@")})`,
        );

        this.client = new MongoClient(directUri, options);
        await this.client.connect();

        // Verify connection
        const adminDb = this.client.db("admin");
        await adminDb.command({ ping: 1 });

        this.db = this.client.db(this.database);
        logger.info(
          "Successfully connected to MongoDB using direct IP with TLS",
        );
        return this.client;
      } catch (directError) {
        logger.error(
          `Direct IP connection with TLS failed: ${directError.message}`,
        );

        // Reset client for next attempt
        if (this.client) {
          try {
            await this.client.close();
          } catch (closeErr) {
            // Ignore close errors
          }
          this.client = null;
        }

        // Third attempt - Try connection without TLS
        try {
          logger.info(
            "Attempting final fallback strategy: Connection without TLS",
          );

          // Build non-TLS URI
          const nonTlsUri = `mongodb://${
            this.username && this.password
              ? `${this.username}:${this.password}@`
              : ""
          }${this.serverId}.${this.mongoDomain}:${this.port}/${this.database}?directConnection=true`;

          logger.info(
            `Trying connection without TLS: ${nonTlsUri.replace(/:[^:]*@/, ":***@")}`,
          );

          // Modified options without TLS
          const nonTlsOptions = {
            ...options,
            tls: false,
            tlsAllowInvalidCertificates: false,
            tlsAllowInvalidHostnames: false,
          };

          this.client = new MongoClient(nonTlsUri, nonTlsOptions);
          await this.client.connect();

          // Verify connection
          const adminDb = this.client.db("admin");
          await adminDb.command({ ping: 1 });

          this.db = this.client.db(this.database);
          logger.info("Successfully connected to MongoDB without TLS");
          return this.client;
        } catch (nonTlsError) {
          logger.error(`Non-TLS connection failed: ${nonTlsError.message}`);
          // All connection strategies have failed
          this.client = null;
          this.db = null;
          throw error; // Throw the original error
        }
      }
    }
  }

  /**
   * Close the MongoDB connection and reset state
   */
  async close() {
    try {
      if (this.client) {
        await this.client.close();
        logger.info("MongoDB client connection closed");
      }
    } catch (error) {
      logger.warn(`Error closing MongoDB connection: ${error.message}`);
    } finally {
      this.client = null;
      this.db = null;
    }
  }

  // ... existing code ...
}

// Export singleton instance
module.exports = new MongoConnection();
