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
        await fs.promises.mkdir(deployDir, { recursive: true });
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
            '--filter', `name=${serviceName}`,
            '--format', '{{.Names}}'
        ], { silent: true });

        // Create temporary container name for new deployment
        const tempContainerName = `${serviceName}-${deploymentId.substring(0, 8)}`;

        // Clone repository
        sendLogs(ws, deploymentId, 'Cloning repository...');
        const repoUrl = `https://x-access-token:${githubToken}@github.com/${repositoryOwner}/${repositoryName}.git`;
        await executeCommand('git', ['clone', '-b', branch, repoUrl, '.']);

        // Retrieve and set up environment variables
        sendLogs(ws, deploymentId, 'Setting up environment variables...');
        let envVars = {};
        let envFilePath;
        try {
            const { data } = await apiClient.post(`/api/deploy/env-vars/${deploymentId}`, {
                token: envVarsToken
            });
            
            if (!data || !data.variables) {
                throw new Error('Invalid response format for environment variables');
            }
            
            envVars = data.variables;
            logger.info('Successfully retrieved environment variables');

            const envManager = new EnvironmentManager(deployDir);
            envFilePath = await envManager.writeEnvFile(envVars, environment);
            await fs.promises.copyFile(envFilePath, path.join(deployDir, '.env'));
            
            logger.info(`Environment files written successfully`);
        } catch (error) {
            throw new Error(`Environment setup failed: ${error.message}`);
        }

        // Generate deployment files
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
            fs.promises.writeFile('Dockerfile', files.dockerfile),
            fs.promises.writeFile('docker-compose.yml', files.dockerCompose)
        ]);

  // Build container with detailed output
sendLogs(ws, deploymentId, 'Building container...');
try {
    // Remove any existing container with the same name
    await executeCommand('docker', ['rm', '-f', tempContainerName]).catch(() => {});

    // Build with verbose output
    const buildResult = await executeCommand('docker-compose', [
        'build',
        '--no-cache',
        '--progress=plain'
    ]);
    logger.info('Build output:', buildResult.stdout);
    if (buildResult.stderr) {
        logger.warn('Build warnings/errors:', buildResult.stderr);
    }

} catch (error) {
    logger.error('Build failed:', error.stderr || error.message);
    throw new Error(`Container build failed: ${error.stderr || error.message}`);
}

// Start container
sendLogs(ws, deploymentId, 'Starting container...');
try {
    const startResult = await executeCommand('docker-compose', ['up', '-d']);
    logger.info('Container start output:', startResult.stdout);
    if (startResult.stderr) {
        logger.warn('Container start warnings/errors:', startResult.stderr);
    }

    // Verify container is running
    const psResult = await executeCommand('docker-compose', ['ps']);
    logger.info('Container status:', psResult.stdout);

    if (!psResult.stdout.includes(tempContainerName)) {
        throw new Error('Container failed to start after creation');
    }

} catch (error) {
    logger.error('Container failed to start:', error.stderr || error.message);
    throw new Error(`Container start failed: ${error.stderr || error.message}`);
}

        // Wait for container to be healthy
        sendLogs(ws, deploymentId, 'Waiting for container to be healthy...');
        const health = await checkDeploymentHealth(tempContainerName, domain);
        
        if (!health.healthy) {
            throw new Error(`Health check failed: ${health.message}`);
        }

        // If we have an existing container, perform zero-downtime swap
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
        if (error.stdout) {
            logger.error(`Standard Output: ${error.stdout}`);
        }
        if (error.stderr) {
            logger.error(`Standard Error: ${error.stderr}`);
        }
        
        // Enhanced cleanup on failure
        try {
            // Get logs before cleanup if possible
            const tempContainerName = `${serviceName}-${deploymentId.substring(0, 8)}`;
            try {
                const { stdout: finalLogs } = await executeCommand('docker-compose', ['logs']);
                logger.error('Final container logs:', finalLogs);
            } catch (logError) {
                logger.warn('Could not retrieve final logs:', logError);
            }

            // Cleanup container
            await executeCommand('docker-compose', ['down', '-v']).catch(() => {});
            await executeCommand('docker', ['rm', '-f', tempContainerName]).catch(() => {});
            
            // Cleanup directory
            await fs.promises.rm(deployDir, { recursive: true, force: true });
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