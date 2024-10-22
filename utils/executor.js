// utils/executor.js

/**
 * Executor Utility
 * Description:
 * Provides a function to execute shell commands with proper error handling.
 * Ensures consistent execution of commands across different modules.
 */

const { exec } = require('child_process');
const logger = require('./logger');

/**
 * Executes a shell command asynchronously.
 * @param {String} cmd - The command to execute
 * @param {String} cwd - (Optional) The working directory to execute the command in
 * @returns {Promise} - Resolves on successful execution, rejects on error
 */
function executeCommand(cmd, cwd = process.cwd()) {
    return new Promise((resolve, reject) => {
        exec(cmd, { cwd }, (error, stdout, stderr) => {
            if (error) {
                logger.error(`Command failed: ${cmd}`);
                logger.error(`Error: ${error.message}`);
                logger.error(`Stderr: ${stderr}`);
                return reject(error);
            }
            logger.debug(`Command succeeded: ${cmd}`);
            logger.debug(`Stdout: ${stdout}`);
            resolve(stdout);
        });
    });
}

module.exports = { executeCommand };
