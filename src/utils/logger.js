/**
 * Logger Module
 *
 * Provides consistent logging functionality throughout the application
 * with proper formatting and log levels.
 */

const winston = require("winston");
const path = require("path");
const fs = require("fs");

// Create logs directory if it doesn't exist
const logsDir = process.env.LOGS_DIR || path.join(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Define log format
const logFormat = winston.format.printf(
  ({ level, message, timestamp, ...meta }) => {
    let logMessage = `${timestamp} ${level}: ${message}`;

    // Add any additional metadata if present
    if (Object.keys(meta).length > 0) {
      logMessage += ` ${JSON.stringify(meta)}`;
    }

    return logMessage;
  },
);

// Create the logger with console and file transports
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp({
      format: "YYYY-MM-DD HH:mm:ss",
    }),
    winston.format.errors({ stack: true }),
    logFormat,
  ),
  transports: [
    // Console transport
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), logFormat),
    }),

    // File transport for all logs
    new winston.transports.File({
      filename: path.join(logsDir, "agent.log"),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      tailable: true,
    }),

    // File transport for error logs only
    new winston.transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      tailable: true,
    }),
  ],
  // Don't exit on uncaught exception
  exitOnError: false,
});

// Add a stream for Morgan middleware (if used with Express)
logger.stream = {
  write: function (message) {
    logger.http(message.trim());
  },
};

module.exports = logger;
