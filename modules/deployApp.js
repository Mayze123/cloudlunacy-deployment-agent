// src/modules/deployApp.js

const { executeCommand } = require('../utils/executor');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');
const TemplateHandler = require('../utils/templateHandler');
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
        envVars = {}
    } = payload;

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
        const deployDir = path.join('/opt/cloudlunacy/deployments', deploymentId);
        await fs.mkdir(deployDir, { recursive: true });
        process.chdir(deployDir);

        // Send initial status and logs
        sendStatus(ws, {
            deploymentId,
            status: 'in_progress',
            message: 'Starting deployment...'
        });
        sendLogs(ws, deploymentId, 'Setting up deployment environment...');

        // Clone repository
        const repoUrl = `https://x-access-token:${githubToken}@github.com/${repositoryOwner}/${repositoryName}.git`;
        await executeCommand('git', ['clone', '-b', branch, repoUrl, '.']);
        sendLogs(ws, deploymentId, 'Repository cloned successfully');

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
            envVars,
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

        // Validate docker-compose file
        try {
            await executeCommand('docker-compose', ['config']);
            sendLogs(ws, deploymentId, 'Deployment configuration validated');
        } catch (error) {
            throw new Error(`Invalid docker-compose configuration: ${error.message}`);
        }

        // Clean up existing containers
        try {
            await executeCommand('docker-compose', ['down', '--remove-orphans']);
            sendLogs(ws, deploymentId, 'Cleaned up existing containers');
        } catch (error) {
            sendLogs(ws, deploymentId, 'No existing containers to clean up');
        }

        // Build and start containers
        sendLogs(ws, deploymentId, 'Building application...');
        await executeCommand('docker-compose', ['build', '--no-cache']);
        sendLogs(ws, deploymentId, 'Application built successfully');

        sendLogs(ws, deploymentId, 'Starting application...');
        await executeCommand('docker-compose', ['up', '-d']);
        sendLogs(ws, deploymentId, 'Application started successfully');

        // Verify deployment
        sendLogs(ws, deploymentId, 'Verifying deployment...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        const health = await checkDeploymentHealth(port);
        
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
            await executeCommand('docker-compose', ['down', '--remove-orphans']);
            await fs.rmdir(deployDir, { recursive: true });
        } catch (cleanupError) {
            logger.error('Cleanup failed:', cleanupError);
        }
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

async function checkDeploymentHealth(port) {
    try {
        const { execSync } = require('child_process');
        // Wait for the port to be available
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Check if port is listening
        execSync(`nc -z localhost ${port}`);
        
        return { healthy: true };
    } catch (error) {
        return { 
            healthy: false, 
            message: `Service not responding on port ${port}`
        };
    }
}

module.exports = deployApp;