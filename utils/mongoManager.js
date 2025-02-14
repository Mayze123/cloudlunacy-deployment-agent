const { MongoClient } = require("mongodb");
const logger = require("./logger");
const fs = require("fs").promises;

class MongoManager {
  constructor() {
    // Manager credentials (ensure these are set in your environment)
    this.managerUsername = process.env.MONGO_MANAGER_USERNAME;
    this.managerPassword = process.env.MONGO_MANAGER_PASSWORD;

    // MongoDB host and port
    this.mongoHost = process.env.MONGO_HOST || "mongodb";
    this.mongoPort = process.env.MONGO_PORT || "27017";

    this.client = null;
    this.isInitialized = false;
  }

  /**
   * Wait for MongoDB to be ready by attempting to connect multiple times.
   */
  async waitForMongoDB() {
    logger.info("Waiting for MongoDB to be ready...");
    const maxAttempts = 10;
    const retryDelay = 5000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        logger.info(`Connection attempt ${attempt}/${maxAttempts}`);
        const uri = `mongodb://${this.managerUsername}:${this.managerPassword}@${this.mongoHost}:${this.mongoPort}/admin`;
        const client = new MongoClient(uri, {
          tls: true,
          tlsAllowInvalidCertificates: true,
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

  /**
   * Initialize (or verify) the MongoDB manager user.
   * If ENABLE_MONGO_MANAGER is "false", the initialization is skipped.
   */
  async initializeManagerUser() {
    // Check for bypass flag.
    if (process.env.ENABLE_MONGO_MANAGER === "false") {
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
      // Create a client using the provided credentials.
      const client = new MongoClient(
        `mongodb://${this.mongoHost}:${this.mongoPort}/admin`,
        {
          tls: true,
          tlsAllowInvalidCertificates: true,
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

  /**
   * Establish a connection to MongoDB.
   */
  async connect() {
    try {
      if (!this.isInitialized) {
        await this.initializeManagerUser();
      }

      if (!this.client) {
        const username = encodeURIComponent(this.managerUsername);
        const password = encodeURIComponent(this.managerPassword);
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

  /**
   * Create a new database and a user with readWrite permissions for that database.
   */
  async createDatabaseAndUser(dbName, username, password) {
    try {
      const client = await this.connect();
      const db = client.db(dbName);

      await db.addUser(username, password, {
        roles: [{ role: "readWrite", db: dbName }],
        mechanisms: ["SCRAM-SHA-256"],
      });

      logger.info(
        `Database ${dbName} and user ${username} created successfully`,
      );
      return { dbName, username, password };
    } catch (error) {
      logger.error("Error creating database and user:", error.message);
      throw error;
    }
  }

  /**
   * Close the MongoDB connection.
   */
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

  /**
   * Verify the MongoDB connection by issuing a ping command.
   */
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
