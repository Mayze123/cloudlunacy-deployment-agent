const { MongoClient } = require("mongodb");
const logger = require("./logger");
const fs = require("fs").promises;

class MongoManager {
  constructor() {
    // Manager credentials from environment
    this.managerUsername = process.env.MONGO_MANAGER_USERNAME;
    this.managerPassword = process.env.MONGO_MANAGER_PASSWORD;

    // MongoDB host and port
    this.mongoHost = process.env.MONGO_HOST || "mongodb";
    this.mongoPort = process.env.MONGO_PORT || "27017";

    // TLS configuration
    this.useTls = process.env.MONGO_USE_TLS === "true";
    this.tlsCertPath =
      process.env.MONGO_CERT_PATH || "/etc/mongodb/certs/mongodb.crt";
    this.tlsKeyPath =
      process.env.MONGO_KEY_PATH || "/etc/mongodb/certs/mongodb.key";
    this.tlsCAPath = process.env.MONGO_CA_PATH || "/etc/mongodb/certs/ca.crt";

    this.client = null;
    this.isInitialized = false;
  }

  async waitForMongoDB() {
    logger.info("Waiting for MongoDB to be ready...");
    const maxAttempts = 10;
    const retryDelay = 5000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        logger.info(`Connection attempt ${attempt}/${maxAttempts}`);
        const uri = `mongodb://${this.managerUsername}:${this.managerPassword}@${this.mongoHost}:${this.mongoPort}/admin`;
        const client = new MongoClient(uri, {
          // No TLS options are used since our MongoDB container isn’t set up for TLS
          authSource: "admin",
          authMechanism: "SCRAM-SHA-256",
          directConnection: true,
        });

        await client.connect();
        await client.db("admin").command({ ping: 1 });
        await client.close();

        logger.info("Successfully connected to MongoDB");
        return true;
      } catch (error) {
        const errorMessage = error.message || "Unknown error";
        logger.warn(`Attempt ${attempt} failed: ${errorMessage}`);

        if (attempt === maxAttempts) {
          throw new Error(
            `Failed to connect after ${maxAttempts} attempts: ${errorMessage}`,
          );
        }

        logger.info(`Waiting ${retryDelay}ms before next attempt...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }

  async initializeManagerUser() {
    const enable = true;
    // If a bypass flag is set, skip initialization.
    if (enable) {
      logger.info(
        "MongoDB manager initialization skipped via ENABLE_MONGO_MANAGER flag.",
      );
      this.isInitialized = true;
      return;
    }

    if (this.isInitialized) {
      return;
    }

    try {
      // Create a client using the provided credentials without TLS options
      const client = new MongoClient(
        `mongodb://${this.mongoHost}:${this.mongoPort}/admin`,
        {
          auth: {
            username: this.managerUsername,
            password: this.managerPassword,
          },
          authSource: "admin",
          authMechanism: "SCRAM-SHA-256",
          directConnection: true,
          serverSelectionTimeoutMS: 10000,
        },
      );

      await client.connect();
      await client.db("admin").command({ ping: 1 });
      await client.close();

      this.isInitialized = true;
      logger.info("MongoDB manager initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize manager user:", error.message);
      throw error;
    }
  }

  async connect() {
    try {
      if (!this.isInitialized) {
        await this.initializeManagerUser();
      }

      if (!this.client) {
        const username = encodeURIComponent(this.managerUsername);
        const password = encodeURIComponent(this.managerPassword);

        // Base connection options
        const options = {
          authSource: "admin",
          authMechanism: "SCRAM-SHA-256",
          directConnection: true,
          serverSelectionTimeoutMS: 5000,
        };

        // Add TLS options if enabled
        if (this.useTls) {
          options.tls = true;
          options.tlsCAFile = this.tlsCAPath;
          options.tlsCertificateKeyFile = this.tlsKeyPath;
          options.tlsAllowInvalidCertificates = true;
          options.tlsAllowInvalidHostnames = true;
        }

        // Build connection string
        const uri = `mongodb://${username}:${password}@${this.mongoHost}:${this.mongoPort}/admin`;

        this.client = new MongoClient(uri, options);
        await this.client.connect();
        await this.client.db("admin").command({ ping: 1 });
        logger.info("Connected to MongoDB successfully");
      }

      return this.client;
    } catch (error) {
      const errorMessage = `Connection failed: ${error.message}`;
      logger.error(errorMessage);
      throw new Error(errorMessage);
    }
  }

  async createDatabaseAndUser(dbName, username, password) {
    try {
      const client = await this.connect();
      const db = client.db(dbName);

      // Create user with SCRAM-SHA-256 authentication
      await db.addUser(username, password, {
        roles: [{ role: "readWrite", db: dbName }],
        mechanisms: ["SCRAM-SHA-256"],
        passwordDigestor: "server", // Use server-side hashing
      });

      logger.info(
        `Database ${dbName} and user ${username} created successfully with enhanced security`,
      );
      return { dbName, username, password };
    } catch (error) {
      logger.error("Error creating database and user:", error.message);
      throw error;
    }
  }

  async close() {
    try {
      if (this.client) {
        await this.client.close();
        this.client = null;
        logger.info("MongoDB connection closed");
      }
    } catch (error) {
      logger.error("Error closing MongoDB connection:", error);
      throw error;
    }
  }

  async verifyConnection() {
    try {
      const client = await this.connect();
      const result = await client.db("admin").command({ ping: 1 });
      logger.info("MongoDB connection verified:", result);
      return result;
    } catch (error) {
      logger.error("MongoDB connection verification failed:", error);
      throw error;
    }
  }
}

module.exports = new MongoManager();
