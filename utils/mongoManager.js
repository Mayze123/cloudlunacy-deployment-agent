const { MongoClient } = require("mongodb");
const logger = require("./utils/logger");
const fs = require("fs");
const path = require("path");

class MongoManager {
  constructor() {
    // Root credentials
    this.rootUsername = process.env.MONGO_INITDB_ROOT_USERNAME;
    this.rootPassword = process.env.MONGO_INITDB_ROOT_PASSWORD;

    // Manager credentials
    this.managerUsername = process.env.MONGO_MANAGER_USERNAME;
    this.managerPassword = process.env.MONGO_MANAGER_PASSWORD;

    // Certificate paths - Update these lines
    this.certPaths = {
      combined: "/etc/ssl/mongo/combined.pem",
      chain: "/etc/ssl/mongo/chain.pem",
    };

    // Connection options
    this.commonOptions = {
      tls: true,
      tlsCertificateKeyFile: this.certPaths.combined,
      tlsCAFile: this.certPaths.chain,
      tlsAllowInvalidHostnames: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
    };

    this.client = null;
    this.isInitialized = false;
  }

  async checkCertificates() {
    try {
      for (const [key, path] of Object.entries(this.certPaths)) {
        const stats = await fs.promises.stat(path);
        logger.info(`Certificate ${key}: ${path} (size: ${stats.size} bytes)`);

        if (stats.size === 0) {
          throw new Error(`Certificate file ${path} is empty`);
        }
      }
      return true;
    } catch (error) {
      logger.error("Certificate check failed:", error);
      return false;
    }
  }

  async waitForMongoDB() {
    logger.info("Waiting for MongoDB to be ready...");
    const maxAttempts = 30;
    const retryDelay = 2000;

    // Check certificates first
    const certsOk = await this.checkCertificates();
    if (!certsOk) {
      throw new Error("Certificate check failed");
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        logger.info(`Connection attempt ${attempt}/${maxAttempts}`);

        const uri = `mongodb://${this.rootUsername}:${this.rootPassword}@mongodb:27017/admin`;
        const client = new MongoClient(uri, {
          ...this.commonOptions,
          serverSelectionTimeoutMS: 5000,
        });

        await client.connect();
        await client.db("admin").command({ ping: 1 });
        await client.close();

        logger.info("Successfully connected to MongoDB");
        return true;
      } catch (error) {
        logger.warn(`Attempt ${attempt} failed:`, error.message);

        if (attempt === maxAttempts) {
          throw new Error(
            `Failed to connect after ${maxAttempts} attempts: ${error.message}`
          );
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }

  async initializeManagerUser() {
    if (this.isInitialized) {
      return;
    }

    let client = null;
    try {
      await this.waitForMongoDB();

      const uri = `mongodb://${this.rootUsername}:${this.rootPassword}@mongodb:27017/admin`;
      client = new MongoClient(uri, this.commonOptions);

      await client.connect();
      const adminDb = client.db("admin");

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
      if (client) {
        await client.close();
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
        await this.client.db("admin").command({ ping: 1 });
        logger.info("Connected to MongoDB successfully");
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
