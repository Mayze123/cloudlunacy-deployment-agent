const { exec, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const logger = require("./logger");
const mongoManager = require("./mongoManager");

/**
 * Generic Database Manager
 *
 * This utility handles the installation, configuration, and management of various databases.
 * Currently supports MongoDB and Redis, but can be extended to support other databases.
 */
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
        manager: mongoManager,
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
    this.envFile =
      process.env.NODE_ENV === "development"
        ? path.join(process.cwd(), ".env.dev")
        : "/opt/cloudlunacy/.env";
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
   * Adds database configuration to the environment file
   * @param {string} dbType - The database type (mongodb, redis)
   * @param {Object} config - Configuration options
   * @returns {Promise<Object>} Result of the operation
   */
  async addDatabaseConfig(dbType, config) {
    try {
      // Read current .env file
      let envContent = "";
      try {
        envContent = fs.readFileSync(this.envFile, "utf8");
      } catch (err) {
        return {
          success: false,
          message: `Failed to read environment file: ${err.message}`,
        };
      }

      // Prepare the configuration based on database type
      let configContent = "";
      if (dbType === "mongodb") {
        configContent = `
# MongoDB Configuration
MONGO_HOST=localhost
MONGO_PORT=${config.port || 27017}
MONGO_MANAGER_USERNAME=${config.username || "admin"}
MONGO_MANAGER_PASSWORD=${config.password || "adminpassword"}
MONGO_USE_TLS=${config.useTls}
`;

        // Add TLS paths if in production mode
        if (process.env.NODE_ENV !== "development") {
          const certsDir = "/opt/cloudlunacy/certs";
          configContent += `MONGO_CA_PATH=${certsDir}/ca.crt
MONGO_CERT_PATH=${certsDir}/server.crt
MONGO_KEY_PATH=${certsDir}/server.key
MONGO_PEM_PATH=${certsDir}/server.pem
`;
        }
      } else if (dbType === "redis") {
        configContent = `
# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=${config.port || 6379}
REDIS_USE_TLS=${config.useTls}
${config.authEnabled && config.password ? `REDIS_PASSWORD=${config.password}` : ""}
`;
      }

      // Add configuration to .env file
      if (
        envContent.includes(
          `# ${dbType.charAt(0).toUpperCase() + dbType.slice(1)} Configuration`,
        )
      ) {
        // If the configuration section already exists, replace it
        const regex = new RegExp(
          `# ${dbType.charAt(0).toUpperCase() + dbType.slice(1)} Configuration[\\s\\S]*?(?=\\n\\n|$)`,
          "i",
        );
        envContent = envContent.replace(regex, configContent.trim());
      } else {
        // Otherwise, append it
        envContent += configContent;
      }

      // Write updated content back to .env file
      fs.writeFileSync(this.envFile, envContent);

      return {
        success: true,
        message: `${dbType} configuration added to environment file`,
      };
    } catch (error) {
      logger.error(
        `Failed to add ${dbType} configuration to environment file: ${error.message}`,
      );
      return {
        success: false,
        message: `Failed to add ${dbType} configuration to environment file: ${error.message}`,
      };
    }
  }

  /**
   * Removes database configuration from the environment file
   * @param {string} dbType - The database type (mongodb, redis)
   * @returns {Promise<Object>} Result of the operation
   */
  async removeDatabaseConfig(dbType) {
    try {
      // Read current .env file
      let envContent = "";
      try {
        envContent = fs.readFileSync(this.envFile, "utf8");
      } catch (err) {
        return {
          success: false,
          message: `Failed to read environment file: ${err.message}`,
        };
      }

      // Remove the configuration section for the specified database
      const regex = new RegExp(
        `\\n# ${dbType.charAt(0).toUpperCase() + dbType.slice(1)} Configuration[\\s\\S]*?(?=\\n\\n|$)`,
        "i",
      );
      envContent = envContent.replace(regex, "");

      // Write updated content back to .env file
      fs.writeFileSync(this.envFile, envContent);

      return {
        success: true,
        message: `${dbType} configuration removed from environment file`,
      };
    } catch (error) {
      logger.error(
        `Failed to remove ${dbType} configuration from environment file: ${error.message}`,
      );
      return {
        success: false,
        message: `Failed to remove ${dbType} configuration from environment file: ${error.message}`,
      };
    }
  }

  /**
   * Registers the database with the front server for TLS termination
   * @param {string} dbType - Database type
   * @param {string} agentId - Agent ID
   * @param {string} targetIp - Target IP address
   * @param {number} targetPort - Target port
   * @param {Object} options - Database options
   * @param {string} jwt - JWT token for authentication
   * @returns {Promise<Object>} Registration result
   */
  async registerWithFrontServer(
    dbType,
    agentId,
    targetIp,
    targetPort,
    options,
    jwt,
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
          agentId,
          targetIp,
          targetPort,
          options,
        },
        {
          headers: {
            Authorization: `Bearer ${jwt}`,
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
   * Install MongoDB
   * @param {Object} config - Configuration options
   * @returns {Promise<Object>} Installation result
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

      // Create directories if they don't exist
      execSync(`mkdir -p ${mountPath}/data/db`);
      execSync(`mkdir -p ${certsPath}`);

      // Create docker-compose file for MongoDB
      const composeFile = `/opt/cloudlunacy/docker-compose.mongodb.yml`;
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

      // Set up certificates if TLS is enabled
      if (config.useTls) {
        // Run certificate generation script
        execSync("npm run dev:prepare-mongo");
      }

      // Start MongoDB container
      execSync(`docker-compose -f ${composeFile} up -d`);

      // Wait for MongoDB to start
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Initialize MongoDB manager
      await mongoManager.initialize();

      // Test connection
      const testResult = await mongoManager.testConnection();

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
   * @returns {Promise<Object>} Uninstallation result
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
   * @returns {Promise<Object>} Status check result
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
          const testResult = await mongoManager.testConnection();

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
          let testResult = { success: false };

          try {
            testResult = await mongoManager.testConnection();
          } catch (err) {
            logger.warn(`Could not test MongoDB connection: ${err.message}`);
          }

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
            message: "MongoDB is not installed or not running",
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
   * @returns {Promise<Object>} Installation result
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

      // Create directories if they don't exist
      execSync(`mkdir -p ${mountPath}/data`);

      // Create password file for Redis if auth is enabled
      if (config.authEnabled && config.password) {
        fs.writeFileSync(`${mountPath}/password.txt`, config.password);
      }

      // Create docker-compose file for Redis
      const composeFile = `/opt/cloudlunacy/docker-compose.redis.yml`;
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

      // Start Redis container
      execSync(`docker-compose -f ${composeFile} up -d`);

      // Wait for Redis to start
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Test connection
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
   * @returns {Promise<Object>} Uninstallation result
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
   * @returns {Promise<Object>} Status check result
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
   * @param {Object} config - Configuration options
   * @returns {Promise<Object>} Connection test result
   */
  async testRedisConnection(config) {
    return new Promise((resolve) => {
      const cmd = `docker run --rm --network=host redis:latest redis-cli ${
        config.port ? `-p ${config.port}` : ""
      } ${config.authEnabled && config.password ? `-a ${config.password}` : ""} ping`;

      exec(cmd, (error, stdout, stderr) => {
        if (error || stderr) {
          resolve({
            success: false,
            message: "Redis connection test failed",
            error: error?.message || stderr,
          });
        } else if (stdout.trim() === "PONG") {
          resolve({
            success: true,
            message: "Redis connection test successful",
          });
        } else {
          resolve({
            success: false,
            message: "Redis returned unexpected response",
            response: stdout,
          });
        }
      });
    });
  }
}

module.exports = new DatabaseManager();
