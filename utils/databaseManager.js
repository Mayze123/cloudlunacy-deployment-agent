const { exec, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const logger = require("./logger");
const mongoManager = require("./mongoManager");
const { executeCommand } = require("./executor");

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
    if (!config) {
      return { success: false, message: "No configuration provided" };
    }

    logger.info(`Adding ${dbType} configuration`);

    try {
      // Validate required configuration fields
      if (!this.supportedDatabases[dbType]) {
        return {
          success: false,
          message: `Unsupported database type: ${dbType}. Supported types: ${Object.keys(this.supportedDatabases).join(", ")}`,
        };
      }

      // Merge options with defaults
      const dbConfig = this.supportedDatabases[dbType];
      const mergedConfig = {
        ...dbConfig.defaultConfig,
        port: dbConfig.defaultPort,
        ...config,
      };

      // Read current .env file
      let envContent = "";
      try {
        envContent = fs.readFileSync(this.envFile, "utf8");
      } catch (err) {
        // If file doesn't exist, create it with default content
        envContent = "# CloudLunacy Agent Environment Variables\n";
      }

      // Create configuration block
      let configContent = "";
      if (dbType === "mongodb") {
        configContent = `
# MongoDB Configuration
MONGO_HOST=${mergedConfig.host || "localhost"}
MONGO_PORT=${mergedConfig.port || 27017}
MONGO_MANAGER_USERNAME=${mergedConfig.username || "admin"}
MONGO_MANAGER_PASSWORD=${mergedConfig.password || "adminPassword"}
MONGO_USE_TLS=true
MONGO_DATABASE=${mergedConfig.database || "admin"}
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
REDIS_HOST=${mergedConfig.host || "localhost"}
REDIS_PORT=${mergedConfig.port || 6379}
REDIS_USE_TLS=${mergedConfig.useTls}
${mergedConfig.authEnabled && mergedConfig.password ? `REDIS_PASSWORD=${mergedConfig.password}` : ""}
REDIS_USERNAME=${mergedConfig.username || ""}
REDIS_PASSWORD=${mergedConfig.password || ""}
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
   * @param {string} targetHost - Target host
   * @param {number} targetPort - Target port
   * @param {Object} options - Database options
   * @param {string} jwt - JWT token for authentication
   * @returns {Promise<Object>} Registration result
   */
  async registerWithFrontServer(
    dbType,
    agentId,
    targetHost,
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

      // Updated to use the new API endpoint based on database type
      const endpoint =
        dbType === "mongodb"
          ? `${FRONT_API_URL}/api/proxy/mongodb`
          : `${FRONT_API_URL}/api/proxy/${dbType}`;

      logger.info(`Using endpoint: ${endpoint}`);

      // Construct payload according to the HAProxy Data Plane API specification
      const payload = {
        agentId,
        targetHost,
        targetPort,
        options: {
          useTls: options.useTls !== false, // Default to true for TLS
        },
      };

      // Make the API request
      const response = await axios.post(endpoint, payload, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
      });

      if (response.data && response.data.success) {
        logger.info(`${dbType} successfully registered with front server`, {
          domain: response.data.domain,
          useTls: response.data.useTls,
        });
        return {
          success: true,
          domain: response.data.domain,
          useTls: response.data.useTls,
        };
      } else {
        return {
          success: false,
          message: response.data.message || "Unknown error from front server",
        };
      }
    } catch (error) {
      logger.error(
        `Error registering ${dbType} with front server: ${error.message}`,
      );
      if (error.response) {
        logger.error(
          `Response status: ${error.response.status}, data:`,
          error.response.data,
        );
      }
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
              // Directory doesn't exist - don't try to create it
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
              "Directory permission issues detected. Please run the fix-permissions script to correct this:\n\n" +
              "sudo ./scripts/install-agent.sh --fix-permissions\n\n" +
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
      const composeContent = `
version: '3'

services:
  mongodb:
    image: mongo:latest
    container_name: cloudlunacy-mongodb
    command: --tlsMode preferTLS --tlsCertificateKeyFile /etc/mongodb/certs/server.pem --tlsCAFile /etc/mongodb/certs/ca.crt --tlsAllowConnectionsWithoutCertificates
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

      // Set up certificates (always required now since TLS is mandatory)
      if (isDevelopment) {
        try {
          // Run certificate generation script only in development mode
          await executeCommand("npm", ["run", "dev:prepare-mongo"]);
          logger.info("Generated MongoDB certificates");
        } catch (certErr) {
          logger.error(`Certificate preparation failed: ${certErr.message}`);
          return {
            success: false,
            message: `Failed to prepare MongoDB certificates: ${certErr.message}`,
            error: certErr.message,
            help: "Run 'npm run dev:setup' first to fetch the certificates from the front server.",
          };
        }
      } else {
        // In production, certificates should already be available from agent installation
        if (
          !fs.existsSync(path.join(certsPath, "ca.crt")) ||
          !fs.existsSync(path.join(certsPath, "server.key")) ||
          !fs.existsSync(path.join(certsPath, "server.crt"))
        ) {
          logger.error("TLS certificates not found in production environment");
          return {
            success: false,
            message: "TLS certificates not found in production environment",
            error: "Missing certificates",
            help: "Certificates should be in /opt/cloudlunacy/certs from agent installation",
          };
        }

        // Ensure server.pem exists (combined key and cert)
        if (!fs.existsSync(path.join(certsPath, "server.pem"))) {
          try {
            logger.info("Creating server.pem file in production environment");
            const key = fs.readFileSync(path.join(certsPath, "server.key"));
            const cert = fs.readFileSync(path.join(certsPath, "server.crt"));
            fs.writeFileSync(
              path.join(certsPath, "server.pem"),
              Buffer.concat([key, cert]),
            );
            // Set proper permissions
            execSync(`chmod 600 ${path.join(certsPath, "server.pem")}`);
            logger.info("Created server.pem file successfully");
          } catch (pemErr) {
            logger.error(`Failed to create server.pem file: ${pemErr.message}`);
            return {
              success: false,
              message: `Failed to create server.pem file: ${pemErr.message}`,
              error: pemErr.message,
            };
          }
        }
      }

      // Start MongoDB container
      await executeCommand("docker-compose", ["-f", composeFile, "up", "-d"]);
      logger.info("Started MongoDB container");

      // Wait for MongoDB to start
      logger.info("Waiting for MongoDB to initialize...");
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Initialize MongoDB manager
      await mongoManager.initialize();
      logger.info("MongoDB manager initialized");

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
        await executeCommand("docker-compose", [
          "-f",
          composeFile,
          "down",
          "-v",
        ]);
        logger.info("MongoDB container stopped and removed");

        // Remove compose file
        fs.unlinkSync(composeFile);
        logger.info("MongoDB compose file removed");

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
          // Use a shell command to properly handle the pipe
          const { stdout: output } = await executeCommand("sh", [
            "-c",
            'docker ps --format "{{.Names}}" | grep mongodb || true',
          ]);

          const testResult = await mongoManager.testConnection();

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

          let testResult = { success: false };

          try {
            testResult = await mongoManager.testConnection();
          } catch (err) {
            logger.warn(`Could not test MongoDB connection: ${err.message}`);
          }

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

      // For Docker-based setup, we install Redis via docker-compose
      const isDevelopment = process.env.NODE_ENV === "development";
      if (isDevelopment) {
        // In development mode, Redis should be defined in docker-compose
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
              // Directory doesn't exist - don't try to create it
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
              "Directory permission issues detected. Please run the fix-permissions script to correct this:\n\n" +
              "sudo ./scripts/install-agent.sh --fix-permissions\n\n" +
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
        fs.writeFileSync(`${mountPath}/password.txt`, config.password);
        logger.info("Created Redis password file");
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
      logger.info("Created Redis docker-compose configuration");

      // Start Redis container
      await executeCommand("docker-compose", ["-f", composeFile, "up", "-d"]);
      logger.info("Started Redis container");

      // Wait for Redis to start
      logger.info("Waiting for Redis to initialize...");
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
        await executeCommand("docker-compose", [
          "-f",
          composeFile,
          "down",
          "-v",
        ]);
        logger.info("Redis container stopped and removed");

        // Remove compose file
        fs.unlinkSync(composeFile);
        logger.info("Redis compose file removed");

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
