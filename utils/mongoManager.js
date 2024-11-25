const { MongoClient } = require("mongodb");
const logger = require("./utils/logger");

class MongoManager {
  constructor() {
    this.managerUsername = process.env.MONGO_MANAGER_USERNAME;
    this.managerPassword = process.env.MONGO_MANAGER_PASSWORD;

    const mongoHost = process.env.MONGO_HOST || "mongodb.cloudlunacy.uk";
    const mongoPort = process.env.MONGO_PORT || "27017";

    // Use the Docker service name initially for internal connections
    this.mongoUri = `mongodb://${this.managerUsername}:${this.managerPassword}@mongodb:${mongoPort}/?authSource=admin`;

    this.clientOptions = {
      tls: true,
      tlsCertificateKeyFile:
        "/etc/letsencrypt/live/mongodb.cloudlunacy.uk/combined.pem",
      tlsCAFile: "/etc/letsencrypt/live/mongodb.cloudlunacy.uk/chain.pem",
      tlsAllowInvalidHostnames: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
    };

    this.client = null;
  }

  async connect() {
    if (!this.client) {
      this.client = new MongoClient(this.mongoUri, this.clientOptions);
    }

    if (!this.client.isConnected()) {
      // Add retry logic for initial connection
      let attempts = 0;
      const maxAttempts = 5;
      const retryDelay = 2000; // 2 seconds

      while (attempts < maxAttempts) {
        try {
          await this.client.connect();
          logger.info("Successfully connected to MongoDB");
          break;
        } catch (error) {
          attempts++;
          if (attempts === maxAttempts) {
            logger.error(
              "Failed to connect to MongoDB after multiple attempts:",
              error
            );
            throw error;
          }
          logger.warn(
            `Connection attempt ${attempts} failed, retrying in ${retryDelay}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }
    }
    return this.client;
  }

  async createDatabaseAndUser(dbName, username, password) {
    try {
      const client = await this.connect();
      const db = client.db(dbName);

      // Create a new user with access to the specific database
      await db.addUser(username, password, {
        roles: [{ role: "readWrite", db: dbName }],
        mechanisms: ["SCRAM-SHA-256"],
      });

      logger.info(
        `Database ${dbName} and user ${username} created successfully.`
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

  // Helper method to verify connection
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
