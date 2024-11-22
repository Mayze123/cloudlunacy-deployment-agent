const { executeCommand } = require('../utils/executor');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');
const TemplateHandler = require('../utils/templateHandler');
const portManager = require('../utils/portManager');
const { ensureDeploymentPermissions } = require('../utils/permissionCheck');
const apiClient = require('../utils/apiClient');
const EnvironmentManager = require('../utils/environmentManager');

class ZeroDowntimeDeployer {
    constructor() {
        this.healthCheckRetries = 5;
        this.healthCheckInterval = 10000;
        this.startupGracePeriod = 30000;
        this.rollbackTimeout = 180000;
        this.portManager = portManager;
        this.templateHandler = null;
    }

    async deploy(payload, ws) {
        const {
            deploymentId,
            appType,
            appName,
            repositoryOwner,
            repositoryName,
            branch,
            githubToken,
            environment,
            serviceName,
            domain,
            envVarsToken
        } = payload;

        // Sanitize project name for Docker compatibility
        const projectName = `${deploymentId}-${appName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const deployDir = path.join('/opt/cloudlunacy/deployments', deploymentId);
        const backupDir = path.join(deployDir, 'backup');
        const currentDir = process.cwd();

        let oldContainer = null;
        let newContainer = null;
        let rollbackNeeded = false;
        let envManager = null;
        let envFilePath = null;

        try {
            // Initial setup and validation
            const permissionsOk = await ensureDeploymentPermissions();
            if (!permissionsOk) {
                throw new Error('Deployment failed: Permission check failed');
            }

            await this.validatePrerequisites(deployDir, backupDir);
            await this.setupDirectories(deployDir, backupDir);

            // Verify working directory
            const currentWorkDir = process.cwd();
            logger.info(`Current working directory: ${currentWorkDir}`);

            // Initialize environment manager and setup environment variables
            envManager = new EnvironmentManager(deployDir);
            envFilePath = await this.setupEnvironment(deploymentId, envVarsToken, envManager, environment);
            
            if (!envFilePath) {
                throw new Error('Failed to set up environment variables');
            }

            // Verify environment file exists
            await fs.access(envFilePath);

            // Clean directory before clone
            const filesBeforeClone = await fs.readdir('.');
            for (const file of filesBeforeClone) {
                if (file !== '.env.production' && file !== '.env.development') {
                    await fs.rm(file, { recursive: true, force: true });
                }
            }

            // Clone repository
            logger.info(`Cloning repository into ${process.cwd()}`);
            const repoUrl = `https://x-access-token:${githubToken}@github.com/${repositoryOwner}/${repositoryName}.git`;
            await executeCommand('git', ['clone', '-b', branch, repoUrl, '.']);

            // Get existing container info
            oldContainer = await this.getCurrentContainer(serviceName);
            if (oldContainer) {
                await this.backupCurrentState(oldContainer, backupDir);
            }

            // Initialize port manager if needed
            await this.portManager.initialize().catch(logger.warn);

            // Allocate ports
            const ports = await this.allocatePortsWithRetry(serviceName, oldContainer);

            // Create new container with blue-green naming
            const blueGreenLabel = oldContainer ? 'green' : 'blue';
            const newContainerName = `${serviceName}-${blueGreenLabel}`;

            // Build and start new container
            newContainer = await this.buildAndStartContainer({
                projectName,
                serviceName: newContainerName,
                deployDir,
                domain,
                ports,
                envFilePath,
                environment,
                payload,
                ws
            });

            // Environment setup verification
            await envManager.updateDockerCompose(envFilePath, newContainerName);
            
            const envSetupOk = await envManager.verifyEnvironmentSetup(newContainer.name);
            if (!envSetupOk) {
                throw new Error('Environment verification failed');
            }

            // Health check and traffic switch
            await this.performHealthCheck(newContainer, domain);
            await this.switchTraffic(oldContainer, newContainer, domain);

            // Cleanup old container
            if (oldContainer) {
                await this.gracefulContainerRemoval(oldContainer);
                await this.portManager.releasePort(oldContainer.name);
            }

            this.sendSuccess(ws, {
                deploymentId,
                status: 'success',
                message: 'Zero-downtime deployment completed successfully',
                domain,
                port: ports.hostPort
            });

        } catch (error) {
            logger.error(`Deployment ${deploymentId} failed:`, error);
            rollbackNeeded = true;

            try {
                if (rollbackNeeded && oldContainer) {
                    await this.performRollback(oldContainer, newContainer, domain);
                }
                
                if (newContainer) {
                    await this.portManager.releasePort(newContainer.name);
                }
            } catch (rollbackError) {
                logger.error('Rollback failed:', rollbackError);
            }

            this.sendError(ws, {
                deploymentId,
                status: 'failed',
                message: error.message || 'Deployment failed'
            });

        } finally {
            process.chdir(currentDir);
            if (!rollbackNeeded) {
                await this.cleanup(deployDir, rollbackNeeded);
            }
        }
    }

    async setupDirectories(deployDir, backupDir) {
        try {
            // Ensure parent directories exist
            await fs.mkdir(path.dirname(deployDir), { recursive: true });

            // Clean existing deployment directory
            if (await this.directoryExists(deployDir)) {
                logger.info(`Cleaning up existing deployment directory: ${deployDir}`);
                await fs.rm(deployDir, { recursive: true, force: true });
            }

            // Create fresh directories
            await fs.mkdir(deployDir, { recursive: true });
            await fs.mkdir(backupDir, { recursive: true });

            // Change to deployment directory
            process.chdir(deployDir);
            
            logger.info(`Directories prepared successfully: ${deployDir}`);
        } catch (error) {
            logger.error(`Failed to setup directories: ${error.message}`);
            throw new Error(`Directory setup failed: ${error.message}`);
        }
    }

    async backupCurrentState(container, backupDir) {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').toLowerCase();
            const backupName = `backup-${container.name}-${timestamp}`.toLowerCase();
            
            await executeCommand('docker', [
                'commit',
                container.id,
                backupName
            ]);
            
            // Save backup metadata
            const backupMetadata = {
                containerId: container.id,
                containerName: container.name,
                timestamp: new Date().toISOString(),
                backupName
            };
            
            await fs.writeFile(
                path.join(backupDir, 'backup-metadata.json'),
                JSON.stringify(backupMetadata, null, 2)
            );
        } catch (error) {
            logger.warn(`Backup failed: ${error.message}`);
        }
    }

    async switchTraffic(oldContainer, newContainer, domain) {
        try {
            // First try to disconnect old container if it exists
            if (oldContainer) {
                await executeCommand('docker', [
                    'network',
                    'disconnect',
                    'traefik-network',
                    oldContainer.id
                ]).catch(() => {});
            }

            // Wait a moment for network changes to propagate
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Connect new container to traefik network
            await executeCommand('docker', [
                'network',
                'connect',
                'traefik-network',
                newContainer.id
            ]);

            // Update traefik labels
            await executeCommand('docker', [
                'label',
                newContainer.id,
                `traefik.http.routers.${newContainer.name}.rule=Host(\`${domain}\`)`
            ]);

            // Wait for traefik to detect the new container
            await new Promise(resolve => setTimeout(resolve, 5000));

        } catch (error) {
            logger.error('Traffic switch failed:', error);
            throw new Error(`Traffic switch failed: ${error.message}`);
        }
    }

    async performRollback(oldContainer, newContainer, domain) {
        logger.info('Initiating rollback procedure');

        try {
            if (newContainer) {
                // First remove new container from network
                await executeCommand('docker', [
                    'network',
                    'disconnect',
                    'traefik-network',
                    newContainer.id
                ]).catch(() => {});

                // Wait for network changes
                await new Promise(resolve => setTimeout(resolve, 2000));

                // Stop and remove new container
                await executeCommand('docker', ['stop', newContainer.id]).catch(() => {});
                await executeCommand('docker', ['rm', newContainer.id]).catch(() => {});
            }

            if (oldContainer) {
                // Verify old container is not connected before connecting
                try {
                    await executeCommand('docker', [
                        'network',
                        'inspect',
                        'traefik-network',
                        '--format',
                        '{{.Containers}}'
                    ]);
                    
                    // If old container is still connected, disconnect it first
                    await executeCommand('docker', [
                        'network',
                        'disconnect',
                        'traefik-network',
                        oldContainer.id
                    ]).catch(() => {});
                } catch (error) {
                    // Network inspection failed, assume container is not connected
                }

                // Wait before reconnecting
                await new Promise(resolve => setTimeout(resolve, 2000));

                // Reconnect old container
                await executeCommand('docker', [
                    'network',
                    'connect',
                    'traefik-network',
                    oldContainer.id
                ]);

                // Restore labels
                await executeCommand('docker', [
                    'label',
                    oldContainer.id,
                    `traefik.http.routers.${oldContainer.name}.rule=Host(\`${domain}\`)`
                ]);
            }
        } catch (error) {
            logger.error('Rollback operation failed:', error);
            throw new Error(`Rollback failed: ${error.message}`);
        }
    }

    // Rest of the methods remain unchanged...
    async directoryExists(dir) {
        try {
            await fs.access(dir);
            return true;
        } catch {
            return false;
        }
    }

    async validatePrerequisites(deployDir, backupDir) {
        await executeCommand('which', ['docker']);
        await executeCommand('which', ['docker-compose']);
        await this.validateNetworks();
    }

    async validateNetworks() {
        try {
            const { stdout: networks } = await executeCommand('docker', ['network', 'ls', '--format', '{{.Name}}']);
            if (!networks.includes('traefik-network')) {
                await executeCommand('docker', ['network', 'create', 'traefik-network']);
            }
        } catch (error) {
            throw new Error(`Network validation failed: ${error.message}`);
        }
    }

    async setupEnvironment(deploymentId, envVarsToken, envManager, environment) {
        try {
            const { data } = await apiClient.post(`/api/deploy/env-vars/${deploymentId}`, {
                token: envVarsToken
            });
            
            if (!data || !data.variables) {
                throw new Error('Invalid response format for environment variables');
            }
            
            logger.info('Successfully retrieved environment variables');
            const envFilePath = await envManager.writeEnvFile(data.variables, environment);
            logger.info('Environment files written successfully');
            
            return envFilePath;
        } catch (error) {
            logger.error('Environment setup failed:', error);
            throw new Error(`Environment setup failed: ${error.message}`);
        }
    }

    async getCurrentContainer(serviceName) {
        try {
            const { stdout } = await executeCommand('docker', [
                'ps',
                '-a',
                '--filter', `name=${serviceName}`,
                '--format', '{{.Names}}\t{{.ID}}\t{{.State}}'
            ]);

            if (!stdout) return null;

            const [name, id, state] = stdout.split('\t');
            return { name, id, state };
        } catch (error) {
            logger.warn(`Error getting current container: ${error.message}`);
            return null;
        }
    }

    async allocatePortsWithRetry(serviceName, oldContainer) {
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            try {
                const { hostPort, containerPort } = await this.portManager.allocatePort(serviceName);
                
                const inUse = await this.portManager.isPortInUse(hostPort);
                if (!inUse) {
                    await this.portManager.reservePort(hostPort);
                    return { hostPort, containerPort };
                }

                await this.portManager.killProcessOnPort(hostPort);
                
                if (!(await this.portManager.isPortInUse(hostPort))) {
                    return { hostPort, containerPort };
                }
            } catch (error) {
                attempts++;
                if (attempts === maxAttempts) {
                    throw new Error('Failed to allocate ports after multiple attempts');
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    async performHealthCheck(container, domain) {
        let healthy = false;
        let attempts = 0;

        while (!healthy && attempts < this.healthCheckRetries) {
            try {
                await new Promise(resolve => setTimeout(resolve, this.healthCheckInterval));
                
                const healthCheck = await executeCommand('docker', [
                    'exec',
                    container.id,
                    'curl',
                    '-f',
                    'http://localhost:9000/health'
                ]);

                if (healthCheck.stdout.includes('OK')) {
                    healthy = true;
                    break;
                }
            } catch (error) {
                attempts++;
                logger.warn(`Health check attempt ${attempts} failed:`, error);
            }
        }

        if (!healthy) {
            throw new Error('Container failed health checks');
        }
    }

    async buildAndStartContainer({ 
        projectName, 
        serviceName, 
        deployDir, 
        domain, 
        ports, 
        envFilePath, 
        environment,
        payload,
        ws 
    }) {
        try {
            if (!this.templateHandler) {
                this.templateHandler = new TemplateHandler(
                    path.join('/opt/cloudlunacy/templates'),
                    require('../deployConfig.json')
                );
            }

            // Generate deployment files
            const files = await this.templateHandler.generateDeploymentFiles({
                appType: payload.appType,
                appName: serviceName,
                environment,
                containerPort: ports.containerPort,
                hostPort: ports.hostPort,
                envFile: path.basename(envFilePath),
                domain,
                health: {
                    checkPath: '/health',
                    interval: '10s',
                    timeout: '5s',
                    retries: 3
                }
            });

            // Write deployment files
            await Promise.all([
                fs.writeFile(path.join(deployDir, 'Dockerfile'), files.dockerfile),
                fs.writeFile(path.join(deployDir, 'docker-compose.yml'), files.dockerCompose)
            ]);

            // Verify files were written
            await Promise.all([
                fs.access(path.join(deployDir, 'Dockerfile')),
                fs.access(path.join(deployDir, 'docker-compose.yml')),
                fs.access(envFilePath)
            ]);

            // Build container
            await executeCommand('docker-compose', [
                'build',
                '--build-arg', `SERVICE_NAME=${serviceName}`,
                '--build-arg', `HEALTH_CHECK_PATH=/health`,
                '--no-cache'
            ], {
                env: {
                    ...process.env,
                    COMPOSE_PROJECT_NAME: projectName
                }
            });

            // Start container
            await executeCommand('docker-compose', ['up', '-d'], {
                env: {
                    ...process.env,
                    COMPOSE_PROJECT_NAME: projectName,
                    DOCKER_CLIENT_TIMEOUT: '240',
                    COMPOSE_HTTP_TIMEOUT: '240'
                }
            });

            // Get container ID
            const { stdout: containerId } = await executeCommand('docker-compose', ['ps', '-q'], {
                env: { COMPOSE_PROJECT_NAME: projectName }
            });

            if (!containerId.trim()) {
                throw new Error('Failed to get container ID after startup');
            }

            // Verify container is running
            const { stdout: containerState } = await executeCommand('docker', [
                'inspect',
                '--format',
                '{{.State.Status}}',
                containerId.trim()
            ]);

            if (containerState.trim() !== 'running') {
                throw new Error(`Container is not running, current state: ${containerState.trim()}`);
            }

            return { id: containerId.trim(), name: serviceName };

        } catch (error) {
            logger.error('Container build/start failed:', error);
            throw new Error(`Failed to build and start container: ${error.message}`);
        }
    }

    async gracefulContainerRemoval(container) {
        try {
            // First try graceful shutdown
            await executeCommand('docker', ['stop', '--time=30', container.id]);
            
            // Wait a bit to ensure container has stopped
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Check if container is still running
            try {
                const { stdout: state } = await executeCommand('docker', [
                    'inspect',
                    '--format',
                    '{{.State.Status}}',
                    container.id
                ]);
                
                if (state.trim() === 'running') {
                    // Force stop if still running
                    await executeCommand('docker', ['kill', container.id]);
                }
            } catch (error) {
                // Container might already be gone, ignore error
                logger.warn(`Container state check failed: ${error.message}`);
            }

            // Remove the container
            await executeCommand('docker', ['rm', '-f', container.id]);
            
            // Verify container is removed
            try {
                await executeCommand('docker', ['inspect', container.id]);
                throw new Error('Container still exists after removal attempt');
            } catch (error) {
                // Expected error - container should not exist
                if (error.message.includes('No such container')) {
                    logger.info(`Container ${container.id} successfully removed`);
                } else {
                    throw error;
                }
            }
        } catch (error) {
            logger.warn(`Error removing old container: ${error.message}`);
            throw error;
        }
    }

    async cleanup(deployDir, keepBackup = false) {
        try {
            if (!keepBackup) {
                const backupDir = path.join(deployDir, 'backup');
                if (await this.directoryExists(backupDir)) {
                    await fs.rm(backupDir, { recursive: true, force: true });
                }
            }

            // Clean up any leftover build artifacts
            const filesToClean = [
                'Dockerfile',
                'docker-compose.yml',
                '.dockerignore',
                'npm-debug.log',
                'yarn-error.log'
            ];

            for (const file of filesToClean) {
                const filePath = path.join(deployDir, file);
                if (await this.directoryExists(filePath)) {
                    await fs.rm(filePath, { force: true });
                }
            }

            // Remove temp directories
            const temoDirsToClean = [
                'node_modules',
                'build',
                'dist',
                '.next',
                '.nuxt'
            ];

            for (const dir of temoDirsToClean) {
                const dirPath = path.join(deployDir, dir);
                if (await this.directoryExists(dirPath)) {
                    await fs.rm(dirPath, { recursive: true, force: true });
                }
            }

        } catch (error) {
            logger.warn(`Cleanup error: ${error.message}`);
        }
    }

    sendSuccess(ws, data) {
        if (ws && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
                type: 'status',
                payload: {
                    ...data,
                    timestamp: new Date().toISOString()
                }
            }));
        }
    }

    sendError(ws, data) {
        if (ws && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
                type: 'status',
                payload: {
                    ...data,
                    timestamp: new Date().toISOString()
                }
            }));
        }
    }

    sendLogs(ws, deploymentId, log) {
        if (ws && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
                type: 'logs',
                payload: {
                    deploymentId,
                    log,
                    timestamp: new Date().toISOString()
                }
            }));
        }
    }
}

module.exports = new ZeroDowntimeDeployer();