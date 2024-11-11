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
const nginxManager = require('../utils/nginxManager');

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
        domain,
        envVarsToken
    } = payload;

    // Create consistent container/service name
    const serviceName = `${appName}-${environment}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const deployDir = path.join('/opt/cloudlunacy/deployments', deploymentId);
    const currentDir = process.cwd();
    
    logger.info(`Starting deployment ${deploymentId} for ${appType} app: ${appName}`);
    
    try {

        // Initialize template handler early
        const templateHandler = new TemplateHandler(
            path.join('/opt/cloudlunacy/templates'),
            deployConfig
        );
        
        // Explicitly initialize templates
        await templateHandler.init();

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
            sendLogs(ws, deploymentId, `Cleaning up existing container: ${serviceName}`);
            await executeCommand('docker', ['stop', serviceName]).catch(() => {});
            await executeCommand('docker', ['rm', serviceName]).catch(() => {});
            
            // Remove existing networks
            const networkName = 'app-network';
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

        // Initialize environment manager and write env files
        const envManager = new EnvironmentManager(deployDir);
        envFilePath = await envManager.writeEnvFile(envVars, environment);
        
        // Also create a regular .env file
        await fs.copyFile(envFilePath, path.join(deployDir, '.env'));
        
        sendLogs(ws, deploymentId, 'Environment variables configured successfully');

        // Verify environment files
        const envFiles = await fs.readdir(deployDir);
        sendLogs(ws, deploymentId, `Environment files in directory: ${envFiles.filter(f => f.startsWith('.env')).join(', ')}`);

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
            domain: domain || `${appName}-${environment}.yourdomain.com`
        });

        // Write deployment files
        await Promise.all([
            fs.writeFile('Dockerfile', files.dockerfile),
            fs.writeFile('docker-compose.yml', files.dockerCompose),
            files.nginxConf ? fs.writeFile('nginx.conf', files.nginxConf) : Promise.resolve()
        ]);

        // Create env loading script
        const envLoaderContent = `
        const dotenv = require('dotenv');
        const path = require('path');
        
        // Load environment specific variables
        const envFile = path.join(process.cwd(), '.env.${environment}');
        const result = dotenv.config({ path: envFile });
        
        if (result.error) {
            console.error('Error loading environment variables:', result.error);
            process.exit(1);
        }
        
        console.log('Environment variables loaded successfully');
        `;
        
        await fs.writeFile('load-env.js', envLoaderContent);
        sendLogs(ws, deploymentId, 'Environment loader script created');

        // Validate docker-compose file
        try {
            sendLogs(ws, deploymentId, 'Validating deployment configuration...');
            const { stdout: configOutput } = await executeCommand('docker-compose', ['config']);
            sendLogs(ws, deploymentId, 'Docker Compose configuration:');
            sendLogs(ws, deploymentId, configOutput);
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
        
        // Log container status
        const { stdout: containerLogs } = await executeCommand('docker', ['logs', serviceName]);
        sendLogs(ws, deploymentId, 'Container logs:');
        sendLogs(ws, deploymentId, containerLogs);

        // Configure Nginx if domain is provided
        if (domain) {
            try {
                sendLogs(ws, deploymentId, `Configuring domain: ${domain}`);
                await nginxManager.configureNginx(domain, port, deployDir);
                
                // Execute curl to check domain accessibility
                const maxRetries = 5;
                let retryCount = 0;
                let domainAccessible = false;

                while (retryCount < maxRetries && !domainAccessible) {
                    try {
                        await executeCommand('curl', ['--max-time', '5', '-I', `http://${domain}`]);
                        domainAccessible = true;
                        sendLogs(ws, deploymentId, `Domain ${domain} is accessible`);
                    } catch (error) {
                        retryCount++;
                        if (retryCount < maxRetries) {
                            sendLogs(ws, deploymentId, `Waiting for domain to become accessible (attempt ${retryCount}/${maxRetries})...`);
                            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds between retries
                        }
                    }
                }

                if (!domainAccessible) {
                    logger.warn(`Domain ${domain} is not yet accessible, but deployment will continue`);
                    sendLogs(ws, deploymentId, `Warning: Domain ${domain} is not yet accessible. DNS propagation may take some time.`);
                }
            } catch (error) {
                logger.error(`Failed to configure domain ${domain}:`, error);
                sendLogs(ws, deploymentId, `Warning: Domain configuration encountered an error: ${error.message}`);
                // Continue deployment even if domain configuration fails
            }
        }

        // Verify deployment
        sendLogs(ws, deploymentId, 'Verifying deployment...');
        const health = await checkDeploymentHealth(port, serviceName, domain);
        
        if (!health.healthy) {
            throw new Error(`Deployment health check failed: ${health.message}`);
        }

        // Send success status
        sendStatus(ws, {
            deploymentId,
            status: 'success',
            message: 'Deployment completed successfully',
            domain
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
            // Get container logs before cleanup if possible
            try {
                const { stdout: failureLogs } = await executeCommand('docker', ['logs', serviceName]);
                logger.error('Container logs before cleanup:', failureLogs);
            } catch (logError) {
                logger.warn('Could not retrieve container logs:', logError);
            }

            // Remove Nginx config if it was created
            if (domain) {
                await nginxManager.removeConfig(domain);
                sendLogs(ws, deploymentId, `Removed Nginx configuration for ${domain}`);
            }

            // Stop and remove containers
            await executeCommand('docker', ['stop', serviceName]).catch(() => {});
            await executeCommand('docker', ['rm', serviceName]).catch(() => {});
            
            // Remove network
            const networkName = 'app-network';
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

async function checkDeploymentHealth(port, containerName, domain) {
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

        // Check domain accessibility if provided
        if (domain) {
            logger.info(`Verifying domain configuration for ${domain}`);
            
            // Check nginx configuration
            const nginxCheck = await executeCommand('sudo', ['nginx', '-t'], { silent: true })
                .catch(error => ({ error }));
                
            if (nginxCheck.error) {
                logger.warn('Nginx configuration test failed:', nginxCheck.error);
            }

            // Check if site is at least locally accessible via curl
            const curlCheck = await executeCommand(
                'curl',
                ['--max-time', '5', '-I', `http://localhost:${port}`],
                { silent: true }
            ).catch(error => ({ error }));

            if (curlCheck.error) {
                logger.warn(`Local port ${port} is not accessible:`, curlCheck.error);
            }
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