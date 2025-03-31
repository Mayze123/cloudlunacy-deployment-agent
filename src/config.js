/**
 * Configuration
 *
 * Centralizes the configuration for the CloudLunacy Deployment Agent.
 * Loads environment variables and provides defaults.
 */

const path = require("path");
const dotenv = require("dotenv");

// Load environment variables
if (process.env.NODE_ENV === "development") {
  dotenv.config({ path: path.join(process.cwd(), ".env.dev") });
} else {
  dotenv.config({ path: "/opt/cloudlunacy/.env" });
}

// Determine if we're in development mode
const isDevelopment = process.env.NODE_ENV === "development";

// Base paths
const basePath = isDevelopment
  ? path.join(process.cwd(), "dev-cloudlunacy")
  : "/opt/cloudlunacy";

// Configuration object
const config = {
  // Environment
  isDevelopment,
  environment: process.env.NODE_ENV || "production",

  // Server identity
  serverId: process.env.SERVER_ID || "dev-server-id",

  // API configuration
  api: {
    backendUrl: process.env.BACKEND_URL || "https://api.cloudlunacy.uk",
    frontApiUrl: process.env.FRONT_API_URL || "https://proxy.cloudlunacy.uk",
    token: process.env.AGENT_API_TOKEN,
    jwt: process.env.AGENT_JWT,
  },

  // Paths
  paths: {
    base: basePath,
    logs: path.join(basePath, "logs"),
    apps: path.join(basePath, "apps"),
    certs: path.join(basePath, "certs"),
    cache: path.join(basePath, "cache"),
    temp: path.join(basePath, "temp"),
    jwtFile: path.join(basePath, ".agent_jwt.json"),
  },

  // Database
  database: {
    enabled:
      process.env.DATABASE_ENABLED === "true" ||
      process.env.MONGODB_ENABLED === "true",
    mongodb: {
      enabled: process.env.MONGODB_ENABLED === "true",
      host: process.env.MONGO_HOST || "localhost",
      port: process.env.MONGO_PORT || 27017,
      username: process.env.MONGO_MANAGER_USERNAME,
      password: process.env.MONGO_MANAGER_PASSWORD,
      database: process.env.MONGO_DATABASE || "admin",
      domain: process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk",
      useTls: true, // Always true with HAProxy Data Plane API
    },
  },

  // WebSocket
  websocket: {
    reconnectMaxRetries: parseInt(
      process.env.WS_RECONNECT_MAX_RETRIES || "5",
      10,
    ),
    initialRetryDelay: parseInt(
      process.env.WS_INITIAL_RETRY_DELAY || "5000",
      10,
    ),
  },

  // Health check
  health: {
    port: parseInt(process.env.HEALTH_PORT || "8081", 10),
  },

  // Deployment
  deployment: {
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT_DEPLOYMENTS || "2", 10),
    timeout: parseInt(process.env.DEPLOYMENT_TIMEOUT || "300000", 10), // 5 minutes
  },

  // Metrics collection
  metrics: {
    interval: parseInt(process.env.METRICS_INTERVAL || "60000", 10), // 1 minute
    enabled: process.env.METRICS_ENABLED !== "false", // Enabled by default
  },
};

module.exports = config;
