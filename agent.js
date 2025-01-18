/**
 * CloudLunacy Deployment Agent
 * Version: 1.0.1
 * Author: Mahamadou Taibou
 * Date: 2024-04-27
 *
 * Description:
 * This script serves as the core of the CloudLunacy Deployment Agent installed on a user's VPS.
 * It handles secure communication with the SaaS backend, authenticates the agent,
 * receives commands, and delegates tasks to specific deployment modules.
 */

const axios = require("axios");
const WebSocket = require("ws");
const dotenv = require("dotenv");
const logger = require("./utils/logger");
const { ensureDeploymentPermissions } = require("./utils/permissionCheck");
const ZeroDowntimeDeployer = require("./modules/zeroDowntimeDeployer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

// Load environment variables
dotenv.config();

// Configuration Constants
const BACKEND_URL = process.env.BACKEND_URL;
const AGENT_API_TOKEN = process.env.AGENT_API_TOKEN;
const SERVER_ID = process.env.SERVER_ID;
const WS_RECONNECT_MAX_RETRIES = 5;
const WS_INITIAL_RETRY_DELAY = 5000;
const METRICS_INTERVAL = 60000;

// Initialize WebSocket connection variable
let ws;

/**
 * Verify and get the TLS CA file path
 * @returns {string|null} Valid CA file path or null if not found
 */
const getTlsCaFilePath = () => {
  const possiblePaths = [
    process.env.MONGO_TLS_CA_FILE,
    process.env.MONGODB_CA_FILE,
    process.env.NODE_EXTRA_CA_CERTS,
    "/etc/ssl/mongo/chain.pem", // Default fallback path
  ];

  for (const filePath of possiblePaths) {
    if (filePath && fs.existsSync(filePath)) {
      logger.info(`Using TLS CA file from: ${filePath}`);
      return filePath;
    }
  }
  return null;
};

/**
 * Verify MongoDB configuration
 * @returns {boolean} True if configuration is valid
 */
const verifyMongoConfig = () => {
  // Verify required environment variables
  const requiredEnvVars = {
    "MongoDB Manager Username": process.env.MONGO_MANAGER_USERNAME,
    "MongoDB Manager Password": process.env.MONGO_MANAGER_PASSWORD,
    "MongoDB Host": process.env.MONGO_HOST,
    "MongoDB Port": process.env.MONGO_PORT,
  };

  const missingVars = Object.entries(requiredEnvVars)
    .filter(([_, value]) => !value)
    .map(([name]) => name);

  if (missingVars.length > 0) {
    logger.error(
      `Missing required environment variables: ${missingVars.join(", ")}`
    );
    return false;
  }

  // Verify TLS CA file
  const tlsCaFile = getTlsCaFilePath();
  if (!tlsCaFile) {
    logger.error(
      "Could not find valid TLS CA file in any of the expected locations"
    );
    return false;
  }

  // Set the verified CA file path to all relevant environment variables
  process.env.MONGO_TLS_CA_FILE = tlsCaFile;
  process.env.MONGODB_CA_FILE = tlsCaFile;
  process.env.NODE_EXTRA_CA_CERTS = tlsCaFile;

  return true;
};

/**
 * Initialize MongoDB configuration
 * @returns {boolean} True if initialization successful
 */
const initializeMongoDB = () => {
  if (!verifyMongoConfig()) {
    throw new Error("MongoDB configuration verification failed");
  }

  logger.info("MongoDB configuration verified successfully");
  return true;
};

/**
 * Authenticate with backend and establish WebSocket connection
 */
async function authenticateAndConnect() {
  try {
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
      }
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
 * Establish WebSocket connection with retry mechanism
 * @param {string} wsUrl WebSocket URL
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
 * Set up WebSocket event handlers
 */
function setupWebSocketEventHandlers() {
  let retryCount = 0;
  let retryDelay = WS_INITIAL_RETRY_DELAY;
  let pingInterval;
  let pingTimeout;
  const PING_INTERVAL = 30000; // Send ping every 30 seconds
  const PING_TIMEOUT = 5000; // Wait 5 seconds for pong response

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

    // Start ping interval
    pingInterval = setInterval(() => {
      ws.ping();
      // Set timeout for pong response
      pingTimeout = setTimeout(() => {
        logger.warn("No pong received - closing connection");
        ws.terminate();
      }, PING_TIMEOUT);
    }, PING_INTERVAL);
  });

  ws.on("pong", () => {
    // Clear the timeout when pong is received
    clearTimeout(pingTimeout);
  });

  ws.on("close", () => {
    // Clean up intervals on close
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
 * Handle WebSocket connection close
 * @param {number} retryCount Current retry attempt
 * @param {number} retryDelay Current delay between retries
 */
function handleWebSocketClose(retryCount, retryDelay) {
  if (retryCount < WS_RECONNECT_MAX_RETRIES) {
    logger.warn(
      `WebSocket connection closed. Attempting to reconnect in ${
        retryDelay / 1000
      } seconds...`
    );
    setTimeout(authenticateAndConnect, retryDelay);
  } else {
    logger.error(
      "Maximum retry attempts reached. Please check the connection."
    );
  }
}

/**
 * Handle authentication errors
 * @param {Error} error Authentication error
 */
function handleAuthenticationError(error) {
  if (error.response) {
    logger.error(
      `Authentication failed with status ${
        error.response.status
      }: ${JSON.stringify(error.response.data)}`
    );
  } else if (error.request) {
    logger.error("No response received from backend:", error.request);
  } else {
    logger.error("Error in authentication request:", error.message);
  }
}

/**
 * Handle incoming messages from backend
 * @param {Object} message The message object received
 */
function handleMessage(message) {
  switch (message.type) {
    case "deploy_app":
      handleDeployApp(message);
      break;

    case "create_database":
      createDatabase(message.payload);
      break;

    case "check_repository":
      checkRepositoryAccess(message.payload, ws);
      break;

    default:
      logger.warn("Unknown message type:", message.type);
  }
}

/**
 * Handle deploy app message
 * @param {Object} message Deploy app message
 */
function handleDeployApp(message) {
  if (message.payload.githubToken) {
    logger.info("Deploying with GitHub App authentication");
    process.env.GITHUB_TOKEN = message.payload.githubToken;
  }

  ZeroDowntimeDeployer.deploy(message.payload, ws).finally(() => {
    if (process.env.GITHUB_TOKEN) {
      delete process.env.GITHUB_TOKEN;
    }
  });
}

/**
 * Handle database creation requests
 * @param {Object} payload The payload containing database details
 */
async function createDatabase(payload) {
  const { databaseId, dbName, username, password } = payload;

  try {
    if (!databaseId || !dbName || !username || !password) {
      throw new Error("Missing required parameters for database creation.");
    }

    logger.info(`Creating database ${dbName} with user ${username}`);

    const mongoManager = require("./utils/mongoManager");
    const result = await mongoManager.createDatabaseAndUser(
      dbName,
      username,
      password
    );

    logger.info(
      `Database ${dbName} and user ${username} created successfully.`
    );

    sendWebSocketMessage("database_created", {
      databaseId,
      status: "success",
      message: `Database ${dbName} created successfully.`,
    });
  } catch (error) {
    logger.error("Database creation failed:", error);
    sendWebSocketMessage("database_creation_failed", {
      databaseId,
      status: "failed",
      message: error.message || "Database creation failed.",
    });
  }
}

/**
 * Send message through WebSocket
 * @param {string} type Message type
 * @param {Object} payload Message payload
 */
function sendWebSocketMessage(type, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    logger.warn(`WebSocket is not open. Cannot send ${type} message.`);
    return;
  }

  ws.send(JSON.stringify({ type, payload }));
}

/**
 * Collect and send system metrics
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
 * Get CPU usage percentage
 * @returns {string} CPU usage percentage
 */
function getCPUUsage() {
  const cpus = os.cpus();
  let user = 0,
    nice = 0,
    sys = 0,
    idle = 0,
    irq = 0;

  for (const cpu of cpus) {
    user += cpu.times.user;
    nice += cpu.times.nice;
    sys += cpu.times.sys;
    idle += cpu.times.idle;
    irq += cpu.times.irq;
  }

  const total = user + nice + sys + idle + irq;
  return (((total - idle) / total) * 100).toFixed(2);
}

/**
 * Get memory usage percentage
 * @returns {string} Memory usage percentage
 */
function getMemoryUsage() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return (((totalMem - freeMem) / totalMem) * 100).toFixed(2);
}

/**
 * Get disk usage percentage
 * @returns {number|null} Disk usage percentage or null if error
 */
function getDiskUsage() {
  try {
    const output = execSync("df / --output=pcent | tail -1").toString().trim();
    return parseInt(output.replace("%", ""), 10);
  } catch (error) {
    logger.error("Error fetching disk usage:", error.message);
    return null;
  }
}

/**
 * Initialize agent operations
 */
async function init() {
  try {
    // Verify MongoDB configuration first
    if (!initializeMongoDB()) {
      throw new Error("MongoDB initialization failed");
    }

    // Initialize MongoDB manager
    const mongoManager = require("./utils/mongoManager");
    await mongoManager.initializeManagerUser();

    // Check permissions
    const permissionsOk = await ensureDeploymentPermissions();
    if (!permissionsOk) {
      throw new Error("Critical: Permission check failed");
    }

    // Connect to backend
    await authenticateAndConnect();
    setInterval(collectMetrics, METRICS_INTERVAL);

    logger.info("CloudLunacy Deployment Agent initialized successfully");
  } catch (error) {
    logger.error("Initialization failed:", error.message);
    process.exit(1);
  }
}

// Start the agent
init();
