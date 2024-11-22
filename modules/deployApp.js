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

    // Use a version suffix for blue-green deployment
    const versionSuffix = Date.now(); // Unique identifier for the new deployment
    const projectName = `${deploymentId}-${appName}-${versionSuffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const deployDir = path.join('/opt/cloudlunacy/deployments', deploymentId, versionSuffix.toString());
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

        // No longer stopping existing containers here
        // We'll keep the old container running until the new one is ready

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

        // Generate deployment files with unique service and project names
        sendLogs(ws, deploymentId, 'Generating deployment files...');
        const templateHandler = new TemplateHandler(
            path.join('/opt/cloudlunacy/templates'),
            deployConfig
        );

        const files = await templateHandler.generateDeploymentFiles({
            appType,
            appName: serviceName, // Service name remains the same for Traefik routing
            projectName, // Unique project name for docker-compose
            environment,
            containerPort,
            hostPort,
            envFile: path.basename(envFilePath),
            domain,
            buildConfig: {
                nodeVersion: '18',
                buildOutputDir: 'build',
                cacheControl: 'public, max-age=31536000'
            },
            versionSuffix // Pass version suffix to templates
        });

        // Write deployment files
        await Promise.all([
            fs.writeFile('Dockerfile', files.dockerfile),
            fs.writeFile('docker-compose.yml', files.dockerCompose)
        ]);

        // Build container with unique image name
        sendLogs(ws, deploymentId, 'Building container...');
        try {
            const imageName = `${serviceName}:${versionSuffix}`;

            // Build with detailed output and unique image name
            const buildResult = await executeCommand('docker-compose', [
                'build',
                '--no-cache',
                '--progress=plain',
                '--build-arg', `VERSION_SUFFIX=${versionSuffix}`
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
            const verification = await verifyBuild(imageName);
            if (!verification.success) {
                throw new Error(`Build verification failed: ${verification.error}\n${verification.logs}`);
            }

            logger.info(`Image built and verified successfully with ID: ${verification.imageId}`);
            logger.info(`Image name: ${verification.imageName}`);

        } catch (error) {
            logger.error('Build failed:', error);
            throw new Error(`Container build failed: ${error.message}`);
        }

        // Start new container with proper naming
        sendLogs(ws, deploymentId, 'Starting new container...');
        try {
            // Start new container with unique project name and labels
            const startResult = await executeCommand('docker-compose', ['up', '-d'], {
                env: {
                    ...process.env,
                    COMPOSE_PROJECT_NAME: projectName
                }
            });
            logger.info('Start command output:', startResult.stdout);

            // Wait for container initialization
            await new Promise(resolve => setTimeout(resolve, 10000));

            // Get container ID
            const { stdout: containerId } = await executeCommand('docker-compose', ['ps', '-q'], {
                env: {
                    ...process.env,
                    COMPOSE_PROJECT_NAME: projectName
                }
            });
            
            if (!containerId) {
                throw new Error('Container was not created successfully');
            }

            // Connect container to traefik-network
            await executeCommand('docker', ['network', 'connect', 'traefik-network', containerId.trim()]);
            logger.info('Connected new container to traefik-network');

        } catch (error) {
            logger.error('Starting new container failed:', error);
            throw new Error(`Starting new container failed: ${error.message}`);
        }

        // Wait for the new container to be healthy
        sendLogs(ws, deploymentId, 'Waiting for new container to be healthy...');
        const health = await checkDeploymentHealth(projectName, domain, versionSuffix);
        
        if (!health.healthy) {
            throw new Error(`Health check failed: ${health.message}`);
        }

        // Update Traefik to route traffic to the new container
        sendLogs(ws, deploymentId, 'Switching traffic to the new container...');
        await switchTrafficToNewVersion(serviceName, versionSuffix);
        logger.info('Traffic switched to the new container');

        // Stop and remove old containers
        sendLogs(ws, deploymentId, 'Cleaning up old containers...');
        await cleanupOldContainers(serviceName, projectName, versionSuffix);
        logger.info('Old containers cleaned up');

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

            // Cleanup new container
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

async function verifyBuild(imageName) {
    try {
        // Check if image exists
        const { stdout: imageList } = await executeCommand('docker', [
            'images',
            '--format', '{{.Repository}}:{{.Tag}}'
        ]);
        
        logger.debug('Available images:', imageList);
        
        const images = imageList.split('\n').filter(Boolean);
        if (!images.includes(imageName)) {
            logger.error('Build verification failed - Image not found');
            return {
                success: false,
                error: 'Image was not built successfully',
                logs: 'No matching image found after build'
            };
        }

        // Verify image can be inspected
        const { stdout: inspectOutput } = await executeCommand('docker', [
            'inspect',
            imageName
        ]);

        const imageInfo = JSON.parse(inspectOutput)[0];
        if (!imageInfo || !imageInfo.Id) {
            throw new Error('Invalid image inspection result');
        }

        return {
            success: true,
            imageId: imageInfo.Id,
            imageName
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

async function checkDeploymentHealth(projectName, domain, versionSuffix) {
    try {
        logger.info(`Starting health check for service: ${projectName}`);
        
        // Wait for some time to allow the container to start
        await new Promise(resolve => setTimeout(resolve, 15000));

        // Check container status
        const { stdout: containerId } = await executeCommand('docker-compose', ['ps', '-q'], {
            env: {
                ...process.env,
                COMPOSE_PROJECT_NAME: projectName
            }
        });

        if (!containerId) {
            throw new Error('Container not found');
        }

        // Check health status
        const { stdout: inspectOutput } = await executeCommand('docker', [
            'inspect',
            '--format', '{{json .State.Health}}',
            containerId.trim()
        ]);

        const healthInfo = JSON.parse(inspectOutput);
        if (healthInfo && healthInfo.Status !== 'healthy') {
            throw new Error(`Container health status: ${healthInfo.Status}`);
        }

        // Check the application is responding via Traefik
        if (domain) {
            logger.info(`Verifying application response at domain: ${domain}`);
            const response = await executeCommand('curl', [
                '-s',
                '-o',
                '/dev/null',
                '-w',
                '"%{http_code}"',
                '-H',
                `Host: ${domain}`,
                `http://localhost:80/health`
            ]);

            const httpCode = response.stdout.replace(/"/g, '');
            if (httpCode !== '200') {
                throw new Error(`Application health endpoint responded with status code: ${httpCode}`);
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

async function switchTrafficToNewVersion(serviceName, versionSuffix) {
    // Assuming Traefik uses labels to route traffic
    // We'll update the labels to point to the new container

    // Get the container ID of the new version
    const { stdout: newContainerId } = await executeCommand('docker', [
        'ps',
        '-q',
        '--filter', `name=${serviceName}`,
        '--filter', `ancestor=${serviceName}:${versionSuffix}`
    ]);

    if (!newContainerId) {
        throw new Error('New container not found for traffic switch');
    }

    // Update Traefik labels (if necessary)
    // Since we're using unique project names, Traefik should automatically route to the new container
    // Alternatively, ensure the old container's labels are disabled or the old container is stopped
}

async function cleanupOldContainers(serviceName, currentProjectName, versionSuffix) {
    // List all containers for the service excluding the current one
    const { stdout: containers } = await executeCommand('docker', [
        'ps',
        '-a',
        '--filter', `name=${serviceName}`,
        '--format', '{{.ID}} {{.Names}} {{.Label "com.docker.compose.project"}}'
    ]);

    const containerList = containers.split('\n').filter(Boolean);

    for (const line of containerList) {
        const [containerId, containerName, projectLabel] = line.split(' ');
        if (projectLabel !== currentProjectName) {
            // Stop and remove the old container
            await executeCommand('docker', ['stop', containerId]);
            await executeCommand('docker', ['rm', containerId]);
            logger.info(`Stopped and removed old container: ${containerName}`);
        }
    }

    // Remove old images
    const { stdout: images } = await executeCommand('docker', [
        'images',
        '--format', '{{.Repository}}:{{.Tag}} {{.ID}}'
    ]);

    const imageList = images.split('\n').filter(Boolean);

    for (const line of imageList) {
        const [imageName, imageId] = line.split(' ');
        if (imageName.startsWith(`${serviceName}:`) && !imageName.endsWith(versionSuffix)) {
            await executeCommand('docker', ['rmi', '-f', imageId]);
            logger.info(`Removed old image: ${imageName}`);
        }
    }
}

module.exports = deployApp;