// agent.js

/**
 * CloudLunacy Deployment Agent
 * Version: 1.0.0
 * Author: Mahamadou Taibou
 * Date: 2024-04-27
 *
 * Description:
 * This script serves as the core of the CloudLunacy Deployment Agent installed on a user's VPS.
 * It handles secure communication with the SaaS backend, authenticates the agent,
 * receives commands, and delegates tasks to specific deployment modules.
 */

// Import necessary modules
const axios = require("axios");
const WebSocket = require("ws");
const dotenv = require("dotenv");
const logger = require("./utils/logger");
const { ensureDeploymentPermissions } = require("./utils/permissionCheck");
const ZeroDowntimeDeployer = require("./modules/zeroDowntimeDeployer");

// Load environment variables
dotenv.config();

// Configuration
const BACKEND_URL = process.env.BACKEND_URL;
const AGENT_API_TOKEN = process.env.AGENT_API_TOKEN;
const SERVER_ID = process.env.SERVER_ID;

// MongoDB management user credentials
process.env.MONGO_MANAGER_USERNAME = process.env.MONGO_MANAGER_USERNAME || "";
process.env.MONGO_MANAGER_PASSWORD = process.env.MONGO_MANAGER_PASSWORD || "";
process.env.MONGO_TLS_CA_FILE = process.env.MONGO_TLS_CA_FILE || "";

if (
  !process.env.MONGO_MANAGER_USERNAME ||
  !process.env.MONGO_MANAGER_PASSWORD
) {
  logger.error(
    "Missing MongoDB management user credentials. Ensure MongoDB is set up correctly."
  );
  process.exit(1);
}

if (!process.env.MONGO_TLS_CA_FILE) {
  logger.error(
    "Missing MongoDB TLS CA file path. Ensure MongoDB is set up correctly."
  );
  process.exit(1);
}

if (
  !process.env.MONGO_INITDB_ROOT_USERNAME ||
  !process.env.MONGO_INITDB_ROOT_PASSWORD
) {
  logger.error(
    "Missing MongoDB root credentials. Ensure MongoDB is set up correctly."
  );
  process.exit(1);
}

// Initialize WebSocket connection
let ws;

/**
 * Authenticate with backend and establish WebSocket connection
 */
async function authenticateAndConnect() {
  try {
    logger.info("Authenticating with backend...");
    // Authenticate with the backend to receive WebSocket URL
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

    // Establish WebSocket connection
    ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${AGENT_API_TOKEN}`,
      },
    });

    ws.on("open", () => {
      logger.info("WebSocket connection established.");
      // Optionally, send a registration message
      ws.send(JSON.stringify({ type: "register", serverId: SERVER_ID }));
    });

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data);
        handleMessage(message);
      } catch (error) {
        logger.error("Failed to parse message:", error);
      }
    });

    const MAX_RETRIES = 5;
    let retryCount = 0;
    let retryDelay = 5000; // Start with 5 seconds

    ws.on("close", () => {
      if (retryCount < MAX_RETRIES) {
        logger.warn(
          `WebSocket connection closed. Attempting to reconnect in ${
            retryDelay / 1000
          } seconds...`
        );
        setTimeout(() => {
          retryCount++;
          retryDelay *= 2; // Exponential backoff
          authenticateAndConnect();
        }, retryDelay);
      } else {
        logger.error(
          "Maximum retry attempts reached. Please check the connection."
        );
      }
    });

    ws.on("error", (error) => {
      logger.error("WebSocket error:", error);
      ws.close();
    });
  } catch (error) {
    // logger.error('Authentication failed:', error.message);
    // logger.info('Retrying authentication in 5 seconds...');
    // setTimeout(authenticateAndConnect, 5000);
    if (error.response) {
      // The request was made and the server responded with a status code outside the range of 2xx
      logger.error(
        `Authentication failed with status ${
          error.response.status
        }: ${JSON.stringify(error.response.data)}`
      );
    } else if (error.request) {
      // The request was made but no response was received
      logger.error("No response received from backend:", error.request);
    } else {
      // Something happened in setting up the request that triggered an Error
      logger.error("Error in authentication request:", error.message);
    }
  }
}

/**
 * Handle incoming messages from backend
 * @param {Object} message - The message object received
 */
function handleMessage(message) {
  switch (message.type) {
    case "deploy_app":
      // Validate GitHub-specific fields if present
      if (message.payload.githubToken) {
        logger.info("Deploying with GitHub App authentication");
        // Store token temporarily for this deployment
        process.env.GITHUB_TOKEN = message.payload.githubToken;
      }

      ZeroDowntimeDeployer.deploy(message.payload, ws).finally(() => {
        if (process.env.GITHUB_TOKEN) {
          delete process.env.GITHUB_TOKEN;
        }
      });
      break;

    case "create_database":
      createDatabase(message.payload);
      break;

    case "check_repository":
      // New handler for repository checks
      checkRepositoryAccess(message.payload, ws);
      break;

    default:
      logger.warn("Unknown message type:", message.type);
  }
}

/**
 * Handle database creation requests
 * @param {Object} payload - The payload containing database details
 */
async function createDatabase(payload) {
  const { databaseId, dbName, username, password } = payload;

  try {
    // Validate input
    if (!databaseId || !dbName || !username || !password) {
      throw new Error("Missing required parameters for database creation.");
    }

    logger.info(`Creating database ${dbName} with user ${username}`);

    const result = await mongoManager.createDatabaseAndUser(
      dbName,
      username,
      password
    );

    logger.info(
      `Database ${dbName} and user ${username} created successfully.`
    );

    // Send success message back to backend
    ws.send(
      JSON.stringify({
        type: "database_created",
        payload: {
          databaseId,
          status: "success",
          message: `Database ${dbName} created successfully.`,
        },
      })
    );
  } catch (error) {
    logger.error("Database creation failed:", error);

    // Send error message back to backend
    ws.send(
      JSON.stringify({
        type: "database_creation_failed",
        payload: {
          databaseId,
          status: "failed",
          message: error.message || "Database creation failed.",
        },
      })
    );
  }
}

/**
 * Collect system metrics and send to backend
 */
function collectMetrics() {
  const cpuUsage = getCPUUsage();
  const memoryUsage = getMemoryUsage();
  const diskUsage = getDiskUsage();

  const metrics = {
    cpuUsage, // Percentage
    memoryUsage, // Percentage
    diskUsage, // Percentage
  };

  sendMetrics(metrics);
}

/**
 * Helper functions to retrieve system metrics
 */
const os = require("os");

function getCPUUsage() {
  const cpus = os.cpus();

  let user = 0;
  let nice = 0;
  let sys = 0;
  let idle = 0;
  let irq = 0;

  for (let cpu of cpus) {
    user += cpu.times.user;
    nice += cpu.times.nice;
    sys += cpu.times.sys;
    idle += cpu.times.idle;
    irq += cpu.times.irq;
  }

  const total = user + nice + sys + idle + irq;
  const usage = ((total - idle) / total) * 100;
  return usage.toFixed(2);
}

function getMemoryUsage() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = ((totalMem - freeMem) / totalMem) * 100;
  return usedMem.toFixed(2);
}

function getDiskUsage() {
  // Requires 'df' command
  try {
    const { execSync } = require("child_process");
    const output = execSync("df / --output=pcent | tail -1").toString().trim();
    const usage = parseInt(output.replace("%", ""), 10);
    return usage;
  } catch (error) {
    logger.error("Error fetching disk usage:", error.message);
    return null;
  }
}

/**
 * Send metrics data to backend
 * @param {Object} metrics - The metrics data
 */
function sendMetrics(metrics) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    logger.warn("WebSocket is not open. Cannot send metrics.");
    return;
  }

  ws.send(
    JSON.stringify({
      type: "metrics",
      payload: metrics,
    })
  );
}

/**
 * Initialize agent operations
 */
// At the start of your init() function in agent.js
async function init() {
  try {
    // Initialize MongoDB first
    const mongoManager = require("./utils/mongoManager");
    await mongoManager.initializeManagerUser();

    // Then check permissions
    const permissionsOk = await ensureDeploymentPermissions();
    if (!permissionsOk) {
      logger.error(
        "Critical: Permission check failed. Agent may not function correctly."
      );
    }

    // Continue with normal initialization
    await authenticateAndConnect();
    setInterval(collectMetrics, 60000);
  } catch (error) {
    logger.error("Initialization failed:", error);
    process.exit(1);
  }
}

// Start the agent
init();
