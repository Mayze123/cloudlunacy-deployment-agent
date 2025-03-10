const { MongoClient } = require("mongodb");
const logger = require("./logger");
const fs = require("fs").promises;

class MongoManager {
  constructor() {
    // Manager credentials from environment
    this.managerUsername = process.env.MONGO_MANAGER_USERNAME;
    this.managerPassword = process.env.MONGO_MANAGER_PASSWORD;

    // MongoDB host and port (adjust as necessary)
    // Now using container name for direct Docker network access
    this.mongoHost = process.env.MONGO_HOST || "mongodb-agent";
    this.mongoPort = process.env.MONGO_PORT || "27017";

    this.client = null;
    this.isInitialized = false;
  }

  async waitForMongoDB() {
    logger.info("Waiting for MongoDB to be ready...");
    logger.info(`Using MongoDB at ${this.mongoHost}:${this.mongoPort}`);
    const maxAttempts = 10;
    const retryDelay = 5000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        logger.info(`Connection attempt ${attempt}/${maxAttempts}`);
        const uri = `mongodb://${this.managerUsername}:${this.managerPassword}@${this.mongoHost}:${this.mongoPort}/admin`;
        const client = new MongoClient(uri, {
          // No TLS options are used since we're using Docker networking
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
      // Create a client using the provided credentials
      // Now using Docker networking with container name
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
        // Using Docker networking - no need for complicated connection strings
        const uri = `mongodb://${username}:${password}@${this.mongoHost}:${this.mongoPort}/admin`;

        this.client = new MongoClient(uri, {
          authSource: "admin",
          authMechanism: "SCRAM-SHA-256",
          directConnection: true,
          serverSelectionTimeoutMS: 5000,
        });

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
