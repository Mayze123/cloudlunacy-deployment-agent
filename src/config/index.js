/**
 * Configuration Module
 *
 * Centralizes access to environment variables and application configuration.
 * Makes it easier to manage different environments and default values.
 */

const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

// Load environment variables
dotenv.config();

// JWT file path for persistent authentication
const JWT_FILE_PATH = "/opt/cloudlunacy/.agent_jwt.json";

// Try to load JWT from file if it exists
let agentJwt = process.env.AGENT_JWT || "";
try {
  if (fs.existsSync(JWT_FILE_PATH)) {
    const data = fs.readFileSync(JWT_FILE_PATH, "utf8");
    const parsed = JSON.parse(data);
    if (parsed.token) {
      agentJwt = parsed.token;
    }
  }
} catch (err) {
  console.error(`Error loading JWT file: ${err.message}`);
}

// Environment detection
const isDevelopment = process.env.NODE_ENV === "development";

// Export configuration object
const config = {
  // Environment info
  env: process.env.NODE_ENV || "development",
  isDevelopment,

  // Server identification
  serverId: process.env.SERVER_ID || "dev-server-id",

  // API configuration
  api: {
    backendUrl: isDevelopment
      ? "http://localhost:8080"
      : process.env.BACKEND_URL,
    frontApiUrl: process.env.FRONT_API_URL,
    token: process.env.AGENT_API_TOKEN || "dev-token",
    jwt: agentJwt || "dev-jwt",
  },

  // WebSocket configuration
  websocket: {
    url: null, // Will be set by authentication service
    reconnectMaxRetries: 5,
    initialRetryDelay: 5000,
  },

  // Metrics collection configuration
  metrics: {
    interval: 60000, // 1 minute
  },

  // Database configuration
  mongodb: {
    enabled:
      !!process.env.MONGO_MANAGER_USERNAME &&
      !!process.env.MONGO_MANAGER_PASSWORD,
    username: process.env.MONGO_MANAGER_USERNAME,
    password: process.env.MONGO_MANAGER_PASSWORD,
    host: process.env.MONGO_HOST || "localhost",
    port: process.env.MONGO_PORT || 27017,
    database: process.env.MONGO_DATABASE || "admin",
    useTls: true, // TLS is always enabled
  },

  // Deployment configuration
  deployment: {
    baseDir: process.env.DEPLOY_BASE_DIR || "/opt/cloudlunacy/deployments",
    templatesDir: process.env.TEMPLATES_DIR || "/opt/cloudlunacy/templates",
  },

  // File paths
  paths: {
    jwtFile: JWT_FILE_PATH,
    envFile: isDevelopment
      ? path.join(process.cwd(), ".env.dev")
      : "/opt/cloudlunacy/.env",
  },
};

module.exports = config;
