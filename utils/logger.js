const { createLogger, format, transports } = require('winston');
const fs = require('fs');

const logDir = '/opt/cloudlunacy/logs';
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

const logFormat = format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(info => {
        const meta = info.meta ? ` ${JSON.stringify(info.meta)}` : '';
        return `${info.timestamp} [${info.level.toUpperCase()}]: ${info.message}${meta}`;
    })
);

const logger = createLogger({
    level: 'debug', // Changed from 'info' to 'debug'
    format: logFormat,
    transports: [
        new transports.Console({
            format: format.combine(
                format.colorize(),
                logFormat
            )
        }),
        new transports.File({ 
            filename: `${logDir}/agent.log`,
            maxsize: 5242880, // 5MB
            maxFiles: 5
        })
    ],
    exitOnError: false
});

module.exports = logger;