const { executeCommand } = require('../utils/executor');
const logger = require('../utils/logger');
const fs = require('fs');
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
        domain,
        envVarsToken
    } = payload;

    const serviceName = `${appName}-${environment}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const deployDir = path.join('/opt/cloudlunacy/deployments', deploymentId);
    const currentDir = process.cwd();
    const tempContainerName = `${serviceName}-${deploymentId.substring(0, 8)}`;
    
    logger.info(`Starting deployment ${deploymentId} for ${appType} app: ${appName}`);
    
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

        // Check for existing deployment
        const { stdout: existingContainer } = await executeCommand('docker', [
            'ps',
            '-a',
            '--filter', `name=${serviceName}`,
            '--format', '{{.Names}}'
        ], { silent: true });

        if (existingContainer) {
            sendLogs(ws, deploymentId, `Found existing container: ${existingContainer}`);
            try {
                await executeCommand('docker', ['stop', existingContainer]);
                await executeCommand('docker', ['rm', existingContainer]);
                sendLogs(ws, deploymentId, 'Removed existing container');
            } catch (error) {
                logger.warn('Error removing existing container:', error);
            }
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

        // Generate deployment files
        sendLogs(ws, deploymentId, 'Generating deployment files...');
        const templateHandler = new TemplateHandler(
            path.join('/opt/cloudlunacy/templates'),
            deployConfig
        );

        const files = await templateHandler.generateDeploymentFiles({
            appType,
            appName: tempContainerName,
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

        // Verify and log deployment files
        logger.info('Dockerfile contents:', await fs.readFile('Dockerfile', 'utf-8'));
        logger.info('docker-compose.yml contents:', await fs.readFile('docker-compose.yml', 'utf-8'));

        // Build container
        sendLogs(ws, deploymentId, 'Building container...');
        try {
            // Clean up existing images
            const { stdout: existingImages } = await executeCommand('docker', [
                'images',
                '--format', '{{.Repository}}',
                tempContainerName
            ]);
            
            if (existingImages) {
                await executeCommand('docker', ['rmi', '-f', tempContainerName]);
            }

            // Build with detailed output
            const buildResult = await executeCommand('docker-compose', [
                'build',
                '--no-cache',
                '--progress=plain'
            ]);
            
            logger.info('Build output:', buildResult.stdout);
            if (buildResult.stderr) {
                logger.warn('Build warnings:', buildResult.stderr);
            }

            // Verify image was created
            const { stdout: imageCheck } = await executeCommand('docker', [
                'images',
                '--format', '{{.Repository}}:{{.Tag}}',
                tempContainerName
            ]);
            
            if (!imageCheck) {
                throw new Error('Image was not created after build');
            }
            logger.info('Image created successfully:', imageCheck);
        } catch (error) {
            throw new Error(`Container build failed: ${error.message}`);
        }

        // Start container
        sendLogs(ws, deploymentId, 'Starting container...');
        try {
            // Clean up existing containers
            await executeCommand('docker-compose', ['down', '--remove-orphans']);
            
            // Start container
            const startResult = await executeCommand('docker-compose', ['up', '-d']);
            logger.info('Start command output:', startResult.stdout);
            if (startResult.stderr) {
                logger.warn('Start command warnings:', startResult.stderr);
            }

            // Wait for container initialization
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Check container status
            const { stdout: psOutput } = await executeCommand('docker-compose', ['ps']);
            logger.info('Docker compose ps output:', psOutput);
            
            if (!psOutput.includes(tempContainerName)) {
                const { stdout: logs } = await executeCommand('docker-compose', ['logs']);
                logger.error('Container logs:', logs);
                throw new Error('Container was not created');
            }

            // Get detailed container information
            const { stdout: inspectOutput } = await executeCommand('docker', ['inspect', tempContainerName]);
            const containerInfo = JSON.parse(inspectOutput)[0];
            
            if (!containerInfo.State.Running) {
                throw new Error(`Container is not running. State: ${JSON.stringify(containerInfo.State)}`);
            }

            logger.info('Container state:', containerInfo.State);
        } catch (error) {
            // Get all available logs
            try {
                const { stdout: logs } = await executeCommand('docker-compose', ['logs']);
                logger.error('Container logs:', logs);
            } catch (logError) {
                logger.error('Failed to retrieve logs:', logError);
            }
            throw new Error(`Container start failed: ${error.message}`);
        }

        // Wait for container to be healthy
        sendLogs(ws, deploymentId, 'Waiting for container to be healthy...');
        const health = await checkDeploymentHealth(tempContainerName, domain);
        
        if (!health.healthy) {
            throw new Error(`Health check failed: ${health.message}`);
        }

        // Perform zero-downtime swap if needed
        if (existingContainer) {
            sendLogs(ws, deploymentId, 'Performing zero-downtime swap...');
            
            await executeCommand('docker', ['network', 'connect', 'traefik-network', tempContainerName]);
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            try {
                await executeCommand('docker', ['network', 'disconnect', 'traefik-network', existingContainer]);
                await executeCommand('docker', ['stop', existingContainer]);
                await executeCommand('docker', ['rm', existingContainer]);
            } catch (swapError) {
                logger.warn('Error during container swap:', swapError);
            }
        } else {
            // If no existing container, just connect to traefik network
            await executeCommand('docker', ['network', 'connect', 'traefik-network', tempContainerName]);
        }

        // Rename temporary container to final name
        await executeCommand('docker', ['rename', tempContainerName, serviceName]);

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
            // Get logs before cleanup
            try {
                const { stdout: finalLogs } = await executeCommand('docker-compose', ['logs']);
                logger.error('Final container logs:', finalLogs);
            } catch (logError) {
                logger.warn('Could not retrieve final logs:', logError);
            }

            // Cleanup containers
            await executeCommand('docker-compose', ['down', '-v']).catch(() => {});
            await executeCommand('docker', ['rm', '-f', tempContainerName]).catch(() => {});
            
            // Cleanup directory
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

async function checkDeploymentHealth(serviceName, domain) {
    try {
        logger.info(`Starting health check for service: ${serviceName}`);
        
        // Increase initial wait time to 30 seconds
        await new Promise(resolve => setTimeout(resolve, 30000));

        // Get container logs first for debugging
        try {
            const { stdout: containerLogs } = await executeCommand('docker', [
                'logs',
                '--tail', '50',
                serviceName
            ], { silent: true });
            
            logger.info('Recent container logs:', containerLogs);
            
            // Check for common error patterns in logs
            if (containerLogs.includes('Error:') || containerLogs.includes('error:')) {
                throw new Error(`Container startup errors detected in logs: ${containerLogs}`);
            }
        } catch (logError) {
            logger.warn('Failed to fetch container logs:', logError);
        }

        // Check container status
        try {
            const { stdout: inspectOutput } = await executeCommand('docker', [
                'inspect',
                serviceName
            ], { silent: true });
            
            const containerInfo = JSON.parse(inspectOutput)[0];
            logger.info('Container state:', containerInfo.State);
            
            if (!containerInfo.State.Running) {
                throw new Error(`Container is not running. State: ${JSON.stringify(containerInfo.State)}`);
            }
        } catch (inspectError) {
            throw new Error(`Failed to inspect container: ${inspectError.message}`);
        }

        // If domain is provided, perform progressive health checks
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
            } catch (traefikError) {
                throw new Error(`Traefik check failed: ${traefikError.message}`);
            }

            // Progressive domain checks with retries
            const maxRetries = 5;
            for (let i = 0; i < maxRetries; i++) {
                logger.info(`Starting health check attempt ${i + 1}/${maxRetries}`);
                
                try {
                    // Check container's internal health endpoint
                    const { stdout: containerHealth, stderr: containerHealthErr } = await executeCommand('docker', [
                        'exec',
                        serviceName,
                        'curl',
                        '--max-time',
                        '5',
                        'http://localhost:8080/health'
                    ], { silent: true });
                    
                    logger.info(`Container health check response: ${containerHealth}`);
                    if (containerHealthErr) {
                        logger.warn('Container health check stderr:', containerHealthErr);
                    }

                    if (!containerHealth.includes('OK')) {
                        throw new Error('Container health check failed - no OK response');
                    }

                    // Check domain health endpoint through Traefik
                    const { stdout: domainHealth, stderr: domainHealthErr } = await executeCommand('curl', [
                        '--max-time',
                        '5',
                        '-H',
                        `Host: ${domain}`,
                        'http://localhost:80/health'
                    ], { silent: true });
                    
                    logger.info(`Domain health check response: ${domainHealth}`);
                    if (domainHealthErr) {
                        logger.warn('Domain health check stderr:', domainHealthErr);
                    }

                    if (!domainHealth.includes('OK')) {
                        throw new Error('Domain health check failed - no OK response');
                    }

                    // If we get here, both checks passed
                    logger.info('All health checks passed successfully');
                    logger.info(`Application is accessible at http://${domain}`);
                    logger.info(`Health endpoint is available at http://${domain}/health`);
                    return { healthy: true };
                    
                } catch (checkError) {
                    logger.warn(`Health check attempt ${i + 1} failed:`, checkError.message);
                    
                    if (i === maxRetries - 1) {
                        const debugInfo = await collectDebugInfo(serviceName, domain);
                        throw new Error(`Health checks failed after ${maxRetries} attempts. Debug info: ${JSON.stringify(debugInfo)}`);
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 10000));
                }
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