// ZeroDowntimeDeployer.js

const { executeCommand } = require('../utils/executor');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');
const TemplateHandler = require('../utils/templateHandler');
const portManager = require('../utils/portManager');
const { ensureDeploymentPermissions } = require('../utils/permissionCheck');
const apiClient = require('../utils/apiClient');
const EnvironmentManager = require('../utils/environmentManager');
const Joi = require('joi');

class ZeroDowntimeDeployer {
    constructor() {
        this.healthCheckRetries = parseInt(process.env.HEALTH_CHECK_RETRIES, 10) || 5;
        this.healthCheckInterval = parseInt(process.env.HEALTH_CHECK_INTERVAL, 10) || 10000;
        this.startupGracePeriod = parseInt(process.env.STARTUP_GRACE_PERIOD, 10) || 30000;
        this.rollbackTimeout = parseInt(process.env.ROLLBACK_TIMEOUT, 10) || 180000;
        this.portManager = portManager;
        this.templateHandler = null;
        this.deployBaseDir = process.env.DEPLOY_BASE_DIR || '/opt/cloudlunacy/deployments';
        this.templatesDir = process.env.TEMPLATES_DIR || '/opt/cloudlunacy/templates';
        this.deploymentLocks = new Set(); // Simple in-memory lock mechanism
    }

    async getDeploymentColor(serviceName, environment) {
        // Check existing projects to determine the next color
        const colors = ['blue', 'green'];
        for (const color of colors) {
            const projectName = `${serviceName}-${environment}-${color}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
            // Check if any container exists for this project
            // Execute 'docker-compose -p projectName ps -q'
            try {
                const { stdout } = await executeCommand('docker-compose', ['-p', projectName, 'ps', '-q']);
                if (!stdout.trim()) {
                    // No containers running for this project, select this color
                    return color;
                }
            } catch (error) {
                logger.warn(`Error checking project ${projectName}: ${error.message}`);
            }
        }
        // If both colors are in use, fallback or implement rotation logic
        throw new Error('Both Blue and Green environments are currently active. Cannot deploy.');
    }

    async deploy(payload, ws) {
        // Define schema for payload validation
        const payloadSchema = Joi.object({
            deploymentId: Joi.string().required(),
            appType: Joi.string().required(),
            appName: Joi.string().required(),
            repositoryOwner: Joi.string().required(),
            repositoryName: Joi.string().required(),
            branch: Joi.string().required(),
            githubToken: Joi.string().required(),
            environment: Joi.string().required(),
            serviceName: Joi.string().required(),
            domain: Joi.string().required(),
            envVarsToken: Joi.string().required()
        });

        // Validate payload
        const { error, value } = payloadSchema.validate(payload);
        if (error) {
            logger.error(`Invalid payload: ${error.message}`);
            this.sendError(ws, {
                deploymentId: payload.deploymentId || 'unknown',
                status: 'failed',
                message: `Invalid payload: ${error.message}`
            });
            return;
        }

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
        } = value;

        // Implement deployment lock to prevent concurrent deployments for the same service
        const serviceLockKey = `${serviceName}-${environment}`;
        if (this.deploymentLocks.has(serviceLockKey)) {
            const msg = `Deployment already in progress for service ${serviceName} in environment ${environment}`;
            logger.warn(msg);
            this.sendError(ws, {
                deploymentId,
                status: 'failed',
                message: msg
            });
            return;
        }

        this.deploymentLocks.add(serviceLockKey);

        // Determine deployment color (blue or green)
        let deploymentColor;
        try {
            deploymentColor = await this.getDeploymentColor(serviceName, environment);
        } catch (error) {
            logger.error(`Failed to determine deployment color: ${error.message}`);
            this.sendError(ws, {
                deploymentId,
                status: 'failed',
                message: `Deployment color determination failed: ${error.message}`
            });
            this.deploymentLocks.delete(serviceLockKey);
            return;
        }

        // Use project name based on serviceName, environment, and color
        const projectName = `${serviceName}-${environment}-${deploymentColor}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const deployDir = path.join(this.deployBaseDir, deploymentId); // Deployment directory remains unique
        const backupDir = path.join(deployDir, 'backup');

        let oldContainer = null;
        let newContainer = null;
        let rollbackNeeded = false;
        let envManager = null;

        try {
            const permissionsOk = await ensureDeploymentPermissions();
            if (!permissionsOk) {
                throw new Error('Deployment failed: Permission check failed');
            }

            await this.validatePrerequisites();
            await this.setupDirectories(deployDir, backupDir);

            // Initialize environment manager
            envManager = new EnvironmentManager(deployDir);

            // Setup environment before git clone
            const envFilePath = await this.setupEnvironment(deploymentId, envVarsToken, envManager, environment);
            if (!envFilePath) {
                throw new Error('Failed to set up environment variables');
            }

            // Clone repository into deployDir, handling existing backup
            await this.cloneRepository(deployDir, repositoryOwner, repositoryName, branch, githubToken);

            // Get current container before deployment
            oldContainer = await this.getCurrentContainer(serviceName);
            if (oldContainer) {
                await this.backupCurrentState(oldContainer, backupDir);
            }

            await this.portManager.initialize().catch(logger.warn);

            const ports = await this.allocatePortsWithRetry(serviceName, oldContainer);
            const newContainerName = `${serviceName}-${deploymentColor}`;

            newContainer = await this.buildAndStartContainer({
                projectName,
                serviceName: newContainerName,
                deployDir,
                domain,
                ports,
                envFilePath,
                environment,
                payload: value,
                ws
            });

            await envManager.updateDockerCompose(envFilePath, newContainerName);

            const envSetupOk = await envManager.verifyEnvironmentSetup(newContainer.name);
            if (!envSetupOk) {
                throw new Error('Environment verification failed');
            }

            await this.performHealthCheck(newContainer, domain);
            await this.switchTraffic(oldContainer, newContainer, domain);

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
            this.deploymentLocks.delete(serviceLockKey);
            if (!rollbackNeeded) {
                await this.cleanup(deployDir, rollbackNeeded);
            }
        }
    }

    async getDeploymentColor(serviceName, environment) {
        // Define colors for Blue-Green
        const colors = ['blue', 'green'];

        // Check which colors are currently active
        for (const color of colors) {
            const projectName = `${serviceName}-${environment}-${color}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
            try {
                const { stdout } = await executeCommand('docker-compose', ['-p', projectName, 'ps', '-q']);
                if (!stdout.trim()) {
                    // This color is available for deployment
                    return color;
                }
            } catch (error) {
                logger.warn(`Error checking project ${projectName}: ${error.message}`);
            }
        }

        // If both colors are active, throw an error or implement rotation
        throw new Error('Both Blue and Green environments are currently active. Cannot deploy.');
    }

    async setupDirectories(deployDir, backupDir) {
        try {
            // Ensure deployment directory exists
            await fs.mkdir(deployDir, { recursive: true });

            // Create backup directory
            await fs.mkdir(backupDir, { recursive: true });

            logger.info(`Directories prepared successfully: ${deployDir}`);
        } catch (error) {
            logger.error(`Failed to setup directories: ${error.message}`);
            throw new Error(`Directory setup failed: ${error.message}`);
        }
    }

    async cloneRepository(deployDir, repoOwner, repoName, branch, githubToken) {
        // Embed the token in the clone URL
        const repoUrl = `https://x-access-token:${githubToken}@github.com/${repoOwner}/${repoName}.git`;
        const tempDir = path.join(path.dirname(deployDir), `${path.basename(deployDir)}_temp_${Date.now()}`);

        try {
            logger.info(`Cloning repository into temporary directory: ${tempDir}`);

            // Clone into temporary directory
            await executeCommand('git', ['clone', '-b', branch, repoUrl, tempDir]);

            logger.info('Repository cloned successfully into temporary directory');

            // Copy contents from tempDir to deployDir, excluding 'backup'
            const files = await fs.readdir(tempDir);

            for (const file of files) {
                if (file === 'backup') continue; // Skip backup directory if present in the repo

                const srcPath = path.join(tempDir, file);
                const destPath = path.join(deployDir, file);

                const stat = await fs.lstat(srcPath);

                if (stat.isDirectory()) {
                    await fs.cp(srcPath, destPath, { recursive: true, force: true });
                } else {
                    await fs.copyFile(srcPath, destPath);
                }
            }

            logger.info('Repository files merged into deployment directory successfully');

        } catch (error) {
            logger.error(`Git clone failed: ${error.message}`);
            throw new Error(`Git clone failed: ${error.message}`);
        } finally {
            // Clean up temporary directory
            if (await this.directoryExists(tempDir)) {
                await fs.rm(tempDir, { recursive: true, force: true });
                logger.info(`Temporary directory ${tempDir} removed`);
            }
        }
    }

    async backupCurrentState(container, backupDir) {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').toLowerCase();
            const backupName = `backup-${container.name}-${timestamp}`;

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

            logger.info(`Backup created successfully: ${backupName}`);
        } catch (error) {
            logger.warn(`Backup failed: ${error.message}`);
        }
    }

    async switchTraffic(oldContainer, newContainer, domain) {
        try {
            // Traffic is managed via Traefik labels in docker-compose.yml
            // Since labels are already set during container creation, Traefik should handle routing automatically
            // Implement a grace period to ensure Traefik picks up the new container

            logger.info('Waiting for Traefik to update routes...');
            await new Promise(resolve => setTimeout(resolve, 5000));

            logger.info('Traffic switch completed successfully.');
        } catch (error) {
            logger.error('Traffic switch failed:', error);
            throw new Error(`Traffic switch failed: ${error.message}`);
        }
    }

    async performRollback(oldContainer, newContainer, domain) {
        logger.info('Initiating rollback procedure');

        try {
            // Stop and remove new container
            if (newContainer) {
                logger.info(`Stopping and removing new container: ${newContainer.name}`);
                await executeCommand('docker-compose', ['-p', newContainer.name, 'down', '-v']);
            }

            // Re-deploy old container if backup exists
            if (oldContainer) {
                const backupMetadataPath = path.join(path.dirname(oldContainer.name), 'backup', 'backup-metadata.json');
                const exists = await this.fileExists(backupMetadataPath);
                if (exists) {
                    const backupMetadata = JSON.parse(await fs.readFile(backupMetadataPath, 'utf-8'));
                    logger.info(`Restoring backup: ${backupMetadata.backupName}`);

                    await executeCommand('docker', ['run', '-d', '--name', backupMetadata.containerName, backupMetadata.backupName]);

                    // Wait for the restored container to be healthy
                    await this.performHealthCheck({ id: backupMetadata.containerId, name: backupMetadata.containerName }, domain);
                } else {
                    logger.warn('No backup metadata found. Skipping restoration of old container.');
                }
            }
        } catch (error) {
            logger.error('Failed to restore old container:', error);
            throw new Error(`Failed to restore old container: ${error.message}`);
        }
    }

    async fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    async getCurrentContainer(serviceName) {
        try {
            const { stdout } = await executeCommand('docker', [
                'ps',
                '-q',
                '--filter', `name=${serviceName}`
            ]);

            const containerId = stdout.trim();
            if (!containerId) return null;

            const { stdout: containerInfo } = await executeCommand('docker', [
                'inspect',
                containerId,
                '--format', '{{.Name}} {{.Id}} {{.State.Status}}'
            ]);

            const [name, id, status] = containerInfo.trim().split(' ');
            return { name: name.replace('/', ''), id, status };
        } catch (error) {
            logger.warn(`Error getting current container: ${error.message}`);
            return null;
        }
    }

    async allocatePortsWithRetry(serviceName, oldContainer) {
        // Attempt to reuse the old port if available
        if (oldContainer) {
            const oldHostPort = await this.portManager.getHostPort(serviceName);
            if (oldHostPort && !(await this.portManager.isPortInUse(oldHostPort))) {
                logger.info(`Reusing old port ${oldHostPort} for service ${serviceName}`);
                return { hostPort: oldHostPort, containerPort: 8080 };
            }
        }

        // Allocate new port if old port is unavailable
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            try {
                const { hostPort, containerPort } = await this.portManager.allocatePort(serviceName);

                const inUse = await this.portManager.isPortInUse(hostPort);
                if (!inUse) {
                    logger.info(`Port ${hostPort} is available for use.`);
                    return { hostPort, containerPort };
                }

                logger.warn(`Port ${hostPort} is already in use. Skipping allocation.`);
            } catch (error) {
                attempts++;
                logger.warn(`Port allocation attempt ${attempts} failed: ${error.message}`);
                if (attempts === maxAttempts) {
                    throw new Error('Failed to allocate ports after multiple attempts');
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        throw new Error('Port allocation retries exhausted');
    }

    async performHealthCheck(container, domain) {
        let healthy = false;
        let attempts = 0;

        while (!healthy && attempts < this.healthCheckRetries) {
            try {
                await new Promise(resolve => setTimeout(resolve, this.healthCheckInterval));

                const healthCheck = await executeCommand('curl', ['-f', `http://${domain}/health`]);

                if (healthCheck.stdout.includes('OK')) {
                    healthy = true;
                    logger.info(`Health check passed for container ${container.name}`);
                    break;
                }
            } catch (error) {
                attempts++;
                logger.warn(`Health check attempt ${attempts} failed for container ${container.name}:`, error.message);
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
            // Clean up existing containers with the same service name
            try {
                const existingContainers = await executeCommand('docker-compose', ['-p', projectName, 'ps', '-q', serviceName]);
                const containerIds = existingContainers.stdout.trim().split('\n').filter(id => id);
                for (const id of containerIds) {
                    await executeCommand('docker-compose', ['-p', projectName, 'down', '-v']);
                }
            } catch (error) {
                logger.warn(`Failed to clean up old containers: ${error.message}`);
            }

            if (!this.templateHandler) {
                this.templateHandler = new TemplateHandler(
                    this.templatesDir,
                    require('../deployConfig.json')
                );
            }

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
                    interval: '30s',
                    timeout: '5s',
                    retries: 3,
                    start_period: '40s'
                }
            });

            // Write deployment files
            await Promise.all([
                fs.writeFile(path.join(deployDir, 'Dockerfile'), files.dockerfile),
                fs.writeFile(path.join(deployDir, 'docker-compose.yml'), files.dockerCompose)
            ]);

            logger.info('Deployment files written successfully');

            // Build container using Docker Compose
            await executeCommand('docker-compose', [
                '-p', projectName,
                'build',
                '--no-cache'
            ], {
                cwd: deployDir
            });

            // Start container using Docker Compose
            await executeCommand('docker-compose', [
                '-p', projectName,
                'up', '-d'
            ], {
                cwd: deployDir
            });

            // Get the new container ID
            const { stdout: newContainerId } = await executeCommand('docker-compose', [
                '-p', projectName,
                'ps', '-q', serviceName
            ], {
                cwd: deployDir
            });

            if (!newContainerId.trim()) {
                throw new Error('Failed to get container ID after startup');
            }

            logger.info(`Container ${serviceName} started with ID ${newContainerId.trim()}`);

            // No need to add labels here if they're defined in docker-compose.yml

            return { id: newContainerId.trim(), name: serviceName };
        } catch (error) {
            logger.error('Container build/start failed:', error);
            throw new Error(`Failed to build and start container: ${error.message}`);
        }
    }  

    async gracefulContainerRemoval(container) {
        try {
            logger.info(`Gracefully removing container: ${container.name}`);

            // Extract serviceName and environment from container name
            const parts = container.name.split('-');
            if (parts.length < 3) {
                throw new Error(`Invalid container name format: ${container.name}`);
            }
            const serviceName = parts.slice(0, -1).join('-'); // Handles service names with hyphens
            const environment = parts[parts.length - 1]; // Assuming last part is environment

            const projectName = `${serviceName}-${environment}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

            await executeCommand('docker-compose', [
                '-p', projectName,
                'down', '-v'
            ]);

            logger.info(`Container ${container.name} successfully removed`);
        } catch (error) {
            logger.warn(`Error removing old container: ${error.message}`);
            throw error;
        }
    }

    async validatePrerequisites() {
        try {
            await executeCommand('which', ['docker']);
            await executeCommand('which', ['docker-compose']);
            await this.validateNetworks();
        } catch (error) {
            throw new Error(`Prerequisite validation failed: ${error.message}`);
        }
    }

    async validateNetworks() {
        try {
            const { stdout: networks } = await executeCommand('docker', ['network', 'ls', '--format', '{{.Name}}']);
            if (!networks.includes('traefik-network')) {
                await executeCommand('docker', ['network', 'create', 'traefik-network']);
                logger.info('Created traefik-network');
            } else {
                logger.info('traefik-network already exists');
            }
        } catch (error) {
            throw new Error(`Network validation failed: ${error.message}`);
        }
    }

    async setupEnvironment(deploymentId, envVarsToken, envManager, environment) {
        try {
            const response = await apiClient.post(`/api/deploy/env-vars/${deploymentId}`, {
                token: envVarsToken
            });

            if (!response.data || !response.data.variables) {
                throw new Error('Invalid response format for environment variables');
            }

            logger.info('Successfully retrieved environment variables');
            const envFilePath = await envManager.writeEnvFile(response.data.variables, environment);
            logger.info('Environment file written successfully');

            return envFilePath;
        } catch (error) {
            logger.error('Environment setup failed:', error);
            throw new Error(`Environment setup failed: ${error.message}`);
        }
    }

    async performCommandWithTimeout(command, args, options = {}, timeout = 300000) { // default 5 minutes
        return Promise.race([
            executeCommand(command, args, options),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Command timed out')), timeout)
            )
        ]);
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

    async cleanup(deployDir, keepBackup = false) {
        try {
            if (!keepBackup) {
                const backupDir = path.join(deployDir, 'backup');
                if (await this.directoryExists(backupDir)) {
                    await fs.rm(backupDir, { recursive: true, force: true });
                    logger.info(`Backup directory ${backupDir} removed`);
                }
            }

            // Optionally, implement further cleanup if necessary

        } catch (error) {
            logger.warn(`Cleanup error: ${error.message}`);
        }
    }

    async directoryExists(dir) {
        try {
            await fs.access(dir);
            return true;
        } catch {
            return false;
        }
    }
}

module.exports = new ZeroDowntimeDeployer();