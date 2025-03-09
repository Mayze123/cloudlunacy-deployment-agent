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

// Load environment variables
dotenv.config();

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
const BACKEND_URL = process.env.BACKEND_URL;
const AGENT_API_TOKEN = process.env.AGENT_API_TOKEN;
const AGENT_JWT = process.env.AGENT_JWT; // JWT from registration
const SERVER_ID = process.env.SERVER_ID;
const WS_RECONNECT_MAX_RETRIES = 5;
const WS_INITIAL_RETRY_DELAY = 5000;
const METRICS_INTERVAL = 60000;

// Initialize WebSocket connection variable
let ws;

/**
 * In the new architecture, MongoDB TLS termination is handled by the front server.
 * Thus, we no longer verify or require a TLS CA file for MongoDB in the agent.
 */
const initializeMongoDB = () => {
  // If your agent still needs to perform some MongoDB operations directly,
  // ensure that the environment variables (like MONGO_MANAGER_USERNAME, etc.)
  // are set properly. Otherwise, simply log that initialization is complete.
  logger.info(
    "MongoDB initialization: TLS verification is handled by the front server.",
  );
  return true;
};

/**
 * Authenticate with the backend and establish a WebSocket connection.
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
 * Handle database creation requests.
 * @param {Object} payload Payload containing database details.
 */
async function createDatabase(payload) {
  const { databaseId, dbName, username, password } = payload;

  try {
    if (!databaseId || !dbName || !username || !password) {
      throw new Error("Missing required parameters for database creation.");
    }

    logger.info(`Creating database ${dbName} with user ${username}`);
    const mongoManager = require("./utils/mongoManager");
    await mongoManager.createDatabaseAndUser(dbName, username, password);

    logger.info(
      `Database ${dbName} and user ${username} created successfully.`,
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
    const output = execSync("df / --output=pcent | tail -1").toString().trim();
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
    // MongoDB initialization: No TLS CA verification needed on the agent side anymore.
    if (!initializeMongoDB()) {
      throw new Error("MongoDB initialization failed");
    }

    // Initialize MongoDB manager (if used for administrative tasks).
    const mongoManager = require("./utils/mongoManager");
    await mongoManager.initializeManagerUser();

    // Check deployment permissions.
    const permissionsOk = await ensureDeploymentPermissions();
    if (!permissionsOk) {
      throw new Error("Critical: Permission check failed");
    }

    // Connect to the backend.
    await authenticateAndConnect();

    // Register MongoDB with front server if not already registered
    try {
      // Only attempt this if we have the necessary environment variables
      if (FRONT_API_URL && AGENT_JWT) {
        logger.info("Checking MongoDB registration with front server...");

        // Get the local IP address for MongoDB registration
        const LOCAL_IP = await getPublicIp();

        // Attempt to register MongoDB
        const response = await axios.post(
          `${FRONT_API_URL}/api/frontdoor/add-subdomain`,
          {
            subdomain: "mongodb", // Using "mongodb" will trigger the agentId.mongodb.domain pattern
            targetIp: LOCAL_IP,
          },
          {
            headers: {
              Authorization: `Bearer ${AGENT_JWT}`,
              "Content-Type": "application/json",
            },
          },
        );

        if (response.data && response.data.success) {
          logger.info("MongoDB successfully registered with front server", {
            domain: response.data.details.domain,
          });
        } else {
          logger.warn("Unexpected response when registering MongoDB", {
            response: response.data,
          });
        }
      } else {
        logger.warn(
          "Missing FRONT_API_URL or AGENT_JWT, cannot register MongoDB",
        );
      }
    } catch (mongoRegErr) {
      logger.error(
        "Error registering MongoDB with front server:",
        mongoRegErr.message,
      );
      logger.info(
        "Continuing agent initialization despite MongoDB registration issue",
      );
    }

    setInterval(collectMetrics, METRICS_INTERVAL);

    logger.info("CloudLunacy Deployment Agent initialized successfully");
  } catch (error) {
    logger.error("Initialization failed:", error.message);
    process.exit(1);
  }
}

/**
 * Get the public/local IP address of this server.
 * @returns {string} IP address
 */
async function getPublicIp() {
  try {
    // First try to get the server's own IP address
    const { stdout } = await executeCommand("hostname", ["-I"]);
    const localIp = stdout.trim().split(" ")[0];
    if (localIp) {
      return localIp;
    }

    // If local command fails, try external service
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
