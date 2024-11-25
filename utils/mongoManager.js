const { MongoClient } = require("mongodb");
const logger = require("./utils/logger");
const fs = require("fs");
const path = require("path");

class MongoManager {
  constructor() {
    this.managerUsername = process.env.MONGO_MANAGER_USERNAME;
    this.managerPassword = process.env.MONGO_MANAGER_PASSWORD;

    const mongoHost = process.env.MONGO_HOST || "mongodb.cloudlunacy.uk";
    const mongoPort = process.env.MONGO_PORT || "27017";

    // Construct MongoDB URI with SSL parameters
    this.mongoUri = `mongodb://${this.managerUsername}:${this.managerPassword}@${mongoHost}:${mongoPort}/?authSource=admin`;

    // Certificate paths
    const certDir = "/etc/letsencrypt/live/mongodb.cloudlunacy.uk";

    // Client options with proper SSL/TLS configuration
    this.clientOptions = {
      tls: true,
      tlsCertificateKeyFile: path.join(certDir, "combined.pem"),
      tlsCAFile: path.join(certDir, "chain.pem"),
      tlsAllowInvalidHostnames: false,
      tlsAllowInvalidCertificates: false,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
    };

    this.client = null;
  }

  async connect() {
    try {
      if (!this.client) {
        this.client = new MongoClient(this.mongoUri, this.clientOptions);
      }

      if (!this.client.isConnected()) {
        await this.client.connect();
        logger.info("Successfully connected to MongoDB with TLS");
      }
      return this.client;
    } catch (error) {
      logger.error("MongoDB connection error:", error);
      throw new Error(`Failed to connect to MongoDB: ${error.message}`);
    }
  }

  async createDatabaseAndUser(dbName, username, password) {
    let client = null;
    try {
      client = await this.connect();
      const db = client.db(dbName);

      // Create user with specific database access
      await db.addUser(username, password, {
        roles: [{ role: "readWrite", db: dbName }],
        mechanisms: ["SCRAM-SHA-256"],
      });

      logger.info(
        `Database ${dbName} and user ${username} created successfully`
      );
      return { dbName, username, password };
    } catch (error) {
      logger.error(`Error creating database and user for ${dbName}:`, error);
      throw error;
    } finally {
      if (client) {
        await this.close();
      }
    }
  }

  async close() {
    try {
      if (this.client) {
        await this.client.close();
        this.client = null;
        logger.info("MongoDB connection closed successfully");
      }
    } catch (error) {
      logger.error("Error closing MongoDB connection:", error);
      throw error;
    }
  }

  // Helper method to verify connection
  async verifyConnection() {
    try {
      const client = await this.connect();
      const adminDb = client.db("admin");
      const result = await adminDb.command({ ping: 1 });
      logger.info("MongoDB connection verified:", result);
      return result;
    } catch (error) {
      logger.error("MongoDB connection verification failed:", error);
      throw error;
    }
  }
}

module.exports = new MongoManager();
