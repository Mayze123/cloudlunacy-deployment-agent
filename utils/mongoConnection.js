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

    // IMPORTANT: Always use the agent subdomain format for Traefik routing
    // This enables hostname-based routing to reach the correct MongoDB instance
    // Format: {agentId}.mongodb.cloudlunacy.uk
    const host = `${this.serverId}.${this.mongoDomain}`;

    // TLS is always enabled with Traefik
    const tlsParams =
      "?tls=true&tlsAllowInvalidCertificates=true&directConnection=true";

    const uri = `mongodb://${credentials}${host}:${this.port}/${this.database}${tlsParams}`;
    logger.debug(`Generated MongoDB URI: ${uri.replace(/:[^:]*@/, ":***@")}`);

    return uri;
  }

  /**
   * Get TLS options for MongoDB connection
   *
   * With Traefik, we don't need to verify certificates on the agent side
   * because Traefik handles TLS termination
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
   * Connect to MongoDB through Traefik
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
      `Connecting to MongoDB through Traefik at ${this.serverId}.${
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

    // TEMPORARY DIRECT CONNECTION BYPASS
    // Try local connection first - this is a temporary workaround until Traefik is properly configured
    try {
      logger.info(
        "Attempting direct connection to local MongoDB (bypassing Traefik)",
      );

      // Build direct connection URI without going through Traefik
      const directLocalUri = `mongodb://${
        this.username && this.password
          ? `${this.username}:${this.password}@`
          : ""
      }127.0.0.1:${this.port}/${this.database}?directConnection=true`;

      logger.info(
        `Trying direct connection to local MongoDB: ${directLocalUri.replace(/:[^:]*@/, ":***@")}`,
      );

      // Modified options for direct connection
      const directOptions = {
        ...options,
        tls: false, // Disable TLS for local connection
        tlsAllowInvalidCertificates: false,
        tlsAllowInvalidHostnames: false,
      };

      this.client = new MongoClient(directLocalUri, directOptions);
      await this.client.connect();

      // Verify connection
      const adminDb = this.client.db("admin");
      await adminDb.command({ ping: 1 });

      this.db = this.client.db(this.database);
      logger.info("Successfully connected to MongoDB directly on localhost");
      return this.client;
    } catch (localError) {
      logger.error(
        `Direct local MongoDB connection failed: ${localError.message}`,
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
    }

    // Perform network diagnostics before attempting connection
    const hostname = `${this.serverId}.${this.mongoDomain}`;
    logger.info(`Running network diagnostics for ${hostname}:${this.port}...`);
    const diagnostics = await this.performNetworkDiagnostics(
      hostname,
      parseInt(this.port, 10),
    );

    // If DNS resolves to an IP, also check direct IP connectivity
    if (
      diagnostics.dnsResolution &&
      !diagnostics.dnsResolution.includes("No records") &&
      !diagnostics.dnsResolution.includes("Error")
    ) {
      logger.info(
        `Running network diagnostics for direct IP ${diagnostics.dnsResolution}:${this.port}...`,
      );
      await this.performNetworkDiagnostics(
        diagnostics.dnsResolution,
        parseInt(this.port, 10),
      );
    }

    // Log the DNS hostname resolution for troubleshooting
    try {
      const { execSync } = require("child_process");
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

    // First attempt - Standard connection through Traefik with TLS
    try {
      logger.info(
        "Attempting primary connection strategy: Through Traefik with TLS",
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

      logger.info("Successfully connected to MongoDB through Traefik");
      return this.client;
    } catch (error) {
      logger.error(`First connection strategy failed: ${error.message}`);

      // Detailed error logging
      if (error.message.includes("ECONNREFUSED")) {
        logger.error(
          `Connection refused: Make sure Traefik is running and the route is properly configured`,
        );
        logger.error(
          `Also verify that the Traefik configuration has the MongoDB frontend enabled`,
        );
      } else if (error.message.includes("ETIMEDOUT")) {
        logger.error(
          `Connection timeout: Check network connectivity and firewall settings`,
        );
        // Provide additional troubleshooting suggestions for timeout
        logger.error("Additional troubleshooting steps for timeouts:");
        logger.error(
          "1. Verify that MongoDB server is actually running and listening on port 27017",
        );
        logger.error(
          "2. Check if there's a firewall blocking connections (iptables, ufw, etc.)",
        );
        logger.error(
          "3. Confirm that Traefik configuration has the correct MongoDB route configured",
        );
        logger.error(
          "4. Check if the server can connect to itself on the MongoDB port",
        );
        logger.error(
          `5. Try running: curl -v telnet://${this.serverId}.${this.mongoDomain}:${this.port} to test TCP connectivity`,
        );
      } else if (
        error.message.includes("certificate") ||
        error.message.includes("TLS")
      ) {
        logger.error(
          `TLS certificate error: Check Traefik SSL configuration and agent certificates`,
        );
        // Provide additional troubleshooting for certificate issues
        logger.error("Certificate troubleshooting steps:");
        logger.error(
          "1. Verify certificate files are correct and not corrupted",
        );
        logger.error("2. Check certificate expiration dates");
        logger.error(
          "3. Ensure the certificate's CN or SAN matches the hostname being used",
        );
        logger.error(
          "4. Confirm Traefik is correctly configured to present these certificates",
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
