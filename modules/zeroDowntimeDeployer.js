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

        const projectName = `${deploymentId}-${appName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const deployDir = path.join('/opt/cloudlunacy/deployments', deploymentId);
        const backupDir = path.join(deployDir, 'backup');
        const currentDir = process.cwd();

        let oldContainer = null;
        let newContainer = null;
        let rollbackNeeded = false;
        let envManager = null;

        try {
          // Initial setup and validation
          const permissionsOk = await ensureDeploymentPermissions();
          if (!permissionsOk) {
              throw new Error('Deployment failed: Permission check failed');
          }

          await this.validatePrerequisites(deployDir, backupDir);
          
          // Setup directories with proper cleanup
          await this.setupDirectories(deployDir, backupDir);

          // Initialize environment manager
          envManager = new EnvironmentManager(deployDir);

          // Set up environment variables
          const envFilePath = await this.setupEnvironment(deploymentId, envVarsToken, envManager, environment);
          if (!envFilePath) {
              throw new Error('Failed to set up environment variables');
          }

          // Clone repository after directory is clean
          const repoUrl = `https://x-access-token:${githubToken}@github.com/${repositoryOwner}/${repositoryName}.git`;
          await executeCommand('git', ['clone', '-b', branch, repoUrl, '.']);

            // Get existing container info for rollback
            oldContainer = await this.getCurrentContainer(serviceName);
            if (oldContainer) {
                await this.backupCurrentState(oldContainer, backupDir);
            }

            // Port allocation with conflict handling
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

            // Update environment configuration in docker-compose
            await envManager.updateDockerCompose(envFilePath, newContainerName);

            // Health check and traffic switch
            await this.performHealthCheck(newContainer, domain);
            
            // Verify environment variables are properly set
            const envSetupOk = await envManager.verifyEnvironmentSetup(newContainer.name);
            if (!envSetupOk) {
                throw new Error('Environment verification failed');
            }

            await this.switchTraffic(oldContainer, newContainer, domain);

            // Cleanup old container after successful switch
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
            await this.cleanup(deployDir, rollbackNeeded);
        }
    }
    async setupDirectories(deployDir, backupDir) {
        try {
            // Create parent directories if they don't exist
            await fs.mkdir(path.dirname(deployDir), { recursive: true });

            // Clean up existing deployment directory
            if (await this.directoryExists(deployDir)) {
                logger.info(`Cleaning up existing deployment directory: ${deployDir}`);
                await rimraf(deployDir);
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

    async backupCurrentState(container, backupDir) {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            await executeCommand('docker', [
                'commit',
                container.id,
                `backup-${container.name}-${timestamp}`
            ]);
        } catch (error) {
            logger.warn(`Backup failed: ${error.message}`);
        }
    }

    async allocatePortsWithRetry(serviceName, oldContainer) {
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            try {
                const { hostPort, containerPort } = await this.portManager.allocatePort(serviceName);
                
                // Verify port is actually available
                const inUse = await this.portManager.isPortInUse(hostPort);
                if (!inUse) {
                    await this.portManager.reservePort(hostPort);
                    return { hostPort, containerPort };
                }

                // If port is in use, try to free it
                await this.portManager.killProcessOnPort(hostPort);
                
                // Verify again after killing process
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

    async buildAndStartContainer({ 
        projectName, 
        serviceName, 
        deployDir, 
        domain, 
        ports, 
        envFilePath, 
        environment,
        payload 
    }) {
        if (!this.templateHandler) {
            this.templateHandler = new TemplateHandler(
                path.join('/opt/cloudlunacy/templates'),
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
                interval: '10s',
                timeout: '5s',
                retries: 3
            }
        });

        await Promise.all([
            fs.writeFile(path.join(deployDir, 'Dockerfile'), files.dockerfile),
            fs.writeFile(path.join(deployDir, 'docker-compose.yml'), files.dockerCompose)
        ]);

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

        await executeCommand('docker-compose', ['up', '-d'], {
            env: {
                ...process.env,
                COMPOSE_PROJECT_NAME: projectName
            }
        });

        const { stdout: containerId } = await executeCommand('docker-compose', ['ps', '-q'], {
            env: { COMPOSE_PROJECT_NAME: projectName }
        });

        return { id: containerId.trim(), name: serviceName };
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

    async switchTraffic(oldContainer, newContainer, domain) {
        // Connect new container to traefik network
        await executeCommand('docker', ['network', 'connect', 'traefik-network', newContainer.id]);

        // Update traefik labels for zero-downtime switch
        await executeCommand('docker', [
            'label',
            newContainer.id,
            `traefik.http.routers.${newContainer.name}.rule=Host(\`${domain}\`)`
        ]);

        // Wait for traefik to detect the new container
        await new Promise(resolve => setTimeout(resolve, 5000));

        if (oldContainer) {
            // Remove old container from traefik but keep it running
            await executeCommand('docker', [
                'network',
                'disconnect',
                'traefik-network',
                oldContainer.id
            ]);
        }
    }

    async performRollback(oldContainer, newContainer, domain) {
        logger.info('Initiating rollback procedure');

        try {
            if (newContainer) {
                // Remove new container from traefik
                await executeCommand('docker', [
                    'network',
                    'disconnect',
                    'traefik-network',
                    newContainer.id
                ]).catch(() => {});

                // Stop and remove new container
                await executeCommand('docker', ['stop', newContainer.id]).catch(() => {});
                await executeCommand('docker', ['rm', newContainer.id]).catch(() => {});
            }

            if (oldContainer) {
                // Reconnect old container to traefik
                await executeCommand('docker', [
                    'network',
                    'connect',
                    'traefik-network',
                    oldContainer.id
                ]);

                // Restore old container labels
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

    async gracefulContainerRemoval(container) {
        try {
            // Send SIGTERM and wait for graceful shutdown
            await executeCommand('docker', ['stop', '--time=30', container.id]);
            await executeCommand('docker', ['rm', container.id]);
        } catch (error) {
            logger.warn(`Error removing old container: ${error.message}`);
        }
    }

    async cleanup(deployDir, keepBackup = false) {
        if (!keepBackup) {
            try {
                await fs.rm(path.join(deployDir, 'backup'), { recursive: true, force: true });
            } catch (error) {
                logger.warn(`Cleanup error: ${error.message}`);
            }
        }
    }

    sendSuccess(ws, data) {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
                type: 'status',
                payload: data
            }));
        }
    }

    sendError(ws, data) {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
                type: 'status',
                payload: data
            }));
        }
    }

    sendLogs(ws, deploymentId, log) {
        if (ws.readyState === ws.OPEN) {
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