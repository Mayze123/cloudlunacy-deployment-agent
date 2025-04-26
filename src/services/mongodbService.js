/**
 * MongoDB Service
 *
 * Handles MongoDB initialization and registration with the front server.
 * Uses Traefik for TLS termination and routing.
 */

const fs = require("fs").promises;
const path = require("path");
const axios = require("axios");
const logger = require("../../utils/logger");
const config = require("../config");
const mongoManager = require("../../utils/mongoManager");
const { getPublicIp } = require("../utils/networkUtils");

class MongoDBService {
  constructor() {
    this.initialized = false;
  }

  /**
   * Initialize the MongoDB service
   * @returns {Promise<boolean>} Success status
   */
  async initialize(options = {}) {
    try {
      if (this.initialized) {
        return true;
      }

      logger.info("Initializing MongoDB service...");

      // Check if MongoDB is enabled
      if (!config.database.mongodb.enabled) {
        logger.info(
          "MongoDB is not enabled in configuration, skipping initialization",
        );
        this.initialized = true; // Mark as initialized even though we're skipping
        return true;
      }

      // Check if we should skip connection attempts - this is a new option
      if (options.skipConnectionAttempts) {
        logger.info("Skipping MongoDB connection attempts as requested");
        this.initialized = true;
        return true;
      }

      // Check if MongoDB is actually installed/running
      const isMongoRunning = await this.isMongoDBRunning();

      // Check if MongoDB is installed but not running
      if (!isMongoRunning) {
        logger.info("MongoDB is not running, checking if it's installed...");

        // Check if MongoDB container configuration exists
        const isMongoInstalled = await this.isMongoDBInstalled();

        if (isMongoInstalled) {
          logger.info(
            "MongoDB is installed but not running, starting container...",
          );

          // Start the MongoDB container
          const startResult = await this.startMongoDBContainer();
          if (startResult.success) {
            logger.info("MongoDB container started successfully");

            // Wait for MongoDB to initialize
            logger.info("Waiting for MongoDB to initialize...");
            await new Promise((resolve) => setTimeout(resolve, 5000));
          } else {
            logger.error(
              `Failed to start MongoDB container: ${startResult.message}`,
            );
            // Continue with initialization even if startup fails
          }
        } else {
          logger.info(
            "MongoDB does not appear to be installed, skipping connection attempts",
          );
        }
      }

      // Initialize the MongoDB manager - but don't try to connect yet
      const initSuccess = await mongoManager.initialize({
        skipConnection: true,
      });
      if (!initSuccess) {
        throw new Error("Failed to initialize MongoDB manager");
      }

      // Register with front server only if explicitly enabled and we have the required config
      if (
        options.registerWithFrontServer &&
        config.api.frontApiUrl &&
        config.api.jwt
      ) {
        await this.registerWithFrontServer();
      } else {
        logger.info(
          "Skipping MongoDB registration with front server - not required for current operation",
        );
      }

      this.initialized = true;
      logger.info("MongoDB service initialized successfully");
      return true;
    } catch (error) {
      logger.error(`Failed to initialize MongoDB service: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if MongoDB is actually running
   * @returns {Promise<boolean>} Whether MongoDB is running
   */
  async isMongoDBRunning() {
    try {
      const { execSync } = require("child_process");

      // First check for MongoDB Docker container
      try {
        logger.info("Checking for MongoDB Docker container...");
        const dockerOutput = execSync("docker ps | grep mongo").toString();

        if (dockerOutput.includes("mongo")) {
          logger.info("MongoDB Docker container is running");
          return true;
        }
      } catch (dockerErr) {
        logger.info("No MongoDB Docker container detected");
      }

      // Then check for local MongoDB process
      try {
        logger.info("Checking for local MongoDB process...");
        const output = execSync(
          "ps aux | grep -v grep | grep mongod",
        ).toString();

        if (output.includes("mongod")) {
          logger.info("Local MongoDB process is running");
          return true;
        }
      } catch (psErr) {
        logger.info("No local MongoDB process detected");
      }

      // Check if port 27017 is in use as a final check
      try {
        logger.info("Checking if port 27017 is in use...");
        const lsofOutput = execSync("lsof -i :27017 | grep LISTEN").toString();

        if (lsofOutput.length > 0) {
          logger.info("Port 27017 is in use, assuming MongoDB is running");
          return true;
        }
      } catch (lsofErr) {
        logger.info("Port 27017 is not in use");
      }

      logger.info("MongoDB is not running");
      return false;
    } catch (error) {
      // If all commands fail, MongoDB is likely not running
      logger.info(
        "Error checking MongoDB status, assuming it's not running: " +
          error.message,
      );
      return false;
    }
  }

  /**
   * Check if MongoDB is installed
   * @returns {Promise<boolean>} Whether MongoDB is installed
   */
  async isMongoDBInstalled() {
    try {
      const fs = require("fs").promises;

      // Check if the MongoDB docker-compose file exists
      const dockerComposePath = "/opt/cloudlunacy/mongodb/docker-compose.yml";
      try {
        await fs.access(dockerComposePath, fs.constants.F_OK);
        logger.info("MongoDB docker-compose configuration found");
        return true;
      } catch (err) {
        // Check alternative docker-compose location
        const altDockerComposePath =
          "/opt/cloudlunacy/docker-compose.mongodb.yml";
        try {
          await fs.access(altDockerComposePath, fs.constants.F_OK);
          logger.info(
            "MongoDB docker-compose configuration found at alternative location",
          );
          return true;
        } catch (err) {
          logger.info("MongoDB docker-compose configuration not found");
          return false;
        }
      }
    } catch (error) {
      logger.error(`Error checking if MongoDB is installed: ${error.message}`);
      return false;
    }
  }

  /**
   * Register MongoDB with the front server
   * @returns {Promise<boolean>} Success status
   */
  async registerWithFrontServer() {
    try {
      logger.info("Registering MongoDB with front server (Traefik)...");

      // Skip in development mode
      if (config.isDevelopment) {
        logger.info("Development mode: Using mock MongoDB registration");
        return true;
      }

      // Get the public IP address for registration
      const publicIp = await getPublicIp();

      // Use the MongoDB registration endpoint
      const response = await axios.post(
        `${config.api.frontApiUrl}/api/mongodb/register`,
        {
          agentId: config.serverId,
          targetIp: publicIp,
          targetPort: parseInt(config.database.mongodb.port, 10),
          useTls: true, // TLS is always enabled
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.api.jwt}`,
          },
        },
      );

      if (response.data && response.data.success) {
        logger.info(
          "MongoDB successfully registered with front server (Traefik)",
          {
            domain: response.data.domain,
            tlsEnabled: response.data.tlsEnabled,
            connectionString: response.data.connectionString,
          },
        );

        // Test the connection to confirm it's working
        try {
          const testConnection = await mongoManager.testConnection();
          if (testConnection.success) {
            logger.info(
              "MongoDB connection test successful after registration",
            );
          } else {
            logger.warn(
              `MongoDB connection test failed: ${testConnection.message}`,
            );
          }
        } catch (testErr) {
          logger.warn(`Error testing MongoDB connection: ${testErr.message}`);
        }

        return true;
      } else {
        logger.warn("Unexpected response when registering MongoDB", {
          response: response.data,
        });
        return false;
      }
    } catch (error) {
      logger.error(
        `Error registering MongoDB with front server: ${error.message}`,
      );
      if (error.response) {
        logger.error(
          `Response status: ${error.response.status}, data:`,
          error.response.data,
        );
      }
      return false;
    }
  }

  /**
   * Test the MongoDB connection
   * @returns {Promise<Object>} Test result
   */
  async testConnection() {
    return await mongoManager.testConnection();
  }

  /**
   * Get the MongoDB database instance
   * @returns {Promise<Object>} MongoDB database
   */
  async getDb() {
    return await mongoManager.getDb();
  }

  /**
   * Handle full MongoDB deployment process
   * @param {Object} options Deployment options
   * @returns {Promise<Object>} Deployment result
   */
  async deployMongoDB(options) {
    try {
      logger.info("Starting MongoDB deployment process...");

      // FIRST: Check if MongoDB is already installed and running
      logger.info("Checking if MongoDB is already installed and running...");
      const isMongoRunning = await this.isMongoDBRunning();

      // If MongoDB is not running, set it up BEFORE attempting any connections
      if (!isMongoRunning) {
        logger.info(
          "MongoDB is not currently running, setting up a new instance",
        );

        // Create MongoDB docker-compose configuration
        const dockerComposeResult =
          await this.createMongoDBDockerCompose(options);
        if (!dockerComposeResult.success) {
          return {
            success: false,
            message: `Failed to create MongoDB configuration: ${dockerComposeResult.message}`,
          };
        }

        // Start MongoDB container
        const startResult = await this.startMongoDBContainer();
        if (!startResult.success) {
          return {
            success: false,
            message: `Failed to start MongoDB container: ${startResult.message}`,
          };
        }

        // Wait for MongoDB to initialize
        logger.info("Waiting for MongoDB to initialize...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } else {
        logger.info("MongoDB is already running, will use existing instance");
      }

      // Now that MongoDB is definitely running, initialize the service
      if (!this.initialized) {
        logger.info("MongoDB manager initialized");
        this.initialized = true;
      }

      // Now try connecting to the local MongoDB instance directly
      logger.info("Connecting to local MongoDB instance...");
      try {
        // Build direct connection URI without going through Traefik
        const mongoClient = require("mongodb").MongoClient;
        const directLocalUri = `mongodb://127.0.0.1:${options.port || 27017}/admin?directConnection=true`;

        const client = new mongoClient(directLocalUri, {
          serverSelectionTimeoutMS: 5000, // Short timeout for local connection
          connectTimeoutMS: 5000,
        });

        await client.connect();
        logger.info("Successfully connected to local MongoDB instance");

        // Create database and user if requested
        if (options.username && options.password) {
          try {
            logger.info(
              `Creating user ${options.username} for database ${options.dbName || "admin"}`,
            );
            const db = client.db("admin");
            await db.command({
              createUser: options.username,
              pwd: options.password,
              roles: [
                { role: "readWrite", db: options.dbName || "admin" },
                { role: "dbAdmin", db: options.dbName || "admin" },
              ],
            });
            logger.info(`Successfully created user ${options.username}`);
          } catch (userError) {
            logger.warn(`Failed to create user: ${userError.message}`);
          }
        }

        await client.close();
      } catch (localConnError) {
        logger.error(
          `Error connecting to local MongoDB: ${localConnError.message}`,
        );
      }

      // Register with front server if needed
      let registrationResult = { success: false };
      if (config.api.frontApiUrl && config.api.jwt) {
        logger.info("Registering MongoDB with front server...");
        registrationResult = await this.registerWithFrontServer();
      } else {
        logger.info("Skipping front server registration (no API URL or JWT)");
      }

      return {
        success: true,
        message: "MongoDB deployment completed successfully",
        domain: `${config.serverId}.${config.database.mongodb.domain}`,
        connectionString: `mongodb://${options.username ? options.username + ":***@" : ""}${config.serverId}.${config.database.mongodb.domain}:27017/${options.dbName || "admin"}?tls=true`,
        frontRegistration: registrationResult.success
          ? "Successful"
          : "Failed or skipped",
        localConnection: "Available at mongodb://127.0.0.1:27017/",
      };
    } catch (error) {
      logger.error(`MongoDB deployment failed: ${error.message}`);
      return {
        success: false,
        message: `MongoDB deployment failed: ${error.message}`,
      };
    }
  }

  /**
   * Create MongoDB docker-compose configuration
   * @param {Object} options Options for MongoDB setup
   * @returns {Promise<Object>} Result of configuration creation
   */
  async createMongoDBDockerCompose(options) {
    try {
      logger.info("Creating MongoDB docker-compose configuration");

      // Check directories
      const fs = require("fs").promises;
      const path = require("path");
      const { execSync } = require("child_process");

      const dirs = [
        "/opt/cloudlunacy/mongodb/data",
        "/opt/cloudlunacy/mongodb/config",
        "/opt/cloudlunacy/mongodb/logs",
      ];

      // Create required directories
      let allDirsExist = true;
      for (const dir of dirs) {
        try {
          await fs.access(dir, fs.constants.W_OK);
        } catch (err) {
          allDirsExist = false;
          await fs.mkdir(dir, { recursive: true });
        }
      }

      logger.info(
        allDirsExist
          ? "All required directories exist and are writable"
          : "Created required directories for MongoDB",
      );

      // Create docker-compose.yml file
      const dockerComposeYml = `
version: '3.8'
services:
  mongodb:
    container_name: cloudlunacy-mongodb
    image: mongo:latest
    restart: always
    ports:
      - "127.0.0.1:27017:27017"
    volumes:
      - /opt/cloudlunacy/mongodb/data:/data/db
      - /opt/cloudlunacy/mongodb/config:/data/configdb
      - /opt/cloudlunacy/mongodb/logs:/var/log/mongodb
      - /opt/cloudlunacy/certs:/etc/mongodb/certs
    environment:
      - MONGO_INITDB_ROOT_USERNAME=${options.username || ""}
      - MONGO_INITDB_ROOT_PASSWORD=${options.password || ""}
    command: mongod --bind_ip_all ${options.username && options.password ? "--auth" : ""} --tlsMode preferTLS --tlsCertificateKeyFile /etc/mongodb/certs/server.pem --tlsCAFile /etc/mongodb/certs/ca.crt --tlsAllowConnectionsWithoutCertificates
`;

      await fs.writeFile(
        "/opt/cloudlunacy/mongodb/docker-compose.yml",
        dockerComposeYml,
      );
      logger.info("Created MongoDB docker-compose configuration");

      return { success: true };
    } catch (error) {
      logger.error(`Failed to create MongoDB configuration: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Start MongoDB container
   * @returns {Promise<Object>} Result of starting the container
   */
  async startMongoDBContainer() {
    try {
      logger.info("Starting MongoDB container");

      const { exec, execSync } = require("child_process");

      // Function to execute commands and log output
      const execCommand = (command) => {
        return new Promise((resolve, reject) => {
          exec(command, (error, stdout, stderr) => {
            if (stdout) logger.info(`[stdout] ${stdout}`);
            if (stderr) logger.info(`[stderr] ${stderr}`);

            if (error) {
              logger.error(`Command error: ${error.message}`);
              reject(error);
            } else {
              resolve({ stdout, stderr });
            }
          });
        });
      };

      // First check if a MongoDB container already exists but is stopped
      try {
        logger.info("Checking for existing MongoDB containers...");
        const existingContainers = execSync(
          "docker ps -a -f name=mongodb -f name=mongo --format '{{.Names}}'",
        )
          .toString()
          .trim();

        if (existingContainers) {
          logger.info(
            `Found existing MongoDB containers: ${existingContainers}`,
          );
          const containerArray = existingContainers.split("\n");

          for (const container of containerArray) {
            // Check if container is stopped
            const containerStatus = execSync(
              `docker container inspect --format='{{.State.Status}}' ${container}`,
            )
              .toString()
              .trim();

            if (containerStatus === "exited") {
              logger.info(
                `Found stopped MongoDB container: ${container}, starting it...`,
              );
              await execCommand(`docker start ${container}`);
              logger.info(
                `Successfully started existing MongoDB container: ${container}`,
              );
              return { success: true };
            }
          }
        }
      } catch (checkError) {
        logger.warn(
          `Error checking for existing MongoDB containers: ${checkError.message}`,
        );
      }

      // If no existing container found or couldn't be started, try docker-compose
      // Check if docker-compose file exists
      const fs = require("fs");
      if (fs.existsSync("/opt/cloudlunacy/mongodb/docker-compose.yml")) {
        logger.info("Starting MongoDB using docker-compose file");
        await execCommand(
          "cd /opt/cloudlunacy/mongodb && docker-compose up -d",
        );
        logger.info("Started MongoDB container using docker-compose");
        return { success: true };
      }

      // If no docker-compose file exists in the expected location, check alternate location
      if (fs.existsSync("/opt/cloudlunacy/docker-compose.mongodb.yml")) {
        logger.info("Starting MongoDB using alternate docker-compose file");
        await execCommand(
          "cd /opt/cloudlunacy && docker-compose -f docker-compose.mongodb.yml up -d",
        );
        logger.info(
          "Started MongoDB container using alternate docker-compose file",
        );
        return { success: true };
      }

      // If we get here, we couldn't find or start a container
      logger.warn(
        "No MongoDB docker-compose file found, MongoDB might need to be deployed first",
      );
      return { success: false, message: "No MongoDB configuration found" };
    } catch (error) {
      logger.error(`Failed to start MongoDB container: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Create a database user
   * @param {string} username Username to create
   * @param {string} password Password for the user
   * @param {string} dbName Database name
   * @returns {Promise<Object>} Result of user creation
   */
  async createDatabaseUser(username, password, dbName = "admin") {
    try {
      logger.info(`Creating database user ${username} for database ${dbName}`);

      const mongoManager = require("../../utils/mongoManager");
      const result = await mongoManager.createUser(username, password, dbName, [
        "readWrite",
        "dbAdmin",
      ]);

      if (result) {
        logger.info(
          `Successfully created user ${username} for database ${dbName}`,
        );
        return { success: true };
      } else {
        throw new Error("User creation returned false");
      }
    } catch (error) {
      logger.error(`Failed to create database user: ${error.message}`);
      return { success: false, message: error.message };
    }
  }
}

module.exports = new MongoDBService();
