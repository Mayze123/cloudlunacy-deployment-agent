// src/modules/deployApp.js

const { executeCommand } = require('../utils/executor');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');
const TemplateHandler = require('../utils/templateHandler');
const deployConfig = require('../deployConfig.json');
const { ensureDeploymentPermissions } = require('../utils/permissionCheck');
const apiClient = require('../utils/apiClient');
const EnvironmentManager = require('../utils/environmentManager');

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
        port,
        envVarsToken
    } = payload;

    logger.info(`Starting deployment ${deploymentId} for ${appType} app: ${appName}`);
    
    const deployDir = path.join('/opt/cloudlunacy/deployments', deploymentId);
    const currentDir = process.cwd();
    const containerName = `${appName}-${environment}`;
    
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

        // Send initial status and logs
        sendStatus(ws, {
            deploymentId,
            status: 'in_progress',
            message: 'Starting deployment...'
        });

        // Cleanup existing containers and networks
        try {
            sendLogs(ws, deploymentId, `Cleaning up existing container: ${containerName}`);
            await executeCommand('docker', ['stop', containerName]).catch(() => {});
            await executeCommand('docker', ['rm', containerName]).catch(() => {});
            
            // Remove existing networks
            const networkName = `${deploymentId}_default`;
            await executeCommand('docker', ['network', 'rm', networkName]).catch(() => {});
            
            sendLogs(ws, deploymentId, 'Previous deployment cleaned up');
        } catch (error) {
            logger.warn('Cleanup warning:', error);
        }

        // Retrieve and set up environment variables
        sendLogs(ws, deploymentId, 'Retrieving environment variables...');
        let envVars = {};
        let envFilePath;
        try {
            logger.info(`Fetching env vars for deployment ${deploymentId}`);
            const { data } = await apiClient.post(`/api/deploy/env-vars/${deploymentId}`, {
                token: envVarsToken
            });
            
            if (!data || !data.variables) {
                throw new Error('Invalid response format for environment variables');
            }
            
            envVars = data.variables;
            logger.info('Successfully retrieved environment variables');
        } catch (error) {
            logger.error('Environment variables setup failed:', error);
            throw new Error(`Environment variables setup failed: ${error.message}`);
        }

        // Clone repository
        sendLogs(ws, deploymentId, 'Cloning repository...');
        const repoUrl = `https://x-access-token:${githubToken}@github.com/${repositoryOwner}/${repositoryName}.git`;
        await executeCommand('git', ['clone', '-b', branch, repoUrl, '.']);
        sendLogs(ws, deploymentId, 'Repository cloned successfully');

        // Initialize environment manager and write env file
        const envManager = new EnvironmentManager(deployDir);
        envFilePath = await envManager.writeEnvFile(envVars, environment);
        sendLogs(ws, deploymentId, 'Environment variables configured successfully');

        // Initialize template handler
        const templateHandler = new TemplateHandler(
            path.join('/opt/cloudlunacy/templates'),
            deployConfig
        );

        // Generate deployment files
        sendLogs(ws, deploymentId, 'Generating deployment configuration...');
        const files = await templateHandler.generateDeploymentFiles({
            appType,
            appName,
            environment,
            port,
            envFile: path.basename(envFilePath),
            buildConfig: {
                nodeVersion: '18',
                buildOutputDir: 'build',
                cacheControl: 'public, max-age=31536000'
            },
            domain: `${appName}-${environment}.yourdomain.com`
        });

        // Write and validate files
        await Promise.all([
            fs.writeFile('Dockerfile', files.dockerfile),
            fs.writeFile('docker-compose.yml', files.dockerCompose),
            files.nginxConf ? fs.writeFile('nginx.conf', files.nginxConf) : Promise.resolve()
        ]);

        // Update docker-compose with env file reference
        await envManager.updateDockerCompose(path.basename(envFilePath), containerName);

        // Validate docker-compose file
        try {
            await executeCommand('docker-compose', ['config']);
            sendLogs(ws, deploymentId, 'Deployment configuration validated');
        } catch (error) {
            throw new Error(`Invalid docker-compose configuration: ${error.message}`);
        }

        // Build and start containers
        sendLogs(ws, deploymentId, 'Building application...');
        await executeCommand('docker-compose', ['build', '--no-cache']);
        sendLogs(ws, deploymentId, 'Application built successfully');

        sendLogs(ws, deploymentId, 'Starting application...');
        await executeCommand('docker-compose', ['up', '-d', '--force-recreate']);
        sendLogs(ws, deploymentId, 'Application started successfully');

        // Verify deployment
        sendLogs(ws, deploymentId, 'Verifying deployment...');
        const health = await checkDeploymentHealth(port, containerName);
        
        if (!health.healthy) {
            throw new Error(`Deployment health check failed: ${health.message}`);
        }

        // Send success status
        sendStatus(ws, {
            deploymentId,
            status: 'success',
            message: 'Deployment completed successfully'
        });

    } catch (error) {
        logger.error(`Deployment ${deploymentId} failed:`, error);
        
        // Send detailed error message
        sendStatus(ws, {
            deploymentId,
            status: 'failed',
            message: error.message || 'Deployment failed'
        });

        // Cleanup on failure
        try {
            // Stop and remove containers
            await executeCommand('docker', ['stop', containerName]).catch(() => {});
            await executeCommand('docker', ['rm', containerName]).catch(() => {});
            
            // Remove network
            const networkName = `${deploymentId}_default`;
            await executeCommand('docker', ['network', 'rm', networkName]).catch(() => {});
            
            // Remove deployment directory
            await fs.rm(deployDir, { recursive: true, force: true });
        } catch (cleanupError) {
            logger.error('Cleanup failed:', cleanupError);
        }
    } finally {
        // Always return to original directory
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

async function checkDeploymentHealth(port, containerName) {
    try {
        // Wait for container to start
        await new Promise(resolve => setTimeout(resolve, 10000));

        // Check container status
        const { stdout: status } = await executeCommand('docker', [
            'inspect',
            '--format',
            '{{.State.Status}}',
            containerName
        ], { silent: true });

        if (!status || !status.includes('running')) {
            // Get container logs for debugging
            const { stdout: logs } = await executeCommand('docker', ['logs', containerName], { 
                silent: true,
                ignoreError: true 
            });
            
            logger.error('Container logs:', logs);
            throw new Error('Container is not running');
        }

        // Check port availability
        logger.info(`Checking port ${port} availability...`);
        const portCheck = await new Promise((resolve) => {
            const net = require('net');
            const socket = net.createConnection(port);
            
            const timeout = setTimeout(() => {
                socket.destroy();
                resolve(false);
            }, 5000);
            
            socket.on('connect', () => {
                clearTimeout(timeout);
                socket.end();
                resolve(true);
            });
            
            socket.on('error', () => {
                clearTimeout(timeout);
                resolve(false);
            });
        });

        if (!portCheck) {
            throw new Error(`Port ${port} is not accessible`);
        }

        // Check container logs for errors
        const { stdout: containerLogs } = await executeCommand('docker', ['logs', '--tail', '50', containerName], {
            silent: true,
            ignoreError: true
        });

        if (containerLogs && containerLogs.toLowerCase().includes('error')) {
            logger.warn('Found potential errors in container logs:', containerLogs);
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

module.exports = deployApp;