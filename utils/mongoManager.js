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
  }

  /**
   * Initialize MongoDB connection through HAProxy
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      logger.info("Initializing MongoDB connection through HAProxy");
      await this.connection.connect();
      logger.info(
        "MongoDB connection through HAProxy initialized successfully",
      );
      return true;
    } catch (error) {
      logger.error(`MongoDB initialization failed: ${error.message}`);
      return false;
    }
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
      const db = await this.connection.getDb();

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

      // Get admin DB
      const db = await this.connection.getDb();

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
      return false;
    }
  }

  /**
   * Close MongoDB connection
   */
  async close() {
    await this.connection.close();
  }
}

module.exports = new MongoManager();
