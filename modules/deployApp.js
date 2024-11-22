const { executeCommand } = require('../utils/executor');
const logger = require('../utils/logger');
const fs = require('fs').promises; 
const path = require('path');
const TemplateHandler = require('../utils/templateHandler');
const deployConfig = require('../deployConfig.json');
const { ensureDeploymentPermissions } = require('../utils/permissionCheck');
const apiClient = require('../utils/apiClient');
const EnvironmentManager = require('../utils/environmentManager');
const portManager = require('../utils/portManager');

async function deployApp(payload, ws) {
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

    const projectName = `${deploymentId}-${serviceName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const deployDir = path.join('/opt/cloudlunacy/deployments', deploymentId);
    const currentDir = process.cwd();
    
    logger.info(`Starting deployment ${deploymentId} for ${appType} app: ${appName}`);
    logger.info(`Using service name: ${serviceName}`);
    logger.info(`Using project name: ${projectName}`);
    
    try {
        // Check permissions before deployment
        const permissionsOk = await ensureDeploymentPermissions();
        if (!permissionsOk) {
            throw new Error('Deployment failed: Permission check failed');
        }

        // Check for required tools
        await executeCommand('which', ['docker']);
        await executeCommand('which', ['docker-compose']);
        
        // Set up deployment directory
        await fs.mkdir(deployDir, { recursive: true });
        process.chdir(deployDir);

        // Send initial status
        sendStatus(ws, {
            deploymentId,
            status: 'in_progress',
            message: 'Starting deployment...'
        });

        // Initialize port manager and allocate ports
        await portManager.initialize();
        const { hostPort, containerPort } = await portManager.allocatePort(serviceName);
        logger.info(`Allocated ports - host: ${hostPort}, container: ${containerPort}`);

        // Clean up any existing containers
        try {
            // Find all containers with the service name
            const { stdout: existingContainers } = await executeCommand('docker', [
                'ps',
                '-a',
                '--format', '{{.Names}}',
                '--filter', `name=${projectName}`
            ]);

            if (existingContainers) {
                const containers = existingContainers.split('\n').filter(Boolean);
                for (const container of containers) {
                    sendLogs(ws, deploymentId, `Found existing container: ${container}`);
                    await executeCommand('docker', ['stop', container]).catch(() => {});
                    await executeCommand('docker', ['rm', container]).catch(() => {});
                    sendLogs(ws, deploymentId, `Removed container: ${container}`);
                }
            }
        } catch (error) {
            logger.warn('Error checking/removing existing containers:', error);
        }

        // Clone repository
        sendLogs(ws, deploymentId, 'Cloning repository...');
        const repoUrl = `https://x-access-token:${githubToken}@github.com/${repositoryOwner}/${repositoryName}.git`;
        await executeCommand('git', ['clone', '-b', branch, repoUrl, '.']);

        // Set up environment variables
        sendLogs(ws, deploymentId, 'Setting up environment variables...');
        let envFilePath;
        try {
            const { data } = await apiClient.post(`/api/deploy/env-vars/${deploymentId}`, {
                token: envVarsToken
            });
            
            if (!data || !data.variables) {
                throw new Error('Invalid response format for environment variables');
            }
            
            logger.info('Successfully retrieved environment variables');
            const envManager = new EnvironmentManager(deployDir);
            envFilePath = await envManager.writeEnvFile(data.variables, environment);
            await fs.copyFile(envFilePath, path.join(deployDir, '.env'));
            logger.info('Environment files written successfully');
        } catch (error) {
            throw new Error(`Environment setup failed: ${error.message}`);
        }

        // Generate deployment files with consistent service naming
        sendLogs(ws, deploymentId, 'Generating deployment files...');
        const templateHandler = new TemplateHandler(
            path.join('/opt/cloudlunacy/templates'),
            deployConfig
        );

        const files = await templateHandler.generateDeploymentFiles({
            appType,
            appName: serviceName,
            environment,
            containerPort,
            hostPort,
            envFile: path.basename(envFilePath),
            domain,
            buildConfig: {
                nodeVersion: '18',
                buildOutputDir: 'build',
                cacheControl: 'public, max-age=31536000'
            }
        });

        // Write deployment files
        await Promise.all([
            fs.writeFile('Dockerfile', files.dockerfile),
            fs.writeFile('docker-compose.yml', files.dockerCompose)
        ]);

        // Build container
        sendLogs(ws, deploymentId, 'Building container...');
        try {
            // Remove any existing images
            await executeCommand('docker', ['rmi', '-f', serviceName]).catch(() => {});
            
            // Build with detailed output and consistent project name
            const buildResult = await executeCommand('docker-compose', [
                'build',
                '--no-cache',
                '--progress=plain'
            ], {
                logOutput: true,
                env: {
                    ...process.env,
                    DOCKER_BUILDKIT: '1',
                    COMPOSE_DOCKER_CLI_BUILD: '1',
                    COMPOSE_PROJECT_NAME: projectName
                }
            });
            
            logger.info('Build command completed');
            if (buildResult.stdout) {
                logger.info('Build output:', buildResult.stdout);
            }
            if (buildResult.stderr) {
                logger.warn('Build warnings:', buildResult.stderr);
            }

            // Verify the build
            const verification = await verifyBuild(serviceName, projectName);
            if (!verification.success) {
                throw new Error(`Build verification failed: ${verification.error}\n${verification.logs}`);
            }

            logger.info(`Image built and verified successfully with ID: ${verification.imageId}`);
            logger.info(`Image name: ${verification.imageName}`);

        } catch (error) {
            logger.error('Build failed:', error);
            throw new Error(`Container build failed: ${error.message}`);
        }

        // Start container with proper naming
        sendLogs(ws, deploymentId, 'Starting container...');
        try {
            // Stop any existing containers with consistent project name
            await executeCommand('docker-compose', ['down', '--remove-orphans'], {
                env: {
                    ...process.env,
                    COMPOSE_PROJECT_NAME: projectName
                }
            });
            
            // Start new container with consistent project name
            const startResult = await executeCommand('docker-compose', ['up', '-d'], {
                env: {
                    ...process.env,
                    COMPOSE_PROJECT_NAME: projectName
                }
            });
            logger.info('Start command output:', startResult.stdout);

            // Wait for container initialization
            await new Promise(resolve => setTimeout(resolve, 10000));

            // Get container ID with consistent project name
            const { stdout: containerId } = await executeCommand('docker-compose', ['ps', '-q'], {
                env: {
                    ...process.env,
                    COMPOSE_PROJECT_NAME: projectName
                }
            });
            
            if (!containerId) {
                throw new Error('Container was not created successfully');
            }

            // Get container status using the actual container ID
            const { stdout: inspectOutput } = await executeCommand('docker', [
                'inspect',
                containerId.trim()
            ]);
            const containerInfo = JSON.parse(inspectOutput)[0];
            
            if (!containerInfo.State.Running) {
                const { stdout: logs } = await executeCommand('docker-compose', ['logs'], {
                    env: {
                        ...process.env,
                        COMPOSE_PROJECT_NAME: projectName
                    }
                });
                logger.error('Container logs:', logs);
                throw new Error(`Container failed to start. State: ${JSON.stringify(containerInfo.State)}`);
            }

            logger.info('Container is running. State:', containerInfo.State);

        } catch (error) {
            logger.error('Container start failed:', error);
            // Get all possible logs
            try {
                const { stdout: logs } = await executeCommand('docker-compose', ['logs'], {
                    env: {
                        ...process.env,
                        COMPOSE_PROJECT_NAME: projectName
                    }
                });
                logger.error('Container logs:', logs);
                
                const { stdout: events } = await executeCommand('docker', [
                    'events',
                    '--since=5m',
                    '--until=0m',
                    `--filter=name=${projectName}`
                ]);
                logger.error('Docker events:', events);
            } catch (logError) {
                logger.error('Failed to retrieve logs:', logError);
            }
            throw new Error(`Container start failed: ${error.message}`);
        }

        // Wait for container to be healthy
        sendLogs(ws, deploymentId, 'Waiting for container to be healthy...');
        const health = await checkDeploymentHealth(projectName, domain);
        
        if (!health.healthy) {
            throw new Error(`Health check failed: ${health.message}`);
        }

        // Connect to traefik network using the correct container name
        const { stdout: containerId } = await executeCommand('docker-compose', ['ps', '-q'], {
            env: {
                ...process.env,
                COMPOSE_PROJECT_NAME: projectName
            }
        });
        await executeCommand('docker', ['network', 'connect', 'traefik-network', containerId.trim()]);

        // Send success status
        sendStatus(ws, {
            deploymentId,
            status: 'success',
            message: 'Deployment completed successfully',
            domain,
            port: hostPort
        });

    } catch (error) {
        logger.error(`Deployment ${deploymentId} failed:`, error);
        
        // Enhanced cleanup on failure
        try {
            // Get final logs before cleanup
            try {
                const { stdout: composeLogs } = await executeCommand('docker-compose', ['logs'], {
                    env: {
                        ...process.env,
                        COMPOSE_PROJECT_NAME: projectName
                    }
                });
                logger.error('Final compose logs:', composeLogs);
            } catch (logError) {
                logger.warn('Could not retrieve final logs:', logError);
            }

            // Cleanup with consistent project name
            await executeCommand('docker-compose', ['down', '--volumes', '--remove-orphans'], {
                env: {
                    ...process.env,
                    COMPOSE_PROJECT_NAME: projectName
                }
            }).catch(() => {});
            await fs.rm(deployDir, { recursive: true, force: true });
        } catch (cleanupError) {
            logger.error('Cleanup failed:', cleanupError);
        }

        sendStatus(ws, {
            deploymentId,
            status: 'failed',
            message: error.message || 'Deployment failed'
        });
    } finally {
        process.chdir(currentDir);
    }
}
async function verifyBuild(serviceName, deploymentId) {
    try {
        // In docker-compose, the image name includes the project name and service name
        const expectedImagePrefix = `${deploymentId}-${serviceName}`;
        
        // Check if image exists with broader filter
        const { stdout: imageList } = await executeCommand('docker', [
            'images',
            '--format', '{{.Repository}}:{{.Tag}}'
        ]);
        
        logger.debug('Available images:', imageList);
        
        // Check if any of the images match our expected prefix
        const images = imageList.split('\n').filter(Boolean);
        const matchingImage = images.find(img => img.includes(expectedImagePrefix));
        
        if (!matchingImage) {
            // Get build logs for debugging
            const { stdout: buildLogs } = await executeCommand('docker-compose', [
                'logs',
                '--no-color'
            ]).catch(() => ({ stdout: 'No build logs available' }));

            // Get any build-time container logs
            const { stdout: containerLogs } = await executeCommand('docker', [
                'ps',
                '-a',
                '--filter', `name=${serviceName}-build`,
                '--format', '{{.ID}}'
            ]).then(async (result) => {
                if (result.stdout) {
                    return executeCommand('docker', ['logs', result.stdout.trim()]);
                }
                return { stdout: 'No build container logs available' };
            }).catch(() => ({ stdout: 'Failed to get build container logs' }));

            logger.error('Build verification failed - Image not found');
            logger.error('Available images:', imageList);
            logger.error('Expected image prefix:', expectedImagePrefix);
            logger.error('Build logs:', buildLogs);
            logger.error('Build container logs:', containerLogs);
            
            return {
                success: false,
                error: 'Image was not built successfully',
                logs: `Build logs:\n${buildLogs}\n\nBuild container logs:\n${containerLogs}`
            };
        }

        // Verify image can be inspected
        const { stdout: inspectOutput } = await executeCommand('docker', [
            'inspect',
            matchingImage.split(':')[0]
        ]);

        const imageInfo = JSON.parse(inspectOutput)[0];
        if (!imageInfo || !imageInfo.Id) {
            throw new Error('Invalid image inspection result');
        }

        return {
            success: true,
            imageId: imageInfo.Id,
            imageName: matchingImage
        };
    } catch (error) {
        logger.error('Build verification error:', error);
        return {
            success: false,
            error: error.message,
            logs: error.stderr || 'No error logs available'
        };
    }
}

function sendStatus(ws, data) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
            type: 'status',
            payload: data
        }));
    }
}

function sendLogs(ws, deploymentId, log) {
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

async function checkDeploymentHealth(projectName, domain) {
    try {
        logger.info(`Starting health check for service: ${projectName}`);
        
        // Increase initial wait time to 30 seconds
        await new Promise(resolve => setTimeout(resolve, 30000));

        // Get the actual container ID from docker-compose
        const { stdout: containerId } = await executeCommand('docker-compose', ['ps', '-q'], {
            env: {
                ...process.env,
                COMPOSE_PROJECT_NAME: projectName
            }
        });

        if (!containerId) {
            throw new Error('Container not found');
        }

        // Get container logs
        try {
            const { stdout: containerLogs } = await executeCommand('docker', [
                'logs',
                '--tail', '50',
                containerId.trim()
            ], { silent: true });
            
            logger.info('Recent container logs:', containerLogs);
            
            // Check for common error patterns in logs
            if (containerLogs.includes('Error:') || containerLogs.includes('error:')) {
                throw new Error(`Container startup errors detected in logs: ${containerLogs}`);
            }
        } catch (logError) {
            logger.warn('Failed to fetch container logs:', logError);
        }

        // Check container status using container ID
        try {
            const { stdout: inspectOutput } = await executeCommand('docker', [
                'inspect',
                containerId.trim()
            ], { silent: true });
            
            const containerInfo = JSON.parse(inspectOutput)[0];
            logger.info('Container state:', containerInfo.State);
            
            if (!containerInfo.State.Running) {
                throw new Error(`Container is not running. State: ${JSON.stringify(containerInfo.State)}`);
            }

            // Check health status
            if (containerInfo.State.Health) {
                if (containerInfo.State.Health.Status === 'unhealthy') {
                    throw new Error('Container health check failed');
                }
            }
        } catch (inspectError) {
            throw new Error(`Failed to inspect container: ${inspectError.message}`);
        }

        // If domain is provided, check HTTP health endpoint
        if (domain) {
            logger.info(`Verifying domain configuration for ${domain}`);
            
            // Check if Traefik is running
            try {
                const { stdout: traefikStatus } = await executeCommand('docker', [
                    'inspect',
                    '--format',
                    '{{.State.Status}}',
                    'traefik'
                ], { silent: true });

                if (!traefikStatus.includes('running')) {
                    throw new Error('Traefik container is not running');
                }
                
                logger.info('Traefik is running');

                // HTTP health check through Traefik
                const maxRetries = 5;
                for (let i = 0; i < maxRetries; i++) {
                    try {
                        const { stdout: healthCheck } = await executeCommand('curl', [
                            '--max-time', '5',
                            '-H', `Host: ${domain}`,
                            'http://localhost:80/health'
                        ], { silent: true });

                        if (!healthCheck.includes('OK')) {
                            throw new Error('Health endpoint not responding correctly');
                        }

                        logger.info('Health check passed');
                        break;
                    } catch (healthError) {
                        if (i === maxRetries - 1) {
                            throw new Error(`Health check failed after ${maxRetries} attempts`);
                        }
                        await new Promise(resolve => setTimeout(resolve, 10000));
                    }
                }
            } catch (error) {
                throw new Error(`Domain health check failed: ${error.message}`);
            }
        }

        return { healthy: true };
    } catch (error) {
        logger.error('Health check failed:', error);
        return { 
            healthy: false, 
            message: error.message 
        };
    }
}

async function collectDebugInfo(serviceName, domain) {
    const debugInfo = {
        containerState: null,
        containerLogs: null,
        traefikState: null,
        networkInfo: null,
        portBindings: null,
        healthEndpoint: null
    };

    try {
        // Get container state
        const { stdout: containerState } = await executeCommand('docker', [
            'inspect',
            '--format',
            '{{json .State}}',
            serviceName
        ], { silent: true });
        debugInfo.containerState = JSON.parse(containerState);

        // Get container logs
        const { stdout: containerLogs } = await executeCommand('docker', [
            'logs',
            '--tail',
            '50',
            serviceName
        ], { silent: true });
        debugInfo.containerLogs = containerLogs;

        // Get Traefik state
        const { stdout: traefikState } = await executeCommand('docker', [
            'inspect',
            '--format',
            '{{json .State}}',
            'traefik'
        ], { silent: true });
        debugInfo.traefikState = JSON.parse(traefikState);

        // Get network information
        const { stdout: networkInfo } = await executeCommand('docker', [
            'network',
            'inspect',
            'traefik-network'
        ], { silent: true });
        debugInfo.networkInfo = JSON.parse(networkInfo);

        // Get port bindings
        const { stdout: portBindings } = await executeCommand('docker', [
            'port',
            serviceName
        ], { silent: true });
        debugInfo.portBindings = portBindings;

        // Check health endpoint specifically
        const { stdout: healthCheck } = await executeCommand('curl', [
            '--max-time',
            '5',
            '-H',
            `Host: ${domain}`,
            'http://localhost:80/health'
        ], { silent: true });
        debugInfo.healthEndpoint = healthCheck;

    } catch (error) {
        logger.warn('Error collecting debug info:', error);
    }

    return debugInfo;
}




module.exports = deployApp;