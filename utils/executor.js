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
 * @param {Object} options - Command execution options
 * @param {String} options.cwd - Working directory
 * @param {Boolean} options.ignoreError - Whether to ignore command errors
 * @param {Boolean} options.silent - Whether to suppress logging
 * @returns {Promise} - Resolves with command output object
 */
function executeCommand(command, args = [], options = {}) {
    const {
        cwd = process.cwd(),
        ignoreError = false,
        silent = false,
        env = { ...process.env }
    } = options;

    // Append common paths if needed
    env.PATH = env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
    // Ensure standard directories are included
    env.PATH += ':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

    if (!silent) {
        logger.debug(`Executing command: ${command} ${args.join(' ')}`);
        logger.debug(`Using PATH: ${env.PATH}`);
    }

    return new Promise((resolve, reject) => {
        const cmd = spawn(command, args, { 
            cwd,
            env,
            stdio: ['inherit', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        cmd.stdout.on('data', (data) => {
            stdout += data.toString();
            if (!silent) {
                logger.debug(`stdout: ${data.toString().trim()}`);
            }
        });

        cmd.stderr.on('data', (data) => {
            stderr += data.toString();
            if (!silent) {
                logger.debug(`stderr: ${data.toString().trim()}`);
            }
        });

        cmd.on('close', (code) => {
            const output = {
                code,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                success: code === 0
            };

            if (code !== 0 && !ignoreError) {
                if (!silent) {
                    logger.error(`Command failed: ${command} ${args.join(' ')}`);
                    logger.error(`Exit code: ${code}`);
                    if (stderr) logger.error(`stderr: ${stderr}`);
                }
                reject(new Error(`Command failed with exit code ${code}\nStderr: ${stderr}`));
            } else {
                if (!silent && !ignoreError) {
                    logger.debug(`Command succeeded: ${command} ${args.join(' ')}`);
                    if (stdout) logger.debug(`stdout: ${stdout}`);
                }
                resolve(output);
            }
        });

        cmd.on('error', (error) => {
            if (!silent) {
                logger.error(`Failed to start command: ${command} ${args.join(' ')}`);
                logger.error(`Error: ${error.message}`);
            }
            reject(new Error(`Failed to execute command: ${error.message}`));
        });
    });
}

/**
 * Executes a command and returns only the stdout if successful
 * @param {String} command - The command to execute
 * @param {Array} args - The list of string arguments
 * @param {Object} options - Command execution options
 * @returns {Promise<String>} - Resolves with stdout string
 */
async function getCommandOutput(command, args = [], options = {}) {
    const result = await executeCommand(command, args, { ...options, silent: true });
    return result.stdout;
}

module.exports = { 
    executeCommand,
    getCommandOutput
};