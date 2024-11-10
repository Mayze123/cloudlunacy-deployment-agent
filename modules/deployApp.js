// src/modules/deployApp.js
const { executeCommand } = require('../utils/executor');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');
const TemplateHandler = require('../utils/templateHandler');
const EnvironmentManager = require('../utils/environmentManager');
const apiClient = require('../utils/apiClient');
const deployConfig = require('../deployConfig.json');
const { ensureDeploymentPermissions } = require('../utils/permissionCheck');

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

    logger.info(`Starting blue-green deployment ${deploymentId} for ${appName}`);
    
    const deployDir = path.join('/opt/cloudlunacy/deployments', deploymentId);
    const currentDir = process.cwd();
    const blueContainer = `${appName}-blue`;
    const greenContainer = `${appName}-green`;
    
    try {
        // Check permissions and tools
        const permissionsOk = await ensureDeploymentPermissions();
        if (!permissionsOk) {
            throw new Error('Deployment failed: Permission check failed');
        }

        await executeCommand('which', ['docker']);
        await executeCommand('which', ['docker-compose']);
        
        // Set up deployment directory
        await fs.mkdir(deployDir, { recursive: true });
        process.chdir(deployDir);

        sendStatus(ws, {
            deploymentId,
            status: 'in_progress',
            message: 'Starting deployment...'
        });

        // Determine active container
        const activeContainer = await determineActiveContainer(blueContainer, greenContainer);
        const newContainer = activeContainer === blueContainer ? greenContainer : blueContainer;
        const newPort = parseInt(port) + (activeContainer === blueContainer ? 1 : 0);
        
        sendLogs(ws, deploymentId, `Current active container: ${activeContainer || 'none'}`);
        sendLogs(ws, deploymentId, `Preparing new container: ${newContainer} on port ${newPort}`);

        // Retrieve and set up environment variables
        sendLogs(ws, deploymentId, 'Retrieving environment variables...');
        let envVars = {};
        try {
            const { data } = await apiClient.post(`/api/deploy/env-vars/${deploymentId}`, {
                token: envVarsToken
            });
            envVars = data.variables;
            
            // Initialize environment manager and write env file
            const envManager = new EnvironmentManager(deployDir);
            const envFilePath = await envManager.writeEnvFile(envVars, environment);
            
            sendLogs(ws, deploymentId, 'Environment variables configured successfully');
        } catch (error) {
            throw new Error(`Environment variables setup failed: ${error.message}`);
        }

        // Clone repository
        sendLogs(ws, deploymentId, 'Cloning repository...');
        const repoUrl = `https://x-access-token:${githubToken}@github.com/${repositoryOwner}/${repositoryName}.git`;
        await executeCommand('git', ['clone', '-b', branch, repoUrl, '.']);

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
            port: newPort,
            containerName: newContainer,
            envFile: `.env.${environment}`, // Reference the env file
            buildConfig: {
                nodeVersion: '18',
                buildOutputDir: 'build',
                cacheControl: 'public, max-age=31536000'
            },
            domain: `${appName}-${environment}.yourdomain.com`
        });

        // Write deployment files
        await Promise.all([
            fs.writeFile('Dockerfile', files.dockerfile),
            fs.writeFile('docker-compose.yml', files.dockerCompose),
            files.nginxConf ? fs.writeFile('nginx.conf', files.nginxConf) : Promise.resolve()
        ]);

        // Update docker-compose with env file reference
        const envManager = new EnvironmentManager(deployDir);
        await envManager.updateDockerCompose(`.env.${environment}`, newContainer);

        // Validate configuration
        try {
            await executeCommand('docker-compose', ['config']);
            sendLogs(ws, deploymentId, 'Deployment configuration validated');
        } catch (error) {
            throw new Error(`Invalid docker-compose configuration: ${error.message}`);
        }

        // Build and start new container
        sendLogs(ws, deploymentId, 'Building application...');
        await executeCommand('docker-compose', ['build', '--no-cache']);
        await executeCommand('docker-compose', ['up', '-d', '--force-recreate']);
        sendLogs(ws, deploymentId, 'Application built and started');

        // Verify deployment health
        sendLogs(ws, deploymentId, 'Verifying deployment health...');
        const health = await checkDeploymentHealth(newPort, newContainer);
        
        if (!health.healthy) {
            throw new Error(`Deployment health check failed: ${health.message}`);
        }

        // Update proxy configuration
        sendLogs(ws, deploymentId, 'Updating reverse proxy configuration...');
        await updateReverseProxy(appName, environment, newPort);

        // Wait for proxy configuration
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Check proxy health
        const proxyHealth = await checkProxyHealth(appName, environment);
        if (!proxyHealth.healthy) {
            throw new Error('Failed to verify application access through proxy');
        }

        // Remove old container if successful
        if (activeContainer) {
            sendLogs(ws, deploymentId, `Removing old container: ${activeContainer}`);
            await executeCommand('docker', ['stop', activeContainer]).catch(() => {});
            await executeCommand('docker', ['rm', activeContainer]).catch(() => {});
        }

        sendStatus(ws, {
            deploymentId,
            status: 'success',
            message: 'Deployment completed successfully'
        });

    } catch (error) {
        logger.error(`Deployment ${deploymentId} failed:`, error);
        
        sendStatus(ws, {
            deploymentId,
            status: 'failed',
            message: error.message || 'Deployment failed'
        });

        // Cleanup on failure
        try {
            const failedContainer = activeContainer === blueContainer ? greenContainer : blueContainer;
            await executeCommand('docker', ['stop', failedContainer]).catch(() => {});
            await executeCommand('docker', ['rm', failedContainer]).catch(() => {});
            await fs.rm(deployDir, { recursive: true, force: true });
        } catch (cleanupError) {
            logger.error('Cleanup failed:', cleanupError);
        }
    } finally {
        process.chdir(currentDir);
    }
}

async function determineActiveContainer(blueContainer, greenContainer) {
    try {
        const blueRunning = await isContainerRunning(blueContainer);
        const greenRunning = await isContainerRunning(greenContainer);

        if (blueRunning) return blueContainer;
        if (greenRunning) return greenContainer;
        return null;
    } catch (error) {
        logger.error('Error determining active container:', error);
        return null;
    }
}

async function isContainerRunning(containerName) {
    try {
        const { stdout } = await executeCommand('docker', [
            'inspect',
            '--format',
            '{{.State.Status}}',
            containerName
        ], { silent: true });
        return stdout.trim() === 'running';
    } catch (error) {
        return false;
    }
}

async function updateReverseProxy(appName, environment, port) {
    const nginxConfig = `
    upstream ${appName}_${environment} {
        server localhost:${port};
    }
    
    server {
        listen 80;
        server_name ${appName}-${environment}.yourdomain.com;
        
        location / {
            proxy_pass http://${appName}_${environment};
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            
            # WebSocket support
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
        }
    }`;

    const configPath = `/etc/nginx/conf.d/${appName}-${environment}.conf`;
    
    await fs.writeFile(configPath, nginxConfig);
    await executeCommand('nginx', ['-t']); // Test configuration
    await executeCommand('nginx', ['-s', 'reload']); // Reload nginx
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
            const { stdout: logs } = await executeCommand('docker', ['logs', containerName], { 
                silent: true,
                ignoreError: true 
            });
            
            logger.error('Container logs:', logs);
            throw new Error('Container is not running');
        }

        // Check port availability
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

        return { healthy: true };
    } catch (error) {
        return { 
            healthy: false, 
            message: error.message
        };
    }
}

async function checkProxyHealth(appName, environment) {
    try {
        const domain = `${appName}-${environment}.yourdomain.com`;
        const response = await fetch(`http://${domain}/health`);
        return {
            healthy: response.ok,
            message: response.ok ? 'Proxy health check passed' : 'Failed to access application through proxy'
        };
    } catch (error) {
        return {
            healthy: false,
            message: `Proxy health check failed: ${error.message}`
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

module.exports = deployApp;