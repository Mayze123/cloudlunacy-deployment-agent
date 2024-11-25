const { MongoClient } = require("mongodb");
const logger = require("./utils/logger");

class MongoManager {
  constructor() {
    // Root credentials from environment
    this.rootUsername = process.env.MONGO_INITDB_ROOT_USERNAME;
    this.rootPassword = process.env.MONGO_INITDB_ROOT_PASSWORD;

    // Management credentials
    this.managerUsername = process.env.MONGO_MANAGER_USERNAME;
    this.managerPassword = process.env.MONGO_MANAGER_PASSWORD;

    const mongoHost = process.env.MONGO_HOST || "mongodb.cloudlunacy.uk";
    const mongoPort = process.env.MONGO_PORT || "27017";

    // Common TLS options
    this.commonOptions = {
      tls: true,
      tlsCertificateKeyFile:
        "/etc/letsencrypt/live/mongodb.cloudlunacy.uk/combined.pem",
      tlsCAFile: "/etc/letsencrypt/live/mongodb.cloudlunacy.uk/chain.pem",
      tlsAllowInvalidHostnames: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
    };

    this.client = null;
    this.isInitialized = false;
  }

  async waitForMongoDB() {
    logger.info("Waiting for MongoDB to be ready...");
    const maxAttempts = 30;
    const retryDelay = 2000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Try to connect with root credentials
        const uri = `mongodb://${this.rootUsername}:${this.rootPassword}@mongodb:27017/admin`;
        const tempClient = new MongoClient(uri, this.commonOptions);

        await tempClient.connect();
        await tempClient.db("admin").command({ ping: 1 });
        await tempClient.close();

        logger.info("MongoDB is ready!");
        return true;
      } catch (error) {
        if (attempt === maxAttempts) {
          throw new Error(
            `MongoDB failed to become ready after ${maxAttempts} attempts`
          );
        }
        logger.info(
          `Attempt ${attempt}/${maxAttempts} - Waiting for MongoDB...`
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }

  async initializeManagerUser() {
    if (this.isInitialized) return;

    try {
      // Wait for MongoDB to be ready first
      await this.waitForMongoDB();

      // Connect with root credentials
      const rootUri = `mongodb://${this.rootUsername}:${this.rootPassword}@mongodb:27017/admin`;
      const rootClient = new MongoClient(rootUri, this.commonOptions);
      await rootClient.connect();

      const adminDb = rootClient.db("admin");

      // Check if management user already exists
      const users = await adminDb.command({ usersInfo: this.managerUsername });
      if (users.users.length > 0) {
        logger.info("Management user already exists");
      } else {
        // Create the management user
        await adminDb.addUser(this.managerUsername, this.managerPassword, {
          roles: [
            { role: "userAdminAnyDatabase", db: "admin" },
            { role: "readWriteAnyDatabase", db: "admin" },
          ],
          mechanisms: ["SCRAM-SHA-256"],
        });
        logger.info("Management user created successfully");
      }

      await rootClient.close();
      this.isInitialized = true;
    } catch (error) {
      logger.error("Failed to initialize manager user:", error);
      throw error;
    }
  }

  async connect() {
    if (!this.isInitialized) {
      await this.initializeManagerUser();
    }

    if (!this.client) {
      const uri = `mongodb://${this.managerUsername}:${this.managerPassword}@mongodb:27017/?authSource=admin`;
      this.client = new MongoClient(uri, this.commonOptions);
    }

    if (!this.client.isConnected()) {
      await this.client.connect();
      logger.info("Successfully connected to MongoDB with management user");
    }
    return this.client;
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
