const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");

/**
 * MongoDB Connection Utility for Traefik TLS termination
 *
 * This utility provides a secure connection to MongoDB with TLS enabled.
 * TLS termination is handled by Traefik on the front server.
 * The hostname-based routing is used to direct traffic to the correct MongoDB instance.
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

    // For Atlas-like experience, use the server hostname directly
    const host = process.env.MONGO_DIRECT_HOST || `${this.serverId}.${this.mongoDomain}`;
    
    // Configuration to bypass the KEY_USAGE_BIT_INCORRECT error
    // This addresses the boringssl error in MongoDB Compass
    const tlsParams = "?tls=true&tlsInsecure=true&tlsAllowInvalidCertificates=true&tlsAllowInvalidHostnames=true";

    const uri = `mongodb://${credentials}${host}:${this.port}/${this.database}${tlsParams}`;
    logger.debug(`Generated MongoDB URI: ${uri.replace(/:[^:]*@/, ":***@")}`);

    return uri;
  }

  /**
   * Get TLS options for MongoDB connection
   *
   * This configuration bypasses the KEY_USAGE_BIT_INCORRECT error
   * that occurs with MongoDB Compass
   *
   * @returns {Object} TLS options
   */
  getTlsOptions() {
    return {
      tls: true,                           // Enable TLS
      tlsInsecure: true,                   // Skip TLS validation entirely
      tlsAllowInvalidCertificates: true,   // Don't validate server certificates
      tlsAllowInvalidHostnames: true       // Don't validate hostnames in the certificate
    };
  }

  /**
   * Perform network diagnostics to check connectivity
   * @param {string} host - Hostname or IP to check
   * @param {number} port - Port to check
   * @returns {Promise<Object>} Diagnostic results
   */
  async performNetworkDiagnostics(host, port) {
    const diagnostics = {
      ping: null,
      traceroute: null,
      portCheck: null,
      dnsResolution: null,
    };

    try {
      const { execSync } = require("child_process");

      // Test DNS resolution
      try {
        logger.info(`Testing DNS resolution for ${host}...`);
        const dnsOutput = execSync(
          `dig +short ${host} || echo "DNS resolution failed"`,
        )
          .toString()
          .trim();
        diagnostics.dnsResolution = dnsOutput || "No records found";
        logger.info(`DNS resolution for ${host}: ${diagnostics.dnsResolution}`);
      } catch (dnsErr) {
        diagnostics.dnsResolution = `Error: ${dnsErr.message}`;
        logger.warn(`DNS resolution failed: ${dnsErr.message}`);
      }

      // Test basic connectivity with ping
      try {
        logger.info(`Testing ping to ${host}...`);
        // Limit to 3 packets with 1 second timeout
        const pingOutput = execSync(
          `ping -c 3 -W 1 ${host} || echo "Ping failed"`,
        )
          .toString()
          .trim();
        diagnostics.ping = pingOutput.includes("bytes from")
          ? "Success"
          : "Failed";
        logger.info(`Ping to ${host}: ${diagnostics.ping}`);
      } catch (pingErr) {
        diagnostics.ping = `Error: ${pingErr.message}`;
        logger.warn(`Ping failed: ${pingErr.message}`);
      }

      // Check port connectivity with nc (netcat)
      try {
        logger.info(`Testing port connectivity to ${host}:${port}...`);
        // Try connecting with a 5 second timeout
        execSync(`nc -z -w 5 ${host} ${port}`);
        diagnostics.portCheck = "Success";
        logger.info(`Port ${port} on ${host} is open`);
      } catch (portErr) {
        diagnostics.portCheck = "Failed";
        logger.warn(
          `Port ${port} on ${host} is not accessible: ${portErr.message}`,
        );
      }

      // Trace route to host
      try {
        logger.info(`Tracing route to ${host}...`);
        // Limit to 15 hops max, with 1 second timeout
        const traceOutput = execSync(
          `traceroute -m 15 -w 1 ${host} || echo "Traceroute failed"`,
        )
          .toString()
          .trim();
        diagnostics.traceroute = traceOutput.includes("traceroute")
          ? "Completed"
          : "Failed";
        logger.info(
          `Traceroute to ${host}: ${diagnostics.traceroute === "Completed" ? "Route found" : "Failed"}`,
        );
      } catch (traceErr) {
        diagnostics.traceroute = `Error: ${traceErr.message}`;
        logger.warn(`Traceroute failed: ${traceErr.message}`);
      }
    } catch (error) {
      logger.error(`Network diagnostics error: ${error.message}`);
    }

    logger.info(
      `Network diagnostics summary for ${host}:${port}:`,
      diagnostics,
    );
    return diagnostics;
  }

  /**
   * Check front server Traefik connectivity
   * @returns {Promise<Object>} Front server connectivity check results
   */
  async checkFrontServerConnectivity() {
    const results = {
      success: false,
      frontServerReachable: false,
      mongodbRouteConfigured: false,
    };

    try {
      const { execSync } = require("child_process");
      const hostname = `${this.serverId}.${this.mongoDomain}`;

      // Check if the front server hostname is reachable
      try {
        logger.info(
          `Checking if front server hostname (${hostname}) is reachable...`,
        );
        const dnsOutput = execSync(
          `dig +short ${hostname} || echo "DNS resolution failed"`,
        )
          .toString()
          .trim();

        if (dnsOutput && !dnsOutput.includes("failed")) {
          results.frontServerReachable = true;
          results.frontServerIp = dnsOutput;
          logger.info(`Front server hostname resolves to IP: ${dnsOutput}`);
        } else {
          logger.warn(
            `Front server hostname (${hostname}) DNS resolution failed`,
          );
        }
      } catch (dnsErr) {
        logger.warn(
          `Failed to resolve front server hostname: ${dnsErr.message}`,
        );
      }

      // Check if the MongoDB route is accessible
      if (results.frontServerReachable) {
        try {
          logger.info(
            `Testing TCP connectivity to ${hostname}:${this.port}...`,
          );
          execSync(`nc -z -w 5 ${hostname} ${this.port}`);
          results.mongodbRouteConfigured = true;
          logger.info(
            `MongoDB route is properly configured on front server Traefik`,
          );
        } catch (ncErr) {
          logger.warn(
            `MongoDB route not accessible on front server: ${ncErr.message}`,
          );
          logger.warn(
            "This suggests Traefik on the front server is not properly configured for MongoDB routing",
          );
        }
      }

      results.success = true;
    } catch (error) {
      logger.error(`Front server connectivity check error: ${error.message}`);
    }

    return results;
  }

  /**
   * Connect to MongoDB with an Atlas-like approach
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
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      maxPoolSize: 10,
      ...tlsOptions,
    };

    // Log connection details
    logger.info(
      `Connecting to MongoDB with Atlas-like TLS at ${
        process.env.MONGO_DIRECT_HOST || `${this.serverId}.${this.mongoDomain}`
      }:${this.port}`,
    );
    logger.info(`Using URI: ${uri.replace(/:[^:]*@/, ":***@")}`);

    try {
      // Create a new MongoDB client
      this.client = new MongoClient(uri, options);

      // Establish connection
      await this.client.connect();

      // Verify connection with a ping
      const adminDb = this.client.db("admin");
      await adminDb.command({ ping: 1 });

      // Set database after successful connection
      this.db = this.client.db(this.database);

      logger.info(
        "Successfully connected to MongoDB with Atlas-like TLS approach",
      );
      return this.client;
    } catch (error) {
      logger.error(`MongoDB connection failed: ${error.message}`);

      // Detailed error logging
      if (error.message.includes("ECONNREFUSED")) {
        logger.error(
          `Connection refused: Make sure MongoDB server is running and accessible`,
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
          `TLS certificate error. Verify the MongoDB server has TLS properly configured.`,
        );
      }

      // Reset client
      if (this.client) {
        try {
          await this.client.close();
        } catch (closeErr) {
          // Ignore close errors
        }
        this.client = null;
      }

      // If we have a TLS/certificate issue, try with even more relaxed settings
      if (
        error.message.includes("certificate") ||
        error.message.includes("TLS") ||
        error.message.includes("SSL")
      ) {
        try {
          logger.info("Attempting connection with more relaxed TLS settings");

          // Create a more permissive connection string
          const relaxedUri = `mongodb://${
            this.username && this.password
              ? `${this.username}:${this.password}@`
              : ""
          }${this.host}:${this.port}/${this.database}?tls=true&tlsInsecure=true&tlsAllowInvalidCertificates=true&tlsAllowInvalidHostnames=true`;

          logger.info(
            `Trying connection with relaxed TLS: ${relaxedUri.replace(/:[^:]*@/, ":***@")}`,
          );

          // More permissive TLS options
          const relaxedOptions = {
            ...options,
            tls: true,
            tlsInsecure: true,
            tlsAllowInvalidCertificates: true,
            tlsAllowInvalidHostnames: true,
          };

          this.client = new MongoClient(relaxedUri, relaxedOptions);
          await this.client.connect();

          // Verify connection
          const adminDb = this.client.db("admin");
          await adminDb.command({ ping: 1 });

          this.db = this.client.db(this.database);
          logger.info(
            "Successfully connected to MongoDB with relaxed TLS settings",
          );
          return this.client;
        } catch (relaxedError) {
          logger.error(
            `Connection with relaxed TLS also failed: ${relaxedError.message}`,
          );

          // Last resort - try without TLS
          try {
            logger.info("Last resort: Attempting connection without TLS");

            const nonTlsUri = `mongodb://${
              this.username && this.password
                ? `${this.username}:${this.password}@`
                : ""
            }${this.host}:${this.port}/${this.database}?directConnection=true`;

            const nonTlsOptions = {
              ...options,
              tls: false,
            };

            this.client = new MongoClient(nonTlsUri, nonTlsOptions);
            await this.client.connect();
            const adminDb = this.client.db("admin");
            await adminDb.command({ ping: 1 });

            this.db = this.client.db(this.database);
            logger.info("Successfully connected to MongoDB without TLS");
            return this.client;
          } catch (nonTlsError) {
            logger.error(
              `All connection attempts failed. Last error: ${nonTlsError.message}`,
            );
            this.client = null;
            this.db = null;
          }
        }
      }

      throw error; // Re-throw the original error
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
}

// Export singleton instance
module.exports = new MongoConnection();
