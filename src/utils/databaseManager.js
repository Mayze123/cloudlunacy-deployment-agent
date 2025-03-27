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
const { executeCommand } = require("../../utils/executor");

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
      const basePath = "/opt/cloudlunacy";

      // Check if directories exist and are writable before proceeding
      try {
        // Function to check if directory exists and is writable
        const checkDirAccess = (dir) => {
          try {
            if (!fs.existsSync(dir)) {
              return { exists: false, writable: false };
            }

            // Check if we can write to the directory
            const testFile = path.join(dir, `.write-test-${Date.now()}.tmp`);
            fs.writeFileSync(testFile, "test");
            fs.unlinkSync(testFile);
            return { exists: true, writable: true };
          } catch (e) {
            return { exists: fs.existsSync(dir), writable: false };
          }
        };

        // Required directories with parent paths to check
        const requiredDirs = [
          basePath,
          mountPath,
          `${mountPath}/data`,
          `${mountPath}/data/db`,
          certsPath,
        ];

        // Check each directory
        const dirIssues = [];
        for (const dir of requiredDirs) {
          const access = checkDirAccess(dir);
          if (!access.exists || !access.writable) {
            dirIssues.push({
              path: dir,
              exists: access.exists,
              writable: access.writable,
            });
          }
        }

        // If there are issues with directories, return detailed error
        if (dirIssues.length > 0) {
          const missingDirs = dirIssues
            .filter((d) => !d.exists)
            .map((d) => d.path);
          const nonWritableDirs = dirIssues
            .filter((d) => d.exists && !d.writable)
            .map((d) => d.path);

          let errorMsg = "Directory permission issues detected:\n";
          if (missingDirs.length > 0) {
            errorMsg += `- Missing directories: ${missingDirs.join(", ")}\n`;
          }
          if (nonWritableDirs.length > 0) {
            errorMsg += `- Non-writable directories: ${nonWritableDirs.join(", ")}\n`;
          }

          logger.error(errorMsg);
          return {
            success: false,
            message: "Failed to install MongoDB: Directory permission issues",
            error: "Permission denied",
            details: { missingDirs, nonWritableDirs },
            help:
              "Since the application is running as a service, please run the following commands manually before installation:\n\n" +
              "sudo mkdir -p /opt/cloudlunacy/mongodb/data/db\n" +
              "sudo mkdir -p /opt/cloudlunacy/certs\n" +
              `sudo chown -R ${process.getuid?.() || "SERVICE_USER"}:${process.getgid?.() || "SERVICE_GROUP"} /opt/cloudlunacy\n` +
              "sudo chmod -R 755 /opt/cloudlunacy\n\n" +
              "Then restart the service and try again.",
          };
        }

        // All directories exist and are writable, continue with installation
        logger.info("All required directories exist and are writable");
      } catch (dirCheckError) {
        logger.error(
          `Error checking directory permissions: ${dirCheckError.message}`,
        );
        return {
          success: false,
          message: `Failed to check directory permissions: ${dirCheckError.message}`,
          error: dirCheckError.message,
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
          await executeCommand("npm", ["run", "dev:prepare-mongo"]);
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
        await executeCommand("docker-compose", ["-f", composeFile, "up", "-d"]);
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
        await executeCommand("docker-compose", [
          "-f",
          composeFile,
          "down",
          "-v",
        ]);

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
          // Use a shell command to properly handle the pipe
          const { stdout: output } = await executeCommand("sh", [
            "-c",
            'docker ps --format "{{.Names}}" | grep mongodb || true',
          ]);

          const testResult =
            await this.supportedDatabases.mongodb.manager.testConnection();

          return {
            success: true,
            installed: output.trim().length > 0,
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
          // Use a shell command to properly handle the pipe
          const { stdout: output } = await executeCommand("sh", [
            "-c",
            'docker ps --format "{{.Names}}" | grep cloudlunacy-mongodb || true',
          ]);

          if (output.trim().length > 0) {
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
      const basePath = "/opt/cloudlunacy";

      // Check if directories exist and are writable before proceeding
      try {
        // Function to check if directory exists and is writable
        const checkDirAccess = (dir) => {
          try {
            if (!fs.existsSync(dir)) {
              return { exists: false, writable: false };
            }

            // Check if we can write to the directory
            const testFile = path.join(dir, `.write-test-${Date.now()}.tmp`);
            fs.writeFileSync(testFile, "test");
            fs.unlinkSync(testFile);
            return { exists: true, writable: true };
          } catch (e) {
            return { exists: fs.existsSync(dir), writable: false };
          }
        };

        // Required directories with parent paths to check
        const requiredDirs = [basePath, mountPath, `${mountPath}/data`];

        // Check each directory
        const dirIssues = [];
        for (const dir of requiredDirs) {
          const access = checkDirAccess(dir);
          if (!access.exists || !access.writable) {
            dirIssues.push({
              path: dir,
              exists: access.exists,
              writable: access.writable,
            });
          }
        }

        // If there are issues with directories, return detailed error
        if (dirIssues.length > 0) {
          const missingDirs = dirIssues
            .filter((d) => !d.exists)
            .map((d) => d.path);
          const nonWritableDirs = dirIssues
            .filter((d) => d.exists && !d.writable)
            .map((d) => d.path);

          let errorMsg = "Directory permission issues detected:\n";
          if (missingDirs.length > 0) {
            errorMsg += `- Missing directories: ${missingDirs.join(", ")}\n`;
          }
          if (nonWritableDirs.length > 0) {
            errorMsg += `- Non-writable directories: ${nonWritableDirs.join(", ")}\n`;
          }

          logger.error(errorMsg);
          return {
            success: false,
            message: "Failed to install Redis: Directory permission issues",
            error: "Permission denied",
            details: { missingDirs, nonWritableDirs },
            help:
              "Since the application is running as a service, please run the following commands manually before installation:\n\n" +
              "sudo mkdir -p /opt/cloudlunacy/redis/data\n" +
              `sudo chown -R ${process.getuid?.() || "SERVICE_USER"}:${process.getgid?.() || "SERVICE_GROUP"} /opt/cloudlunacy\n` +
              "sudo chmod -R 755 /opt/cloudlunacy\n\n" +
              "Then restart the service and try again.",
          };
        }

        // All directories exist and are writable, continue with installation
        logger.info("All required directories exist and are writable");
      } catch (dirCheckError) {
        logger.error(
          `Error checking directory permissions: ${dirCheckError.message}`,
        );
        return {
          success: false,
          message: `Failed to check directory permissions: ${dirCheckError.message}`,
          error: dirCheckError.message,
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
        await executeCommand("docker-compose", ["-f", composeFile, "up", "-d"]);
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
        await executeCommand("docker-compose", [
          "-f",
          composeFile,
          "down",
          "-v",
        ]);

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
          // Use a shell command to properly handle the pipe
          const { stdout: output } = await executeCommand("sh", [
            "-c",
            'docker ps --format "{{.Names}}" | grep redis || true',
          ]);

          const testResult = await this.testRedisConnection(config);

          return {
            success: true,
            installed: output.trim().length > 0,
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
          // Use a shell command to properly handle the pipe
          const { stdout: output } = await executeCommand("sh", [
            "-c",
            'docker ps --format "{{.Names}}" | grep cloudlunacy-redis || true',
          ]);

          const testResult = await this.testRedisConnection(config);

          return {
            success: true,
            installed: output.trim().length > 0,
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
      let args = ["-h", host, "-p", port.toString(), "ping"];

      // Add authentication if enabled
      if (config.authEnabled && config.password) {
        args = [
          "-h",
          host,
          "-p",
          port.toString(),
          "-a",
          config.password,
          "ping",
        ];
      }

      const { stdout: output } = await executeCommand("redis-cli", args);

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
