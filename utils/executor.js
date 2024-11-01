// utils/executor.js

/**
 * Executor Utility
 * Description:
 * Provides a function to execute shell commands with proper error handling.
 * Ensures consistent execution of commands across different modules.
 */

const { spawn } = require('child_process');
const logger = require('./logger');

/**
 * Executes a shell command asynchronously.
 * @param {String} command - The command to execute
 * @param {Array} args - The list of string arguments
 * @param {String} cwd - (Optional) The working directory to execute the command in
 * @returns {Promise} - Resolves on successful execution, rejects on error
 */
function executeCommand(command, args = [], cwd = process.cwd()) {
    return new Promise((resolve, reject) => {
        const cmd = spawn(command, args, { cwd });

        let stdout = '';
        let stderr = '';

        cmd.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        cmd.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        cmd.on('close', (code) => {
            if (code !== 0) {
                logger.error(`Command failed: ${command} ${args.join(' ')}`);
                logger.error(`Stderr: ${stderr}`);
                return reject(new Error(`Command failed with exit code ${code}`));
            } else {
                logger.debug(`Command succeeded: ${command} ${args.join(' ')}`);
                logger.debug(`Stdout: ${stdout}`);
                resolve(stdout);
            }
        });

        cmd.on('error', (error) => {
            logger.error(`Failed to start command: ${command} ${args.join(' ')}`);
            logger.error(`Error: ${error.message}`);
            reject(error);
        });
    });
}

module.exports = { executeCommand };