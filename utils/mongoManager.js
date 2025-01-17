const { MongoClient } = require("mongodb");
const logger = require("./logger");
const fs = require("fs").promises;

class MongoManager {
  constructor() {
    // Manager credentials
    this.managerUsername = process.env.MONGO_MANAGER_USERNAME;
    this.managerPassword = process.env.MONGO_MANAGER_PASSWORD;

    // Connection settings
    this.mongoHost = process.env.MONGO_HOST || "mongodb.cloudlunacy.uk";
    this.mongoPort = process.env.MONGO_PORT || "27017";

    // Certificate paths
    this.caFile = process.env.MONGODB_CA_FILE || "/etc/ssl/mongo/chain.pem";

    this.client = null;
    this.isInitialized = false;
  }

  async checkCertificates() {
    logger.info("Checking MongoDB certificates...");

    try {
      // Check if CA file exists
      const stats = await fs.stat(this.caFile);
      logger.info(`Found CA file: ${this.caFile} (size: ${stats.size} bytes)`);

      if (stats.size === 0) {
        throw new Error(`CA file ${this.caFile} is empty`);
      }

      // Read and validate certificate
      const cert = await fs.readFile(this.caFile);
      try {
        const secureContext = tls.createSecureContext({
          ca: cert,
        });
        if (!secureContext) {
          throw new Error("Failed to create secure context");
        }
        logger.info("CA file validated successfully");
      } catch (certError) {
        throw new Error(`Invalid CA file: ${certError.message}`);
      }

      return true;
    } catch (error) {
      logger.error("Certificate check failed:", error.message);
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

    try {
      // Check certificates first
      await this.checkCertificates();

      // Create MongoDB connection options
      const uri = `mongodb://${this.mongoHost}:${this.mongoPort}/admin`;
      const options = {
        auth: {
          username: this.managerUsername,
          password: this.managerPassword,
        },
        tls: true,
        tlsCAFile: this.caFile,
        authSource: "admin",
        authMechanism: "SCRAM-SHA-256",
        directConnection: true,
        serverSelectionTimeoutMS: 5000,
      };

      // Create client and test connection
      const client = new MongoClient(uri, options);
      await client.connect();

      // Verify connection with ping
      const pingResult = await client.db("admin").command({ ping: 1 });
      logger.info("Successfully connected to MongoDB", pingResult);

      // Close test connection
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
        const uri = `mongodb://${this.mongoHost}:${this.mongoPort}/admin`;

        this.client = new MongoClient(uri, {
          auth: {
            username: this.managerUsername,
            password: this.managerPassword,
          },
          tls: true,
          tlsCAFile: this.caFile,
          authSource: "admin",
          authMechanism: "SCRAM-SHA-256",
          directConnection: true,
          serverSelectionTimeoutMS: 5000,
        });

        await this.client.connect();
        logger.info("Connected to MongoDB successfully");
      }

      return this.client;
    } catch (error) {
      logger.error("Connection failed:", error.message);
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
