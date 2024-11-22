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
    const deployDir = path.join('/opt/cloudlunacy/deployments', serviceName);
    const tempDir = path.join(deployDir, `temp-${deploymentId}`);
    const currentDir = process.cwd();
    
    logger.info(`Starting deployment ${deploymentId} for ${appType} app: ${appName}`);
    
    try {
        // Check permissions before deployment
        const permissionsOk = await ensureDeploymentPermissions();
        if (!permissionsOk) {
            throw new Error('Deployment failed: Permission check failed');
        }

        // Initialize port manager and get port mapping
        await portManager.initialize();
        const portInfo = await portManager.getPortInfo(appName, environment);
        
        let { hostPort, containerPort } = portInfo || await portManager.allocatePort(serviceName);
        
        // Verify port availability
        if (portInfo) {
            const isAvailable = await portManager.ensurePortAvailable(hostPort);
            if (!isAvailable) {
                logger.warn(`Port ${hostPort} could not be freed, allocating new port`);
                ({ hostPort, containerPort } = await portManager.allocatePort(serviceName));
            }
        }

        // Ensure base deployment directory exists
        await fs.promises.mkdir(deployDir, { recursive: true });

        // Clean up any existing temporary directory
        if (await fs.promises.access(tempDir).catch(() => false)) {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }

        // Create fresh temporary directory and change to it
        await fs.promises.mkdir(tempDir, { recursive: true });
        process.chdir(tempDir);

        // Send initial status
        sendStatus(ws, {
            deploymentId,
            status: 'in_progress',
            message: 'Starting deployment...'
        });

        // Setup environment variables first
        sendLogs(ws, deploymentId, 'Setting up environment...');
        let envVars, envFilePath;
        try {
            const { data } = await apiClient.post(`/api/deploy/env-vars/${deploymentId}`, {
                token: envVarsToken
            });
            
            if (!data || !data.variables) {
                throw new Error('Invalid response format for environment variables');
            }
            
            envVars = data.variables;
            logger.info('Successfully retrieved environment variables');

            const envManager = new EnvironmentManager(tempDir);
            envFilePath = await envManager.writeEnvFile(envVars, environment);
            await fs.promises.copyFile(envFilePath, path.join(tempDir, '.env'));
            
            logger.info(`Environment files written successfully for ${environment}`);
        } catch (error) {
            throw new Error(`Environment setup failed: ${error.message}`);
        }

        // Clone repository
        sendLogs(ws, deploymentId, 'Cloning repository...');
        try {
            await executeCommand('git', ['clone', '-b', branch, 
                `https://x-access-token:${githubToken}@github.com/${repositoryOwner}/${repositoryName}.git`,
                'repo'
            ]);
            
            // Move all files from the cloned repo directory to tempDir
            const repoDir = path.join(tempDir, 'repo');
            const files = await fs.promises.readdir(repoDir);
            for (const file of files) {
                await fs.promises.rename(
                    path.join(repoDir, file),
                    path.join(tempDir, file)
                );
            }
            // Remove the now-empty repo directory
            await fs.promises.rmdir(repoDir);
        } catch (error) {
            throw new Error(`Repository clone failed: ${error.message}`);
        }

        // Generate deployment files
        const tempContainerName = `${serviceName}-${deploymentId.substring(0, 8)}`;
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

        // Build and start new container
        sendLogs(ws, deploymentId, 'Building and starting new container...');
        await executeCommand('docker-compose', ['up', '-d', '--build']);

        // Wait for new container to be healthy
        sendLogs(ws, deploymentId, 'Waiting for new container to be healthy...');
        const health = await checkDeploymentHealth(tempContainerName, containerPort, domain);
        
        if (!health.healthy) {
            throw new Error(`New container health check failed: ${health.message}`);
        }

        // Check for existing container
        const { stdout: runningContainer } = await executeCommand('docker', [
            'ps',
            '--filter', `name=${serviceName}`,
            '--format', '{{.Names}}'
        ], { silent: true });

        // If we have a running container, perform zero-downtime swap
        if (runningContainer) {
            sendLogs(ws, deploymentId, 'Performing zero-downtime swap...');
            
            await executeCommand('docker', ['network', 'connect', 'traefik-network', tempContainerName]);
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            try {
                await executeCommand('docker', ['network', 'disconnect', 'traefik-network', runningContainer]);
                await executeCommand('docker', ['stop', runningContainer]);
                await executeCommand('docker', ['rm', runningContainer]);
            } catch (swapError) {
                logger.warn('Error during container swap:', swapError);
                // Continue with deployment even if cleanup fails
            }
        }

        // Rename temp container to final name
        await executeCommand('docker', ['rename', tempContainerName, serviceName]);

        // Verify final port mapping
        const finalMappingValid = await portManager.verifyPortMapping(
            hostPort,
            containerPort,
            serviceName
        );

        if (!finalMappingValid) {
            throw new Error('Final port mapping verification failed');
        }

        // Move successful deployment to final location
        await fs.promises.rm(deployDir, { recursive: true, force: true });
        await fs.promises.rename(tempDir, deployDir);

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
        
        // Cleanup temporary container if it exists
        const tempContainerName = `${serviceName}-${deploymentId.substring(0, 8)}`;
        try {
            await executeCommand('docker', ['stop', tempContainerName]).catch(() => {});
            await executeCommand('docker', ['rm', tempContainerName]).catch(() => {});
        } catch (cleanupError) {
            logger.error('Cleanup after failure error:', cleanupError);
        }

        // Clean up temporary directory
        try {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
            logger.error('Failed to clean up temporary directory:', cleanupError);
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