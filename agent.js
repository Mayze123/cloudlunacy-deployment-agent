/**
 * CloudLunacy Deployment Agent
 * Version: 1.2.0
 * Author: Mahamadou Taibou (modified by You)
 * Date: 2025-02-03
 *
 * Description:
 * This script is the core of the CloudLunacy Deployment Agent installed on a user's VPS.
 * It handles secure communication with the SaaS backend, authenticates the agent,
 * receives commands, and delegates tasks to specific deployment modules.
 *
 * NOTE: TLS termination for MongoDB is now handled by the front server.
 * The agent no longer performs TLS CA verification.
 */

const axios = require("axios");
const WebSocket = require("ws");
const dotenv = require("dotenv");
const logger = require("./utils/logger");
const { ensureDeploymentPermissions } = require("./utils/permissionCheck");
const ZeroDowntimeDeployer = require("./modules/zeroDowntimeDeployer");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");
const databaseManager = require("./utils/databaseManager");

// Load environment variables
dotenv.config();

// Near the top of agent.js, add this check for development mode
const isDevelopment = process.env.NODE_ENV === "development";

// --- Load the JWT token from the persisted file ---
const path = require("path");
const jwtFile = "/opt/cloudlunacy/.agent_jwt.json";
try {
  console.log(`Looking for JWT file at: ${jwtFile}`);
  const data = fs.readFileSync(jwtFile, "utf8");
  console.log(`JWT file contents: ${data}`);
  const parsed = JSON.parse(data);
  console.log(`Parsed token: ${parsed.token ? "Found" : "Not found"}`);
  if (parsed.token) {
    process.env.AGENT_JWT = parsed.token;
    console.log("Loaded AGENT_JWT from token file.");
  }
} catch (err) {
  console.log(`Error loading JWT file: ${err.message}`);
}

// Configuration Constants
const BACKEND_URL = isDevelopment
  ? "http://localhost:8080"
  : process.env.BACKEND_URL;
const FRONT_API_URL = process.env.FRONT_API_URL;
const AGENT_API_TOKEN = process.env.AGENT_API_TOKEN || "dev-token";
const AGENT_JWT = process.env.AGENT_JWT || "dev-jwt"; // JWT from registration
const SERVER_ID = process.env.SERVER_ID || "dev-server-id";
const WS_RECONNECT_MAX_RETRIES = 5;
const WS_INITIAL_RETRY_DELAY = 5000;
const METRICS_INTERVAL = 60000;

// Initialize WebSocket connection variable
let ws;

/**
 * In the new architecture, MongoDB TLS termination is handled by HAProxy on the front server.
 * The agent connects to MongoDB through HAProxy's SNI-based routing.
 */
const initializeMongoDB = async () => {
  // Skip MongoDB initialization if required environment variables are missing
  if (
    !process.env.MONGO_MANAGER_USERNAME ||
    !process.env.MONGO_MANAGER_PASSWORD
  ) {
    logger.info(
      "MongoDB not configured in environment variables. Skipping MongoDB initialization and registration.",
    );
    return false;
  }

  try {
    logger.info("Initializing MongoDB connection through HAProxy");

    // Ensure the MongoDB domain is configured correctly
    const mongoHost = process.env.MONGO_HOST;
    const mongoPort = process.env.MONGO_PORT || "27017";
    const serverDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
    const useTLS = process.env.MONGO_USE_TLS !== "false"; // Default to true

    // Check if we're connecting through HAProxy or directly
    if (process.env.SERVER_ID) {
      logger.info(
        `Connecting to MongoDB through HAProxy at ${process.env.SERVER_ID}.${serverDomain}:${mongoPort} with TLS ${useTLS ? "enabled" : "disabled"}`,
      );

      // Attempt DNS resolution to verify connectivity
      try {
        const hostname = `${process.env.SERVER_ID}.${serverDomain}`;
        const dnsOutput = execSync(
          `dig +short ${hostname} || host ${hostname} || echo "DNS resolution failed"`,
        )
          .toString()
          .trim();
        logger.info(
          `DNS resolution for ${hostname}: ${dnsOutput || "No records found"}`,
        );
      } catch (dnsErr) {
        logger.warn(
          `Could not resolve DNS for MongoDB hostname: ${dnsErr.message}`,
        );
      }
    } else {
      logger.info(
        `Connecting to MongoDB directly at ${mongoHost}:${mongoPort}`,
      );
    }

    // Initialize MongoDB connection manager
    const initialized = await databaseManager.initialize();

    if (!initialized) {
      logger.error("Failed to initialize MongoDB connection manager");
      return false;
    }

    // Test the connection to verify it's working
    const connectionTest = await databaseManager.testConnection();

    if (!connectionTest.success) {
      logger.error(`MongoDB connection test failed: ${connectionTest.message}`);
      return false;
    }

    logger.info("MongoDB manager initialized");
    return true;
  } catch (error) {
    logger.error(`MongoDB initialization error: ${error.message}`);
    return false;
  }
};

/**
 * Authenticate with the backend and establish a WebSocket connection.
 */
async function authenticateAndConnect() {
  try {
    // In development mode, skip the actual authentication
    if (isDevelopment) {
      logger.info("Development mode: Skipping backend authentication");
      // Use a mock WebSocket URL for development that works with Docker
      const wsUrl = "ws://host.docker.internal:8080/agent";
      logger.info(`Using development WebSocket URL: ${wsUrl}`);
      establishWebSocketConnection(wsUrl);
      return;
    }

    logger.info("Authenticating with backend...");

    const response = await axios.post(
      `${BACKEND_URL}/api/agent/authenticate`,
      {
        agentToken: AGENT_API_TOKEN,
        serverId: SERVER_ID,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    const { wsUrl } = response.data;
    if (!wsUrl) {
      throw new Error("WebSocket URL not provided by backend.");
    }

    logger.info(`WebSocket URL received: ${wsUrl}`);
    establishWebSocketConnection(wsUrl);
  } catch (error) {
    handleAuthenticationError(error);
  }
}

/**
 * Establish a WebSocket connection with retry mechanism.
 * @param {string} wsUrl WebSocket URL.
 */
function establishWebSocketConnection(wsUrl) {
  ws = new WebSocket(wsUrl, {
    headers: {
      Authorization: `Bearer ${AGENT_API_TOKEN}`,
    },
  });
  setupWebSocketEventHandlers();
}

/**
 * Set up WebSocket event handlers.
 */
function setupWebSocketEventHandlers() {
  let retryCount = 0;
  let retryDelay = WS_INITIAL_RETRY_DELAY;
  let pingInterval;
  let pingTimeout;
  const PING_INTERVAL = 30000; // 30 seconds
  const PING_TIMEOUT = 5000; // 5 seconds

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data);
      handleMessage(message);
    } catch (error) {
      logger.error("Failed to parse message:", error);
    }
  });

  ws.on("open", () => {
    logger.info("WebSocket connection established.");
    ws.send(JSON.stringify({ type: "register", serverId: SERVER_ID }));

    pingInterval = setInterval(() => {
      ws.ping();
      pingTimeout = setTimeout(() => {
        logger.warn("No pong received - closing connection");
        ws.terminate();
      }, PING_TIMEOUT);
    }, PING_INTERVAL);
  });

  ws.on("pong", () => clearTimeout(pingTimeout));

  ws.on("close", () => {
    clearInterval(pingInterval);
    clearTimeout(pingTimeout);
    handleWebSocketClose(retryCount, retryDelay);
    retryCount++;
    retryDelay *= 2;
  });

  ws.on("error", (error) => {
    logger.error("WebSocket error:", error);
    ws.close();
  });
}

/**
 * Handle WebSocket connection close.
 * @param {number} retryCount Current retry attempt.
 * @param {number} retryDelay Current delay between retries.
 */
function handleWebSocketClose(retryCount, retryDelay) {
  if (retryCount < WS_RECONNECT_MAX_RETRIES) {
    logger.warn(
      `WebSocket connection closed. Reconnecting in ${
        retryDelay / 1000
      } seconds...`,
    );
    setTimeout(authenticateAndConnect, retryDelay);
  } else {
    logger.error(
      "Maximum reconnect attempts reached. Please check the connection.",
    );
  }
}

/**
 * Handle authentication errors.
 * @param {Error} error Authentication error.
 */
function handleAuthenticationError(error) {
  if (error.response) {
    logger.error(
      `Authentication failed with status ${
        error.response.status
      }: ${JSON.stringify(error.response.data)}`,
    );
  } else if (error.request) {
    logger.error("No response received from backend:", error.request);
  } else {
    logger.error("Error in authentication request:", error.message);
  }
}

/**
 * Handle incoming messages from the backend.
 * @param {Object} message The message object.
 */
function handleMessage(message) {
  logger.warn("Unknown message type:", message);
  switch (message.type) {
    case "deploy_app":
      handleDeployApp(message);
      break;
    case "create_database":
      createDatabase(message.payload);
      break;
    case "manage_database":
      handleDatabaseManagement(message.payload);
      break;
    case "check_repository":
      checkRepositoryAccess(message.payload, ws);
      break;
    default:
      logger.warn("Unknown message type:", message.type);
  }
}

/**
 * Handle deploy app message.
 * @param {Object} message Deploy app message.
 */
function handleDeployApp(message) {
  if (message.payload.githubToken) {
    logger.info("Deploying with GitHub App authentication");
    process.env.GITHUB_TOKEN = message.payload.githubToken;
  }

  ZeroDowntimeDeployer.deploy(message.payload, ws).finally(() => {
    console.log(message.payload);
    if (process.env.GITHUB_TOKEN) delete process.env.GITHUB_TOKEN;
  });
}

/**
 * Create a new database based on the payload received from the backend.
 * @param {Object} payload Database creation payload.
 */
async function createDatabase(payload) {
  try {
    logger.info(`Executing install command for ${payload.type} database`);
    logger.info(`Installing ${payload.type}...`);

    // Initialize MongoDB connection
    if (payload.type === "mongodb") {
      await initializeMongoDB();
    }

    const result = await databaseManager.handleDatabaseOperation(
      "install",
      payload.type,
      payload.options,
    );

    if (result.success) {
      logger.info(`${payload.type} database installed successfully.`);
      sendWebSocketMessage("database_created", {
        success: true,
        databaseId: payload.databaseId,
        details: result,
      });
    } else {
      logger.error(
        `Failed to install ${payload.type} database: ${result.message}`,
      );
      sendWebSocketMessage("database_created", {
        success: false,
        databaseId: payload.databaseId,
        error: result.message,
      });
    }
  } catch (error) {
    logger.error(`Error creating database: ${error.message}`);
    sendWebSocketMessage("database_created", {
      success: false,
      databaseId: payload.databaseId,
      error: error.message,
    });
  }
}

/**
 * Handle database management operations.
 * @param {Object} payload Database management payload.
 */
async function handleDatabaseManagement(payload) {
  try {
    const { operation, type, databaseId, options } = payload;
    logger.info(
      `Handling ${operation} operation for ${type} database ${databaseId}`,
    );

    // Make sure MongoDB is initialized if dealing with MongoDB
    if (type === "mongodb") {
      await initializeMongoDB();
    }

    let result;
    switch (operation) {
      case "create_user":
        if (type === "mongodb") {
          const { username, password, dbName } = options;
          result =
            await databaseManager.supportedDatabases.mongodb.manager.createUser(
              username,
              password,
              dbName,
              options.roles || ["readWrite"],
            );
        } else {
          result = {
            success: false,
            message: `Unsupported database type: ${type}`,
          };
        }
        break;
      case "create_database":
        if (type === "mongodb") {
          const { dbName, username, password } = options;
          result =
            await databaseManager.supportedDatabases.mongodb.manager.createDatabaseAndUser(
              dbName,
              username,
              password,
            );
        } else {
          result = {
            success: false,
            message: `Unsupported database type: ${type}`,
          };
        }
        break;
      case "test_connection":
        if (type === "mongodb") {
          result =
            await databaseManager.supportedDatabases.mongodb.manager.testConnection();
        } else {
          result = {
            success: false,
            message: `Unsupported database type: ${type}`,
          };
        }
        break;
      case "status":
        result = await databaseManager.handleDatabaseOperation(
          "status",
          type,
          options,
        );
        break;
      case "uninstall":
        result = await databaseManager.handleDatabaseOperation(
          "uninstall",
          type,
          options,
        );
        break;
      default:
        result = {
          success: false,
          message: `Unsupported operation: ${operation}`,
        };
    }

    sendWebSocketMessage("database_management_result", {
      success: result.success,
      databaseId,
      operation,
      type,
      details: result,
    });
  } catch (error) {
    logger.error(`Error handling database management: ${error.message}`);
    sendWebSocketMessage("database_management_result", {
      success: false,
      databaseId: payload.databaseId,
      operation: payload.operation,
      type: payload.type,
      error: error.message,
    });
  }
}

/**
 * Send a message via the WebSocket connection.
 * @param {string} type Message type.
 * @param {Object} payload Message payload.
 */
function sendWebSocketMessage(type, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    logger.warn(`WebSocket is not open. Cannot send ${type} message.`);
    return;
  }
  ws.send(JSON.stringify({ type, payload }));
}

/**
 * Collect and send system metrics.
 */
function collectMetrics() {
  try {
    const metrics = {
      cpuUsage: getCPUUsage(),
      memoryUsage: getMemoryUsage(),
      diskUsage: getDiskUsage(),
    };
    sendWebSocketMessage("metrics", metrics);
  } catch (error) {
    logger.error("Error collecting metrics:", error);
  }
}

/**
 * Get CPU usage percentage.
 * @returns {string} CPU usage percentage.
 */
function getCPUUsage() {
  const cpus = os.cpus();
  let totalIdle = 0,
    totalTick = 0;
  for (const cpu of cpus) {
    totalIdle += cpu.times.idle;
    totalTick +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.idle +
      cpu.times.irq;
  }
  return (((totalTick - totalIdle) / totalTick) * 100).toFixed(2);
}

/**
 * Get memory usage percentage.
 * @returns {string} Memory usage percentage.
 */
function getMemoryUsage() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return (((totalMem - freeMem) / totalMem) * 100).toFixed(2);
}

/**
 * Get disk usage percentage.
 * @returns {number|null} Disk usage percentage or null if error.
 */
function getDiskUsage() {
  try {
    // More compatible with Alpine Linux/BusyBox
    const output = execSync("df / | tail -1 | awk '{print $5}'")
      .toString()
      .trim();
    return parseInt(output.replace("%", ""), 10);
  } catch (error) {
    logger.error("Error fetching disk usage:", error.message);
    return null;
  }
}

/**
 * Initialize agent operations.
 */
async function init() {
  try {
    logger.info("CloudLunacy Deployment Agent initializing...");

    // Ensure required directories exist
    [
      "/opt/cloudlunacy/deployments",
      "/opt/cloudlunacy/logs",
      "/opt/cloudlunacy/certs",
    ].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.info(`Created directory: ${dir}`);
      }
    });

    // Set appropriate permissions if running as root
    if (process.getuid() === 0) {
      try {
        execSync(`chown -R cloudlunacy:cloudlunacy /opt/cloudlunacy`);
        logger.info("Set ownership of /opt/cloudlunacy to cloudlunacy user");
      } catch (err) {
        logger.warn(
          `Could not set permissions for /opt/cloudlunacy: ${err.message}`,
        );
      }
    }

    // Initialize MongoDB and attempt connection
    await initializeMongoDB();

    // Authenticate with the SaaS backend
    await authenticateAndConnect();

    // Start periodically collecting metrics
    setInterval(collectMetrics, METRICS_INTERVAL);

    logger.info("CloudLunacy Deployment Agent initialized successfully");
  } catch (error) {
    logger.error(`Initialization failed: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Get the public/local IP address of this server.
 * @returns {string} IP address
 */
async function getPublicIp() {
  try {
    // First try to get the server's own IP address using execSync
    try {
      const localIp = execSync("hostname -I").toString().trim().split(" ")[0];
      if (localIp) {
        return localIp;
      }
    } catch (err) {
      logger.warn("Failed to get local IP with hostname -I:", err.message);
    }

    // If local command fails, try network interfaces from os module
    try {
      const interfaces = os.networkInterfaces();
      for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
          // Skip internal interfaces and non-IPv4
          if (iface.family === "IPv4" && !iface.internal) {
            return iface.address;
          }
        }
      }
    } catch (err) {
      logger.warn(
        "Failed to get local IP from network interfaces:",
        err.message,
      );
    }

    // If all local methods fail, try external service
    const response = await axios.get("https://api.ipify.org?format=json");
    return response.data.ip;
  } catch (error) {
    logger.error("Failed to determine IP address:", error.message);
    // Fallback to localhost as a last resort
    return "127.0.0.1";
  }
}

// Start the agent.
init();
