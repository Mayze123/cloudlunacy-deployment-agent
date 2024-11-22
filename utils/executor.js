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
            const output = data.toString();
            stdout += output;
            if (!silent) {
                logger.debug(`stdout: ${output.trim()}`);
            }
        });

        cmd.stderr.on('data', (data) => {
            const output = data.toString();
            stderr += output;
            if (!silent) {
                logger.debug(`stderr: ${output.trim()}`);
            }
        });

        cmd.on('close', (code) => {
            stdout = stdout.trim();
            stderr = stderr.trim();

            const output = {
                code,
                stdout,
                stderr,
                success: code === 0
            };

            if (code !== 0 && !ignoreError) {
                if (!silent) {
                    logger.error(`Command failed: ${command} ${args.join(' ')}`);
                    logger.error(`Exit code: ${code}`);
                    if (stderr) logger.error(`stderr: ${stderr}`);
                    if (stdout) logger.error(`stdout: ${stdout}`);
                }
                const error = new Error(`Command failed with exit code ${code}`);
                error.code = code;
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
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
            error.stdout = stdout.trim();
            error.stderr = stderr.trim();
            reject(error);
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