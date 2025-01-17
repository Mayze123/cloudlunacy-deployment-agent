const { MongoClient } = require("mongodb");
const logger = require("./logger");
const fs = require("fs").promises;

class MongoManager {
  constructor() {
    // Root credentials - used only for initial setup
    this.rootUsername = process.env.MONGO_INITDB_ROOT_USERNAME;
    this.rootPassword = process.env.MONGO_INITDB_ROOT_PASSWORD;

    // Manager credentials
    this.managerUsername = process.env.MONGO_MANAGER_USERNAME;
    this.managerPassword = process.env.MONGO_MANAGER_PASSWORD;

    // MongoDB connection settings
    this.mongoHost = process.env.MONGO_HOST || "mongodb.cloudlunacy.uk";
    this.mongoPort = process.env.MONGO_PORT || "27017";

    // TLS settings
    this.caFile = process.env.MONGODB_CA_FILE || "/etc/ssl/mongo/chain.pem";

    this.client = null;
    this.isInitialized = false;
  }

  async checkCertificates() {
    try {
      for (const [key, path] of Object.entries(this.certPaths)) {
        const stats = await fs.stat(path);
        logger.info(`Certificate ${key}: ${path} (size: ${stats.size} bytes)`);

        if (stats.size === 0) {
          throw new Error(`Certificate file ${path} is empty`);
        }

        // Verify file permissions
        const mode = (stats.mode & parseInt("777", 8)).toString(8);
        logger.info(`Certificate ${key} permissions: ${mode}`);

        if (mode !== "644" && mode !== "640") {
          logger.warn(`Certificate ${key} has unexpected permissions: ${mode}`);
        }
      }
      return true;
    } catch (error) {
      logger.error("Certificate check failed:", error);
      throw error;
    }
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
          tls: true,
          tlsCAFile: this.caFile,
          tlsAllowInvalidCertificates: false,
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
            `Failed to connect after ${maxAttempts} attempts: ${errorMessage}`
          );
        }

        const backoffDelay = retryDelay;
        logger.info(`Waiting ${backoffDelay}ms before next attempt...`);
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
      }
    }
  }

  async initializeManagerUser() {
    if (this.isInitialized) {
      return;
    }

    let client = null;
    try {
      // Verify certificates before attempting connection
      await this.checkCertificates();

      // Wait for MongoDB to be ready
      await this.waitForMongoDB();

      const uri = `mongodb://${this.rootUsername}:${this.rootPassword}@${this.mongoHost}:${this.mongoPort}/admin`;
      client = new MongoClient(uri, {
        tls: true,
        tlsCAFile: this.certPaths.chain,
        serverSelectionTimeoutMS: 30000,
        directConnection: true,
      });

      await client.connect();
      const adminDb = client.db("admin");

      // Check if management user exists
      const users = await adminDb.command({ usersInfo: this.managerUsername });

      if (users.users.length === 0) {
        logger.info("Creating new management user...");
        await adminDb.addUser(this.managerUsername, this.managerPassword, {
          roles: [
            { role: "userAdminAnyDatabase", db: "admin" },
            { role: "readWriteAnyDatabase", db: "admin" },
            { role: "clusterMonitor", db: "admin" },
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
      if (!this.client) {
        const uri = `mongodb://${this.managerUsername}:${this.managerPassword}@${this.mongoHost}:${this.mongoPort}/admin`;

        this.client = new MongoClient(uri, {
          tls: true,
          tlsCAFile: this.caFile,
          tlsAllowInvalidCertificates: false,
          authSource: "admin",
          authMechanism: "SCRAM-SHA-256",
          directConnection: true,
          serverSelectionTimeoutMS: 5000,
        });

        await this.client.connect();
        const result = await this.client.db("admin").command({ ping: 1 });
        logger.info("Connected to MongoDB successfully", result);
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
