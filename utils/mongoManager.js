const mongoConnection = require("./mongoConnection");
const logger = require("./logger");

/**
 * MongoDB Manager adapted for HAProxy TLS termination
 *
 * This class manages MongoDB operations through the HAProxy connection.
 * TLS termination is handled by HAProxy.
 */
class MongoManager {
  constructor() {
    this.connection = mongoConnection;
    this.initialized = false;
    this.retryCount = 0;
    this.maxRetries = 5;
    this.retryDelay = 5000; // milliseconds
  }

  /**
   * Initialize MongoDB connection through HAProxy
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      logger.info("Initializing MongoDB connection through HAProxy");
      await this.connection.connect();
      this.initialized = true;
      this.retryCount = 0;
      logger.info(
        "MongoDB connection through HAProxy initialized successfully",
      );
      return true;
    } catch (error) {
      logger.error(`MongoDB initialization failed: ${error.message}`);

      // Add retry logic with exponential backoff
      if (this.retryCount < this.maxRetries) {
        this.retryCount++;
        const delay = this.retryDelay * Math.pow(2, this.retryCount - 1);
        logger.info(
          `Retrying MongoDB connection in ${delay / 1000} seconds (attempt ${
            this.retryCount
          }/${this.maxRetries})`,
        );

        return new Promise((resolve) => {
          setTimeout(async () => {
            const result = await this.initialize();
            resolve(result);
          }, delay);
        });
      }

      return false;
    }
  }

  /**
   * Get MongoDB database instance
   * @returns {Promise<Object>} MongoDB database
   */
  async getDb() {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.connection.db) {
      await this.connection.connect();
    }

    return this.connection.db;
  }

  /**
   * Create a new database user
   * Uses HAProxy for TLS termination and SNI-based routing
   *
   * @param {string} username - Username
   * @param {string} password - Password
   * @param {string} dbName - Database name
   * @param {Array<string>} roles - User roles
   * @returns {Promise<boolean>} Success status
   */
  async createUser(username, password, dbName, roles = ["readWrite"]) {
    try {
      logger.info(
        `Creating user ${username} for database ${dbName} through HAProxy`,
      );

      // Ensure we're connected
      if (!this.initialized) {
        await this.initialize();
      }

      const db = await this.getDb();

      await db.command({
        createUser: username,
        pwd: password,
        roles: roles.map((role) => ({ role, db: dbName })),
      });

      logger.info(
        `Created user ${username} for database ${dbName} through HAProxy`,
      );
      return true;
    } catch (error) {
      logger.error(
        `Failed to create user ${username} through HAProxy: ${error.message}`,
      );

      // If connection error, try to reinitialize
      if (
        error.message.includes("ECONNREFUSED") ||
        error.message.includes("ETIMEDOUT")
      ) {
        this.initialized = false;
        logger.info("Reinitializing connection for next attempt");
      }

      return false;
    }
  }

  /**
   * Create a new database and user
   * Uses HAProxy for TLS termination
   *
   * @param {string} dbName - Database name
   * @param {string} username - Username
   * @param {string} password - Password
   * @returns {Promise<boolean>} Success status
   */
  async createDatabaseAndUser(dbName, username, password) {
    try {
      logger.info(
        `Creating database ${dbName} and user ${username} through HAProxy`,
      );

      // Ensure we're connected
      if (!this.initialized) {
        await this.initialize();
      }

      // Get admin DB
      const db = await this.getDb();

      // Create the new database by accessing it (MongoDB creates it automatically)
      const newDb = this.connection.client.db(dbName);

      // Create a collection to ensure the database exists
      await newDb.createCollection("system.init");

      // Create user with appropriate roles
      await db.command({
        createUser: username,
        pwd: password,
        roles: [
          { role: "readWrite", db: dbName },
          { role: "dbAdmin", db: dbName },
        ],
      });

      logger.info(
        `Created database ${dbName} and user ${username} through HAProxy`,
      );
      return true;
    } catch (error) {
      logger.error(
        `Failed to create database and user through HAProxy: ${error.message}`,
      );

      // If connection error, try to reinitialize
      if (
        error.message.includes("ECONNREFUSED") ||
        error.message.includes("ETIMEDOUT")
      ) {
        this.initialized = false;
        logger.info("Reinitializing connection for next attempt");
      }

      return false;
    }
  }

  /**
   * Test MongoDB connection through HAProxy
   * @returns {Promise<{success: boolean, message: string}>} Test result
   */
  async testConnection() {
    try {
      // Ensure we're connected
      if (!this.initialized) {
        await this.initialize();
      }

      const db = await this.getDb();
      const result = await db.admin().ping();

      return {
        success: true,
        message: "MongoDB connection test successful",
        details: result,
      };
    } catch (error) {
      logger.error(`MongoDB connection test failed: ${error.message}`);
      return {
        success: false,
        message: `MongoDB connection test failed: ${error.message}`,
      };
    }
  }

  /**
   * Close MongoDB connection
   */
  async close() {
    if (this.connection.client) {
      await this.connection.client.close();
      this.initialized = false;
      logger.info("MongoDB connection closed");
    }
  }
}

module.exports = new MongoManager();
