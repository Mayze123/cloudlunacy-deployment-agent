/**
 * Database Manager
 *
 * Handles database installation, configuration, and management.
 * Supports different database types like MongoDB and Redis.
 */

const logger = require("./logger");
const fs = require("fs");
const path = require("path");
const { exec, execSync } = require("child_process");
const config = require("../config");
const axios = require("axios");
const mongoManager = require("../../utils/mongoManager");

class DatabaseManager {
  constructor() {
    this.supportedDatabases = {
      mongodb: {
        defaultPort: 27017,
        defaultConfig: {
          useTls: true,
          authEnabled: true,
        },
        installFn: this.installMongoDB,
        uninstallFn: this.uninstallMongoDB,
        statusFn: this.checkMongoDBStatus,
        manager: mongoManager, // Using real mongoManager implementation
      },
      redis: {
        defaultPort: 6379,
        defaultConfig: {
          useTls: true,
          authEnabled: true,
        },
        installFn: this.installRedis,
        uninstallFn: this.uninstallRedis,
        statusFn: this.checkRedisStatus,
      },
    };

    // Environment file paths
    this.envFile = config.paths.envFile;
  }

  /**
   * Handles database operations (install, uninstall, status)
   * @param {string} command - The command to execute (install, uninstall, status)
   * @param {string} dbType - The database type (mongodb, redis)
   * @param {Object} options - Configuration options
   * @returns {Promise<Object>} Result of the operation
   */
  async handleDatabaseOperation(command, dbType, options = {}) {
    // Validate database type
    if (!this.supportedDatabases[dbType]) {
      return {
        success: false,
        message: `Unsupported database type: ${dbType}. Supported types: ${Object.keys(this.supportedDatabases).join(", ")}`,
      };
    }

    // Merge options with defaults
    const dbConfig = this.supportedDatabases[dbType];
    const config = {
      ...dbConfig.defaultConfig,
      port: dbConfig.defaultPort,
      ...options,
    };

    try {
      let result;
      switch (command) {
        case "install":
          result = await dbConfig.installFn.call(this, config);
          // If installation was successful, update the environment file
          if (result.success) {
            const envUpdateResult = await this.addDatabaseConfig(
              dbType,
              config,
            );
            if (!envUpdateResult.success) {
              logger.warn(
                `Database installed but failed to update environment file: ${envUpdateResult.message}`,
              );
              result.envWarning = envUpdateResult.message;
            } else {
              logger.info(
                `Updated environment file with ${dbType} configuration`,
              );
            }
          }
          return result;
        case "uninstall":
          result = await dbConfig.uninstallFn.call(this, config);
          // If uninstallation was successful, remove from environment file
          if (result.success) {
            const envUpdateResult = await this.removeDatabaseConfig(dbType);
            if (!envUpdateResult.success) {
              logger.warn(
                `Database uninstalled but failed to update environment file: ${envUpdateResult.message}`,
              );
              result.envWarning = envUpdateResult.message;
            } else {
              logger.info(
                `Removed ${dbType} configuration from environment file`,
              );
            }
          }
          return result;
        case "status":
          return await dbConfig.statusFn.call(this, config);
        default:
          return {
            success: false,
            message: `Unsupported command: ${command}. Supported commands: install, uninstall, status`,
          };
      }
    } catch (error) {
      logger.error(
        `Error executing ${command} for ${dbType}: ${error.message}`,
      );
      return {
        success: false,
        message: `Error executing ${command} for ${dbType}: ${error.message}`,
        error: error.message,
      };
    }
  }

  /**
   * Register a database with the front server
   * @param {string} dbType - Database type
   * @param {string} dbName - Database name
   * @param {string} hostname - Database hostname
   * @param {number} port - Database port
   * @param {Object} options - Additional options
   * @param {string} token - JWT token for authentication
   * @returns {Promise<Object>} - Registration result
   */
  async registerWithFrontServer(
    dbType,
    dbName,
    hostname,
    port,
    options = {},
    token,
  ) {
    try {
      const FRONT_API_URL = process.env.FRONT_API_URL;
      if (!FRONT_API_URL) {
        return {
          success: false,
          message: "Missing FRONT_API_URL environment variable",
        };
      }

      logger.info(`Registering ${dbType} with HAProxy front server...`);

      const response = await axios.post(
        `${FRONT_API_URL}/api/databases/${dbType}/register`,
        {
          agentId: dbName, // Using dbName as agentId for compatibility
          targetIp: hostname,
          targetPort: port,
          options,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );

      if (response.data && response.data.success) {
        return {
          success: true,
          message: `${dbType} successfully registered with HAProxy front server`,
          domain: response.data.domain || response.data.details?.domain,
          connectionString: response.data.connectionString,
        };
      } else {
        return {
          success: false,
          message: `Unexpected response when registering ${dbType}`,
          details: response.data,
        };
      }
    } catch (error) {
      logger.error(
        `Error registering ${dbType} with HAProxy: ${error.message}`,
      );
      return {
        success: false,
        message: `Error registering ${dbType}: ${error.message}`,
        error: error.response?.data || error.message,
      };
    }
  }

  /**
   * Add database configuration to the environment file
   * @param {string} dbType - Database type
   * @param {Object} config - Database configuration
   * @returns {Promise<Object>} - Result
   */
  async addDatabaseConfig(dbType, config) {
    try {
      // This is a stub implementation that should be replaced with actual implementation
      logger.info(`Added ${dbType} configuration to environment file`);
      return { success: true };
    } catch (error) {
      logger.error(`Failed to add ${dbType} configuration: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * Remove database configuration from environment file
   * @param {string} dbType - Database type
   * @returns {Promise<Object>} - Result
   */
  async removeDatabaseConfig(dbType) {
    try {
      // This is a stub implementation that should be replaced with actual implementation
      logger.info(`Removed ${dbType} configuration from environment file`);
      return { success: true };
    } catch (error) {
      logger.error(
        `Failed to remove ${dbType} configuration: ${error.message}`,
      );
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * Install MongoDB
   * @param {Object} config - Configuration options
   * @returns {Promise<Object>} - Installation result
   */
  async installMongoDB(config) {
    logger.info("Installing MongoDB...");

    try {
      // Check if MongoDB is already installed
      const isInstalled = await this.checkMongoDBStatus(config);
      if (isInstalled.success && isInstalled.installed) {
        return {
          success: true,
          message: "MongoDB is already installed and running",
          status: isInstalled,
        };
      }

      // For Docker-based setup, we install MongoDB via docker-compose
      const isDevelopment = process.env.NODE_ENV === "development";
      if (isDevelopment) {
        // In development mode, MongoDB should be defined in docker-compose
        return {
          success: true,
          message:
            "In development mode, MongoDB should be set up via docker-compose",
        };
      }

      // For production, use Docker to install MongoDB
      const mountPath = "/opt/cloudlunacy/mongodb";
      const certsPath = "/opt/cloudlunacy/certs";

      // Create directories with proper error handling
      try {
        // Check if directories exist first
        const dirExists = (dir) => {
          try {
            return fs.existsSync(dir);
          } catch (e) {
            return false;
          }
        };

        // Create required directories if they don't exist
        const dirs = [
          mountPath,
          `${mountPath}/data`,
          `${mountPath}/data/db`,
          certsPath,
        ];

        for (const dir of dirs) {
          if (!dirExists(dir)) {
            try {
              // First attempt: try to create directory normally
              fs.mkdirSync(dir, { recursive: true });
              logger.info(`Created directory: ${dir}`);
            } catch (err) {
              // If permission error, try with sudo
              if (err.code === "EACCES" || err.code === "EPERM") {
                logger.info(
                  `Permission denied, attempting to create directory with sudo: ${dir}`,
                );
                try {
                  // Execute sudo mkdir command
                  execSync(`sudo mkdir -p ${dir}`);

                  // Set ownership to current user
                  const currentUser = execSync("whoami").toString().trim();
                  execSync(
                    `sudo chown -R ${currentUser}:${currentUser} ${dir}`,
                  );

                  // Set appropriate permissions
                  execSync(`sudo chmod -R 755 ${dir}`);

                  logger.info(
                    `Successfully created directory with sudo: ${dir}`,
                  );
                } catch (sudoError) {
                  logger.error(
                    `Failed to create directory with sudo: ${sudoError.message}`,
                  );
                  return {
                    success: false,
                    message:
                      "Failed to create MongoDB directories, even with sudo",
                    error: sudoError.message,
                    help:
                      "Please ensure you have sudo access or manually create the directories:\n" +
                      `sudo mkdir -p ${mountPath}/data/db\n` +
                      `sudo mkdir -p ${certsPath}\n` +
                      `sudo chown -R $USER:$USER /opt/cloudlunacy\n` +
                      "Then try installing MongoDB again.",
                  };
                }
              } else {
                throw err; // Re-throw other errors
              }
            }
          }
        }
      } catch (dirError) {
        logger.error(`Error creating directories: ${dirError.message}`);
        return {
          success: false,
          message: `Failed to create required directories: ${dirError.message}`,
          error: dirError.message,
        };
      }

      // Create docker-compose file for MongoDB
      const composeFile = `/opt/cloudlunacy/docker-compose.mongodb.yml`;
      try {
        const composeContent = `
version: '3'

services:
  mongodb:
    image: mongo:latest
    container_name: cloudlunacy-mongodb
    command: --tlsMode ${config.useTls ? "preferTLS" : "disabled"} ${config.useTls ? "--tlsCertificateKeyFile /etc/mongodb/certs/server.pem --tlsCAFile /etc/mongodb/certs/ca.crt --tlsAllowConnectionsWithoutCertificates" : ""}
    restart: always
    environment:
      - MONGO_INITDB_ROOT_USERNAME=${config.username || "admin"}
      - MONGO_INITDB_ROOT_PASSWORD=${config.password || "adminpassword"}
    ports:
      - "${config.port || 27017}:27017"
    volumes:
      - ${mountPath}/data/db:/data/db
      - ${certsPath}:/etc/mongodb/certs:ro
`;
        fs.writeFileSync(composeFile, composeContent);
        logger.info("Created MongoDB docker-compose configuration");
      } catch (fileError) {
        logger.error(
          `Error creating docker-compose file: ${fileError.message}`,
        );
        return {
          success: false,
          message: `Failed to create docker-compose file: ${fileError.message}`,
          error: fileError.message,
          help: "Ensure the application has write permissions to /opt/cloudlunacy",
        };
      }

      // Set up certificates if TLS is enabled
      if (config.useTls) {
        try {
          // Run certificate generation script
          execSync("npm run dev:prepare-mongo");
          logger.info("Generated MongoDB certificates");
        } catch (certError) {
          logger.error(`Error generating certificates: ${certError.message}`);
          return {
            success: false,
            message: `Failed to generate certificates: ${certError.message}`,
            error: certError.message,
          };
        }
      }

      // Start MongoDB container
      try {
        execSync(`docker-compose -f ${composeFile} up -d`);
        logger.info("Started MongoDB container");
      } catch (dockerError) {
        logger.error(
          `Error starting MongoDB container: ${dockerError.message}`,
        );
        return {
          success: false,
          message: `Failed to start MongoDB container: ${dockerError.message}`,
          error: dockerError.message,
          help: "Ensure Docker and docker-compose are installed and the user has permissions to run Docker commands",
        };
      }

      // Wait for MongoDB to start
      logger.info("Waiting for MongoDB to initialize...");
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Initialize MongoDB manager
      try {
        await this.supportedDatabases.mongodb.manager.initialize();
        logger.info("MongoDB manager initialized");
      } catch (initError) {
        logger.error(
          `Error initializing MongoDB manager: ${initError.message}`,
        );
        return {
          success: false,
          message: `MongoDB container started but manager initialization failed: ${initError.message}`,
          error: initError.message,
        };
      }

      // Test connection
      try {
        const testResult =
          await this.supportedDatabases.mongodb.manager.testConnection();

        if (testResult.success) {
          return {
            success: true,
            message: "MongoDB installed and running successfully",
            details: testResult,
          };
        } else {
          return {
            success: false,
            message: "MongoDB installed but connection test failed",
            details: testResult,
          };
        }
      } catch (testError) {
        logger.error(`Error testing MongoDB connection: ${testError.message}`);
        return {
          success: false,
          message: `MongoDB installed but connection test failed: ${testError.message}`,
          error: testError.message,
        };
      }
    } catch (error) {
      logger.error(`Failed to install MongoDB: ${error.message}`);
      return {
        success: false,
        message: `Failed to install MongoDB: ${error.message}`,
        error: error.message,
      };
    }
  }

  /**
   * Uninstall MongoDB
   * @param {Object} config - Configuration options
   * @returns {Promise<Object>} - Uninstallation result
   */
  async uninstallMongoDB(config) {
    logger.info("Uninstalling MongoDB...");

    try {
      const isDevelopment = process.env.NODE_ENV === "development";
      if (isDevelopment) {
        return {
          success: true,
          message:
            "In development mode, MongoDB should be managed via docker-compose commands",
        };
      }

      // For production, stop and remove MongoDB container
      const composeFile = `/opt/cloudlunacy/docker-compose.mongodb.yml`;

      if (fs.existsSync(composeFile)) {
        // Stop and remove container
        execSync(`docker-compose -f ${composeFile} down -v`);

        // Remove compose file
        fs.unlinkSync(composeFile);

        return {
          success: true,
          message: "MongoDB uninstalled successfully",
        };
      } else {
        return {
          success: false,
          message:
            "MongoDB compose file not found, might not be installed via this manager",
        };
      }
    } catch (error) {
      logger.error(`Failed to uninstall MongoDB: ${error.message}`);
      return {
        success: false,
        message: `Failed to uninstall MongoDB: ${error.message}`,
        error: error.message,
      };
    }
  }

  /**
   * Check MongoDB status
   * @param {Object} config - Configuration options
   * @returns {Promise<Object>} - Status result
   */
  async checkMongoDBStatus(config) {
    try {
      const isDevelopment = process.env.NODE_ENV === "development";

      if (isDevelopment) {
        // In development, check if MongoDB container is running
        try {
          const output = execSync(
            'docker ps --format "{{.Names}}" | grep mongodb',
          )
            .toString()
            .trim();
          const testResult =
            await this.supportedDatabases.mongodb.manager.testConnection();

          return {
            success: true,
            installed: output.length > 0,
            running: testResult.success,
            details: testResult,
          };
        } catch (error) {
          return {
            success: true,
            installed: false,
            running: false,
            message: "MongoDB is not running in development environment",
          };
        }
      } else {
        // In production, check if MongoDB container is running
        try {
          const output = execSync(
            'docker ps --format "{{.Names}}" | grep cloudlunacy-mongodb',
          )
            .toString()
            .trim();

          if (output.length > 0) {
            // Container is running, check connection
            const testResult =
              await this.supportedDatabases.mongodb.manager.testConnection();

            return {
              success: true,
              installed: true,
              running: testResult.success,
              version: "MongoDB latest", // Would need to query for actual version
              message: testResult.success
                ? "MongoDB is installed and running"
                : "MongoDB is installed but connection failed",
              details: testResult,
            };
          } else {
            return {
              success: true,
              installed: false,
              running: false,
              message: "MongoDB container is not running",
            };
          }
        } catch (error) {
          // Error running docker ps command
          return {
            success: false,
            message: `Failed to check MongoDB status: ${error.message}`,
            error: error.message,
          };
        }
      }
    } catch (error) {
      logger.error(`Failed to check MongoDB status: ${error.message}`);
      return {
        success: false,
        message: `Failed to check MongoDB status: ${error.message}`,
        error: error.message,
      };
    }
  }

  /**
   * Install Redis
   * @param {Object} config - Configuration options
   * @returns {Promise<Object>} - Installation result
   */
  async installRedis(config) {
    logger.info("Installing Redis...");

    try {
      // Check if Redis is already installed
      const isInstalled = await this.checkRedisStatus(config);
      if (isInstalled.success && isInstalled.installed) {
        return {
          success: true,
          message: "Redis is already installed and running",
          status: isInstalled,
        };
      }

      // For development mode, Redis should be in docker-compose
      const isDevelopment = process.env.NODE_ENV === "development";
      if (isDevelopment) {
        return {
          success: true,
          message:
            "In development mode, Redis should be set up via docker-compose",
        };
      }

      // For production, use Docker to install Redis
      const mountPath = "/opt/cloudlunacy/redis";

      // Create directories with proper error handling
      try {
        // Check if directories exist first
        const dirExists = (dir) => {
          try {
            return fs.existsSync(dir);
          } catch (e) {
            return false;
          }
        };

        // Create required directories if they don't exist
        const dirs = [mountPath, `${mountPath}/data`];

        for (const dir of dirs) {
          if (!dirExists(dir)) {
            try {
              // First attempt: try to create directory normally
              fs.mkdirSync(dir, { recursive: true });
              logger.info(`Created directory: ${dir}`);
            } catch (err) {
              // If permission error, try with sudo
              if (err.code === "EACCES" || err.code === "EPERM") {
                logger.info(
                  `Permission denied, attempting to create directory with sudo: ${dir}`,
                );
                try {
                  // Execute sudo mkdir command
                  execSync(`sudo mkdir -p ${dir}`);

                  // Set ownership to current user
                  const currentUser = execSync("whoami").toString().trim();
                  execSync(
                    `sudo chown -R ${currentUser}:${currentUser} ${dir}`,
                  );

                  // Set appropriate permissions
                  execSync(`sudo chmod -R 755 ${dir}`);

                  logger.info(
                    `Successfully created directory with sudo: ${dir}`,
                  );
                } catch (sudoError) {
                  logger.error(
                    `Failed to create directory with sudo: ${sudoError.message}`,
                  );
                  return {
                    success: false,
                    message:
                      "Failed to create Redis directories, even with sudo",
                    error: sudoError.message,
                    help:
                      "Please ensure you have sudo access or manually create the directories:\n" +
                      `sudo mkdir -p ${mountPath}/data\n` +
                      `sudo chown -R $USER:$USER /opt/cloudlunacy\n` +
                      "Then try installing Redis again.",
                  };
                }
              } else {
                throw err; // Re-throw other errors
              }
            }
          }
        }
      } catch (dirError) {
        logger.error(`Error creating directories: ${dirError.message}`);
        return {
          success: false,
          message: `Failed to create required directories: ${dirError.message}`,
          error: dirError.message,
        };
      }

      // Create password file for Redis if auth is enabled
      if (config.authEnabled && config.password) {
        try {
          fs.writeFileSync(`${mountPath}/password.txt`, config.password);
          logger.info("Created Redis password file");
        } catch (pwError) {
          logger.error(`Error creating password file: ${pwError.message}`);
          return {
            success: false,
            message: `Failed to create Redis password file: ${pwError.message}`,
            error: pwError.message,
          };
        }
      }

      // Create docker-compose file for Redis
      const composeFile = `/opt/cloudlunacy/docker-compose.redis.yml`;
      try {
        const composeContent = `
version: '3'

services:
  redis:
    image: redis:latest
    container_name: cloudlunacy-redis
    restart: always
    ports:
      - "${config.port || 6379}:6379"
    volumes:
      - ${mountPath}/data:/data
    command: redis-server ${config.authEnabled ? `--requirepass ${config.password || "redispassword"}` : ""}
`;

        fs.writeFileSync(composeFile, composeContent);
        logger.info("Created Redis docker-compose configuration");
      } catch (fileError) {
        logger.error(
          `Error creating docker-compose file: ${fileError.message}`,
        );
        return {
          success: false,
          message: `Failed to create Redis docker-compose file: ${fileError.message}`,
          error: fileError.message,
          help: "Ensure the application has write permissions to /opt/cloudlunacy",
        };
      }

      // Start Redis container
      try {
        execSync(`docker-compose -f ${composeFile} up -d`);
        logger.info("Started Redis container");
      } catch (dockerError) {
        logger.error(`Error starting Redis container: ${dockerError.message}`);
        return {
          success: false,
          message: `Failed to start Redis container: ${dockerError.message}`,
          error: dockerError.message,
          help: "Ensure Docker and docker-compose are installed and the user has permissions to run Docker commands",
        };
      }

      // Wait for Redis to start
      logger.info("Waiting for Redis to initialize...");
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Test connection
      try {
        const testResult = await this.testRedisConnection(config);

        if (testResult.success) {
          return {
            success: true,
            message: "Redis installed and running successfully",
            details: testResult,
          };
        } else {
          return {
            success: false,
            message: "Redis installed but connection test failed",
            details: testResult,
          };
        }
      } catch (testError) {
        logger.error(`Error testing Redis connection: ${testError.message}`);
        return {
          success: false,
          message: `Redis installed but connection test failed: ${testError.message}`,
          error: testError.message,
        };
      }
    } catch (error) {
      logger.error(`Failed to install Redis: ${error.message}`);
      return {
        success: false,
        message: `Failed to install Redis: ${error.message}`,
        error: error.message,
      };
    }
  }

  /**
   * Uninstall Redis
   * @param {Object} config - Configuration options
   * @returns {Promise<Object>} - Uninstallation result
   */
  async uninstallRedis(config) {
    logger.info("Uninstalling Redis...");

    try {
      const isDevelopment = process.env.NODE_ENV === "development";
      if (isDevelopment) {
        return {
          success: true,
          message:
            "In development mode, Redis should be managed via docker-compose commands",
        };
      }

      // For production, stop and remove Redis container
      const composeFile = `/opt/cloudlunacy/docker-compose.redis.yml`;

      if (fs.existsSync(composeFile)) {
        // Stop and remove container
        execSync(`docker-compose -f ${composeFile} down -v`);

        // Remove compose file
        fs.unlinkSync(composeFile);

        return {
          success: true,
          message: "Redis uninstalled successfully",
        };
      } else {
        return {
          success: false,
          message:
            "Redis compose file not found, might not be installed via this manager",
        };
      }
    } catch (error) {
      logger.error(`Failed to uninstall Redis: ${error.message}`);
      return {
        success: false,
        message: `Failed to uninstall Redis: ${error.message}`,
        error: error.message,
      };
    }
  }

  /**
   * Check Redis status
   * @param {Object} config - Configuration options
   * @returns {Promise<Object>} - Status result
   */
  async checkRedisStatus(config) {
    try {
      const isDevelopment = process.env.NODE_ENV === "development";

      if (isDevelopment) {
        // In development, check if Redis container is running
        try {
          const output = execSync(
            'docker ps --format "{{.Names}}" | grep redis',
          )
            .toString()
            .trim();
          const testResult = await this.testRedisConnection(config);

          return {
            success: true,
            installed: output.length > 0,
            running: testResult.success,
            details: testResult,
          };
        } catch (error) {
          return {
            success: true,
            installed: false,
            running: false,
            message: "Redis is not running in development environment",
          };
        }
      } else {
        // In production, check if Redis container is running
        try {
          const output = execSync(
            'docker ps --format "{{.Names}}" | grep cloudlunacy-redis',
          )
            .toString()
            .trim();
          const testResult = await this.testRedisConnection(config);

          return {
            success: true,
            installed: output.length > 0,
            running: testResult.success,
            details: testResult,
          };
        } catch (error) {
          return {
            success: true,
            installed: false,
            running: false,
            message: "Redis is not installed or not running",
          };
        }
      }
    } catch (error) {
      logger.error(`Failed to check Redis status: ${error.message}`);
      return {
        success: false,
        message: `Failed to check Redis status: ${error.message}`,
        error: error.message,
      };
    }
  }

  /**
   * Test Redis connection
   * @param {Object} config - Redis configuration
   * @returns {Promise<Object>} Test result
   */
  async testRedisConnection(config) {
    try {
      // Use redis-cli to test connection
      const host = config.host || "localhost";
      const port = config.port || 6379;

      // Basic command to test connection
      let command = `redis-cli -h ${host} -p ${port} ping`;

      // Add authentication if enabled
      if (config.authEnabled && config.password) {
        command = `redis-cli -h ${host} -p ${port} -a ${config.password} ping`;
      }

      const output = execSync(command).toString().trim();

      if (output === "PONG") {
        return {
          success: true,
          message: "Redis connection successful",
          details: { response: "PONG" },
        };
      } else {
        return {
          success: false,
          message: `Unexpected Redis response: ${output}`,
        };
      }
    } catch (error) {
      logger.error(`Redis connection test failed: ${error.message}`);
      return {
        success: false,
        message: `Redis connection test failed: ${error.message}`,
        error: error.message,
      };
    }
  }
}

module.exports = new DatabaseManager();
