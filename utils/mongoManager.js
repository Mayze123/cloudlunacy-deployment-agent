// mongoManager.js

const { MongoClient } = require("mongodb");
const logger = require("./utils/logger");

class MongoManager {
  constructor() {
    this.managerUsername = process.env.MONGO_MANAGER_USERNAME;
    this.managerPassword = process.env.MONGO_MANAGER_PASSWORD;

    const mongoHost = process.env.MONGO_HOST || "mongodb.cloudlunacy.uk";
    const mongoPort = process.env.MONGO_PORT || "27017";

    this.mongoUri = `mongodb://${mongoHost}:${mongoPort}`;

    this.clientOptions = {
      auth: {
        username: this.managerUsername,
        password: this.managerPassword,
      },
      tls: true,
      useUnifiedTopology: true,
    };

    this.client = new MongoClient(this.mongoUri, this.clientOptions);
  }

  async connect() {
    if (!this.client.isConnected()) {
      await this.client.connect();
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
      });

      logger.info(
        `Database ${dbName} and user ${username} created successfully.`
      );
      return { dbName, username, password };
    } catch (error) {
      logger.error("Error creating database and user:", error);
      throw error;
    } finally {
      await this.close();
    }
  }

  async close() {
    await this.client.close();
  }
}

module.exports = new MongoManager();
