// src/modules/deployApp.js

const { executeCommand } = require('../utils/executor');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');
const TemplateHandler = require('../utils/templateHandler');
const deployConfig = require('../deployConfig.json');

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
        // Set up deployment directory
        const deployDir = path.join('/opt/cloudlunacy/deployments', deploymentId);
        await fs.mkdir(deployDir, { recursive: true });
        process.chdir(deployDir);

        // Send initial status
        sendStatus(ws, {
            deploymentId,
            status: 'in_progress',
            message: 'Starting deployment...'
        });

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
            domain: `${appName}-${environment}.yourdomain.com`,
            api: environment === 'production'
                ? { url: 'https://api.yourdomain.com' }
                : { url: 'https://staging-api.yourdomain.com' }
        });

        // Write deployment files
        await fs.writeFile('Dockerfile', files.dockerfile);
        await fs.writeFile('docker-compose.yml', files.dockerCompose);
        if (files.nginxConf) {
            await fs.writeFile('nginx.conf', files.nginxConf);
        }
        sendLogs(ws, deploymentId, 'Deployment files generated');

        // Stop existing containers if any
        try {
            await executeCommand('docker-compose', ['down', '--remove-orphans']);
            sendLogs(ws, deploymentId, 'Cleaned up existing containers');
        } catch (error) {
            logger.warn('No existing containers to clean up');
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
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for container to start
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

        logger.info(`Deployment ${deploymentId} completed successfully`);

    } catch (error) {
        logger.error(`Deployment ${deploymentId} failed:`, error);
        
        // Send failure status
        sendStatus(ws, {
            deploymentId,
            status: 'failed',
            message: error.message
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