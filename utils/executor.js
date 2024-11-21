// utils/executor.js

const { spawn } = require('child_process');
const logger = require('./logger');

function executeCommand(command, args = [], options = {}) {
    const {
        cwd = process.cwd(),
        ignoreError = false,
        silent = false,
        env = { ...process.env }
    } = options;

    // Ensure that env.PATH includes standard directories without duplicates
    const standardPaths = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    const currentPaths = (env.PATH || '').split(':');
    const allPaths = new Set([...currentPaths, ...standardPaths]);
    env.PATH = Array.from(allPaths).filter(Boolean).join(':');

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

async function getCommandOutput(command, args = [], options = {}) {
    const result = await executeCommand(command, args, { ...options, silent: true });
    return result.stdout;
}

module.exports = {
    executeCommand,
    getCommandOutput
};