const { spawn } = require('child_process');
const logger = require('./logger');

function executeCommand(command, args = [], options = {}) {
    const {
        cwd = process.cwd(),
        ignoreError = false,
        silent = false,
        env = { ...process.env },
        logOutput = true // New option to control logging
    } = options;

    // Ensure PATH includes standard directories
    const standardPaths = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    const currentPaths = (env.PATH || '').split(':');
    const allPaths = new Set([...currentPaths, ...standardPaths]);
    env.PATH = Array.from(allPaths).filter(Boolean).join(':');

    logger.debug(`Executing command: ${command} ${args.join(' ')}`);

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
            if (logOutput && !silent) {
                // Log each line separately for better readability
                output.split('\n').filter(line => line.trim()).forEach(line => {
                    logger.info(`[stdout] ${line.trim()}`);
                });
            }
        });

        cmd.stderr.on('data', (data) => {
            const output = data.toString();
            stderr += output;
            if (logOutput && !silent) {
                // Log each line separately and mark warnings/errors appropriately
                output.split('\n').filter(line => line.trim()).forEach(line => {
                    if (line.toLowerCase().includes('error')) {
                        logger.error(`[stderr] ${line.trim()}`);
                    } else if (line.toLowerCase().includes('warn')) {
                        logger.warn(`[stderr] ${line.trim()}`);
                    } else {
                        logger.info(`[stderr] ${line.trim()}`);
                    }
                });
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
                    if (stderr) {
                        stderr.split('\n').filter(line => line.trim()).forEach(line => {
                            logger.error(`[stderr] ${line.trim()}`);
                        });
                    }
                }
                const error = new Error(`Command failed with exit code ${code}`);
                error.code = code;
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
            } else {
                if (!silent && stdout) {
                    logger.debug(`Command succeeded: ${command} ${args.join(' ')}`);
                }
                resolve(output);
            }
        });

        cmd.on('error', (error) => {
            logger.error(`Failed to start command: ${command} ${args.join(' ')}`);
            logger.error(`Error: ${error.message}`);
            error.stdout = stdout.trim();
            error.stderr = stderr.trim();
            reject(error);
        });
    });
}

module.exports = {
    executeCommand,
    getCommandOutput: async (command, args = [], options = {}) => {
        const result = await executeCommand(command, args, { ...options, silent: true });
        return result.stdout;
    }
};