const { MongoClient } = require("mongodb");
const logger = require("./utils/logger");
const fs = require("fs");

class MongoManager {
  constructor() {
    // Root credentials
    this.rootUsername = process.env.MONGO_INITDB_ROOT_USERNAME;
    this.rootPassword = process.env.MONGO_INITDB_ROOT_PASSWORD;

    // Manager credentials
    this.managerUsername = process.env.MONGO_MANAGER_USERNAME;
    this.managerPassword = process.env.MONGO_MANAGER_PASSWORD;

    // Certificate paths
    this.certPaths = {
      combined: "/etc/letsencrypt/live/mongodb.cloudlunacy.uk/combined.pem",
      chain: "/etc/letsencrypt/live/mongodb.cloudlunacy.uk/chain.pem",
    };

    // Connection options
    this.commonOptions = {
      tls: true,
      tlsCertificateKeyFile: this.certPaths.combined,
      tlsCAFile: this.certPaths.chain,
      tlsAllowInvalidHostnames: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
    };

    this.client = null;
    this.isInitialized = false;
  }

  async checkCertificates() {
    // Check if certificates exist and are readable
    try {
      await fs.promises.access(this.certPaths.combined, fs.constants.R_OK);
      await fs.promises.access(this.certPaths.chain, fs.constants.R_OK);
      logger.info("MongoDB certificates are accessible");
      return true;
    } catch (error) {
      logger.error("Certificate access error:", error);
      return false;
    }
  }

  async waitForMongoDB() {
    logger.info("Waiting for MongoDB to be ready...");
    const maxAttempts = 60; // 2 minutes with 2-second delay
    const retryDelay = 2000;

    // First ensure certificates are available
    const certsOk = await this.checkCertificates();
    if (!certsOk) {
      throw new Error("Cannot access required certificates");
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Construct root connection URI
        const uri = `mongodb://${this.rootUsername}:${this.rootPassword}@mongodb:27017/admin`;
        const tempClient = new MongoClient(uri, {
          ...this.commonOptions,
          serverSelectionTimeoutMS: 2000, // Shorter timeout for probing
        });

        await tempClient.connect();
        await tempClient.db("admin").command({ ping: 1 });
        await tempClient.close();

        logger.info("MongoDB is ready!");
        return true;
      } catch (error) {
        if (attempt === maxAttempts) {
          logger.error("Final MongoDB connection attempt failed:", error);
          throw new Error(
            `MongoDB failed to become ready after ${maxAttempts} attempts`
          );
        }
        logger.debug(
          `Attempt ${attempt}/${maxAttempts} - Waiting for MongoDB... (${error.message})`
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }

  async initializeManagerUser() {
    if (this.isInitialized) return;

    let rootClient = null;
    try {
      // Wait for MongoDB to be ready
      await this.waitForMongoDB();

      // Connect with root credentials
      const rootUri = `mongodb://${this.rootUsername}:${this.rootPassword}@mongodb:27017/admin`;
      rootClient = new MongoClient(rootUri, this.commonOptions);
      await rootClient.connect();

      // Create management user if it doesn't exist
      const adminDb = rootClient.db("admin");
      const users = await adminDb.command({ usersInfo: this.managerUsername });

      if (users.users.length === 0) {
        await adminDb.addUser(this.managerUsername, this.managerPassword, {
          roles: [
            { role: "userAdminAnyDatabase", db: "admin" },
            { role: "readWriteAnyDatabase", db: "admin" },
          ],
          mechanisms: ["SCRAM-SHA-256"],
        });
        logger.info("Management user created successfully");
      } else {
        logger.info("Management user already exists");
      }

      this.isInitialized = true;
    } catch (error) {
      logger.error("Failed to initialize manager user:", error);
      throw error;
    } finally {
      if (rootClient) {
        await rootClient.close();
      }
    }
  }

  async connect() {
    try {
      if (!this.isInitialized) {
        await this.initializeManagerUser();
      }

      if (!this.client) {
        const uri = `mongodb://${this.managerUsername}:${this.managerPassword}@mongodb:27017/?authSource=admin`;
        this.client = new MongoClient(uri, this.commonOptions);
      }

      if (!this.client.isConnected()) {
        await this.client.connect();
        logger.info("Successfully connected with management user");
      }

      return this.client;
    } catch (error) {
      logger.error("Connection failed:", error);
      throw error;
    }
  }

  async createDatabaseAndUser(dbName, username, password) {
    try {
      const client = await this.connect();
      const db = client.db(dbName);

      await db.addUser(username, password, {
        roles: [{ role: "readWrite", db: dbName }],
        mechanisms: ["SCRAM-SHA-256"],
      });

      logger.info(
        `Database ${dbName} and user ${username} created successfully`
      );
      return { dbName, username, password };
    } catch (error) {
      logger.error("Error creating database and user:", error);
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
