// utils/logger.js

/**
 * Logger Utility
 * Description:
 * Provides a simple logging mechanism with different log levels.
 * Enhances consistency and readability of logs across the Deployment Agent.
 */

const { createLogger, format, transports } = require('winston');
const fs = require('fs');

// Define log directory and file
const logDir = '/opt/cloudlunacy/logs';
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

const logFormat = format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(info => `${info.timestamp} [${info.level.toUpperCase()}]: ${info.message}`)
);

// Create logger instance
const logger = createLogger({
    level: 'info',
    format: logFormat,
    transports: [
        new transports.Console(),
        new transports.File({ filename: `${logDir}/agent.log` })
    ],
    exitOnError: false
});

// Export logger
module.exports = logger;
