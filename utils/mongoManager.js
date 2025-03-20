const mongoConnection = require("./mongoConnection");
const logger = require("./logger");

class MongoManager {
  constructor() {
    this.connection = mongoConnection;
  }

  /**
   * Initialize MongoDB connection
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      await this.connection.connect();
      return true;
    } catch (error) {
      logger.error(`MongoDB initialization failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Create a new database user
   * @param {string} username - Username
   * @param {string} password - Password
   * @param {string} dbName - Database name
   * @param {Array<string>} roles - User roles
   * @returns {Promise<boolean>} Success status
   */
  async createUser(username, password, dbName, roles = ["readWrite"]) {
    try {
      const db = await this.connection.getDb();

      await db.command({
        createUser: username,
        pwd: password,
        roles: roles.map((role) => ({ role, db: dbName })),
      });

      logger.info(`Created user ${username} for database ${dbName}`);
      return true;
    } catch (error) {
      logger.error(`Failed to create user ${username}: ${error.message}`);
      return false;
    }
  }

  // Add other MongoDB management methods here...

  /**
   * Close MongoDB connection
   */
  async close() {
    await this.connection.close();
  }
}

module.exports = new MongoManager();
