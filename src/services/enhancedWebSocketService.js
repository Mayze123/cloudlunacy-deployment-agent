// src/services/enhancedWebSocketService.js

/**
 * Enhanced WebSocket Service for CloudLunacy Agent
 *
 * Implements production-grade WebSocket connection with:
 * - Proper authentication
 * - Registration with capabilities
 * - Heartbeat mechanism (every 30 seconds)
 * - Automatic reconnection with exponential backoff
 * - Real-time metrics reporting
 */

const WebSocket = require("ws");
const EventEmitter = require("events");
const os = require("os");
const logger = require("../../utils/logger");
const config = require("../config");

class EnhancedWebSocketService extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.initialized = false;
    this.connected = false;
    this.registered = false;

    // Connection management
    this.retryCount = 0;
    this.maxRetries = 10;
    this.retryDelay = 2000; // Start with 2 seconds
    this.maxRetryDelay = 60000; // Max 60 seconds

    // Heartbeat management
    this.heartbeatInterval = null;
    this.heartbeatIntervalMs = 30000; // 30 seconds
    this.connectionTimeout = 60000; // 60 seconds

    // Connection health monitoring
    this.pingInterval = null;
    this.pingTimeout = null;
    this.pingIntervalMs = 20000; // 20 seconds
    this.pingTimeoutMs = 5000; // 5 seconds

    // Agent capabilities and metadata
    this.agentCapabilities = [
      "deployment",
      "docker",
      "mongodb",
      "metrics",
      "logs",
    ];
    this.agentVersion = process.env.AGENT_VERSION || "1.0.0";
    this.serverId = process.env.SERVER_ID;
    this.websocketToken = null;
  }

  /**
   * Initialize the enhanced WebSocket service
   */
  async initialize() {
    if (this.initialized) return true;

    try {
      logger.info("Initializing Enhanced WebSocket service...");

      // Validate required configuration
      if (!this.serverId) {
        throw new Error("SERVER_ID environment variable is required");
      }

      // Get authentication token
      await this.getAuthToken();

      this.initialized = true;
      logger.info("Enhanced WebSocket service initialized successfully");
      return true;
    } catch (error) {
      logger.error(
        `Failed to initialize Enhanced WebSocket service: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Get authentication token from auth service
   */
  async getAuthToken() {
    try {
      const authService = require("./authenticationService");
      this.websocketToken = authService.getWebSocketToken();

      if (!this.websocketToken) {
        // Fallback to API token
        this.websocketToken = config.api.token;
        logger.warn("Using API token as WebSocket token fallback");
      }

      logger.info("WebSocket authentication token obtained");
    } catch (error) {
      logger.warn(`Could not get auth token: ${error.message}`);
      this.websocketToken = config.api.token;
    }
  }

  /**
   * Connect to the backend WebSocket server
   */
  async connect() {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const wsUrl = `${config.websocket.url}/agent`;
      logger.info(`Connecting to WebSocket server: ${wsUrl}`);

      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.websocketToken}`,
          "User-Agent": `CloudLunacy-Agent/${this.agentVersion}`,
          "X-Agent-ID": this.serverId,
        },
      });

      this.setupEventHandlers();
    } catch (error) {
      logger.error(`Failed to connect to WebSocket: ${error.message}`);
      this.scheduleReconnect();
    }
  }

  /**
   * Setup WebSocket event handlers
   */
  setupEventHandlers() {
    this.ws.on("open", () => {
      this.handleConnectionOpen();
    });

    this.ws.on("message", (data) => {
      this.handleMessage(data);
    });

    this.ws.on("close", (code, reason) => {
      this.handleConnectionClose(code, reason);
    });

    this.ws.on("error", (error) => {
      this.handleConnectionError(error);
    });

    this.ws.on("pong", () => {
      this.handlePong();
    });
  }

  /**
   * Handle connection open
   */
  handleConnectionOpen() {
    logger.info("WebSocket connection established");

    this.connected = true;
    this.retryCount = 0;
    this.retryDelay = 2000; // Reset retry delay

    // Start registration process
    this.sendRegistration();

    // Start connection health monitoring
    this.startPingMonitoring();

    // Emit connection event
    this.emit("connected");
  }

  /**
   * Handle incoming message
   */
  handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case "register_ack":
          this.handleRegistrationAck(message);
          break;
        case "heartbeat_ack":
          this.handleHeartbeatAck(message);
          break;
        default:
          // Forward to existing message handler for compatibility
          const messageHandler = require("../controllers/messageHandler");
          messageHandler.handleMessage(message, this.ws);
      }
    } catch (error) {
      logger.error(`Error parsing WebSocket message: ${error.message}`);
    }
  }

  /**
   * Handle connection close
   */
  handleConnectionClose(code, reason) {
    logger.warn(`WebSocket connection closed: ${code} ${reason}`);

    this.connected = false;
    this.registered = false;

    // Clear intervals
    this.clearIntervals();

    // Emit disconnection event
    this.emit("disconnected", { code, reason });

    // Schedule reconnection if not intentional shutdown
    if (code !== 1000) {
      this.scheduleReconnect();
    }
  }

  /**
   * Handle connection error
   */
  handleConnectionError(error) {
    logger.error(`WebSocket connection error: ${error.message}`);
    this.emit("error", error);
  }

  /**
   * Handle pong response
   */
  handlePong() {
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
  }

  /**
   * Send registration message
   */
  sendRegistration() {
    const registrationMessage = {
      type: "register",
      agentId: this.serverId,
      capabilities: this.agentCapabilities,
      version: this.agentVersion,
      metadata: {
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        hostname: os.hostname(),
        startTime: Date.now(),
      },
    };

    this.sendMessage(registrationMessage);
    logger.info(`Registration message sent for agent: ${this.serverId}`);
  }

  /**
   * Handle registration acknowledgment
   */
  handleRegistrationAck(message) {
    if (message.success) {
      logger.info("Agent registration confirmed by backend");
      this.registered = true;

      // Start heartbeat after successful registration
      this.startHeartbeat(message.heartbeatInterval);

      this.emit("registered");
    } else {
      logger.error("Agent registration failed:", message.error);
      this.emit("registration_failed", message.error);
    }
  }

  /**
   * Handle heartbeat acknowledgment
   */
  handleHeartbeatAck(message) {
    logger.debug("Heartbeat acknowledged by backend");
    this.emit("heartbeat_ack", message);
  }

  /**
   * Start heartbeat mechanism
   */
  startHeartbeat(intervalMs) {
    // Use server-provided interval or default
    const interval = intervalMs || this.heartbeatIntervalMs;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, interval);

    logger.info(`Heartbeat started with ${interval}ms interval`);
  }

  /**
   * Send heartbeat with metrics
   */
  sendHeartbeat() {
    if (!this.connected || !this.registered) {
      return;
    }

    const metrics = this.collectMetrics();

    const heartbeatMessage = {
      type: "heartbeat",
      agentId: this.serverId,
      timestamp: Date.now(),
      metrics,
    };

    this.sendMessage(heartbeatMessage);
    logger.debug("Heartbeat sent to backend");
  }

  /**
   * Collect system metrics
   */
  collectMetrics() {
    try {
      const loadAvg = os.loadavg();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;

      return {
        cpu: {
          loadAverage: loadAvg,
          count: os.cpus().length,
        },
        memory: {
          total: totalMem,
          used: usedMem,
          free: freeMem,
          usagePercent: Math.round((usedMem / totalMem) * 100),
        },
        uptime: os.uptime(),
        platform: os.platform(),
        arch: os.arch(),
      };
    } catch (error) {
      logger.error(`Error collecting metrics: ${error.message}`);
      return {};
    }
  }

  /**
   * Start ping monitoring for connection health
   */
  startPingMonitoring() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    this.pingInterval = setInterval(() => {
      if (this.connected && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();

        // Set timeout for pong response
        this.pingTimeout = setTimeout(() => {
          logger.warn("No pong received - connection may be dead");
          this.ws.terminate();
        }, this.pingTimeoutMs);
      }
    }, this.pingIntervalMs);
  }

  /**
   * Clear all intervals and timeouts
   */
  clearIntervals() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  scheduleReconnect() {
    if (this.retryCount >= this.maxRetries) {
      logger.error("Maximum reconnection attempts reached");
      this.emit("max_retries_reached");
      return;
    }

    this.retryCount++;

    logger.info(
      `Scheduling reconnection attempt ${this.retryCount}/${this.maxRetries} in ${this.retryDelay}ms`,
    );

    setTimeout(() => {
      this.connect();
    }, this.retryDelay);

    // Exponential backoff with jitter
    this.retryDelay = Math.min(
      this.retryDelay * 2 + Math.random() * 1000,
      this.maxRetryDelay,
    );
  }

  /**
   * Send message to backend
   */
  sendMessage(message) {
    if (this.connected && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
        return true;
      } catch (error) {
        logger.error(`Error sending message: ${error.message}`);
        return false;
      }
    } else {
      logger.warn("Cannot send message - WebSocket not connected");
      return false;
    }
  }

  /**
   * Send status update
   */
  sendStatusUpdate(status, data = {}) {
    const statusMessage = {
      type: "status",
      agentId: this.serverId,
      status,
      timestamp: Date.now(),
      ...data,
    };

    return this.sendMessage(statusMessage);
  }

  /**
   * Send metrics update
   */
  sendMetricsUpdate(metrics) {
    const metricsMessage = {
      type: "metrics",
      agentId: this.serverId,
      timestamp: Date.now(),
      metrics,
    };

    return this.sendMessage(metricsMessage);
  }

  /**
   * Disconnect and cleanup
   */
  async disconnect() {
    logger.info("Disconnecting Enhanced WebSocket service");

    this.clearIntervals();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Send goodbye message
      this.sendMessage({
        type: "goodbye",
        agentId: this.serverId,
        reason: "Agent shutting down",
      });

      // Close connection gracefully
      this.ws.close(1000, "Agent shutdown");
    }

    this.connected = false;
    this.registered = false;
    this.ws = null;

    this.emit("disconnected", { code: 1000, reason: "Intentional shutdown" });
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      initialized: this.initialized,
      connected: this.connected,
      registered: this.registered,
      retryCount: this.retryCount,
      serverId: this.serverId,
      capabilities: this.agentCapabilities,
      version: this.agentVersion,
    };
  }

  /**
   * Shutdown the service
   */
  async shutdown() {
    logger.info("Shutting down Enhanced WebSocket service");
    await this.disconnect();
    this.initialized = false;
    this.removeAllListeners();
  }
}

module.exports = new EnhancedWebSocketService();
