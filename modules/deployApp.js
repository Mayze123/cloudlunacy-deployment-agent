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

      // Send initial status and logs
      sendStatus(ws, {
          deploymentId,
          status: 'in_progress',
          message: 'Starting deployment...'
      });

      // Initialize port manager and allocate ports
      await portManager.initialize();
      const { hostPort, containerPort } = await portManager.allocatePort(serviceName);

      // Cleanup existing containers and networks
      if (fs.existsSync('docker-compose.yml')) {
        try {
          sendLogs(ws, deploymentId, `Cleaning up existing container: ${serviceName}`);
          await executeCommand('docker-compose', ['down']);
          sendLogs(ws, deploymentId, 'Previous deployment cleaned up');
        } catch (error) {
          logger.warn('Cleanup warning:', error);
        }
      } else {
        logger.info('No existing docker-compose.yml found; skipping cleanup.');
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
      await fs.promises.copyFile(envFilePath, path.join(deployDir, '.env'));
      
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
          fs.promises.writeFile('docker-compose.yml', files.dockerCompose),
      ]);

      sendLogs(ws, deploymentId, 'Deployment configuration generated successfully');

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
      await executeCommand('docker-compose', ['up', '-d', '--build']);
      sendLogs(ws, deploymentId, 'Application built and started successfully');

      // Verify deployment
      sendLogs(ws, deploymentId, 'Verifying deployment...');
      const health = await checkDeploymentHealth(serviceName, domain);
      
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
          await executeCommand('docker-compose', ['down']).catch(() => {});
          await fs.promises.rm(deployDir, { recursive: true, force: true });
          // Release allocated port
          await portManager.releasePort(serviceName);
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

        // Check container status with detailed output
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
            
            // Check if Traefik is running first
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

            // Check internal container health
            try {
                const { stdout: networkList } = await executeCommand('docker', [
                    'network',
                    'inspect',
                    'traefik-network'
                ], { silent: true });
                
                logger.info('Network configuration:', networkList);
            } catch (networkError) {
                logger.warn('Failed to inspect network:', networkError);
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
                        '-v',  // verbose output
                        '--max-time',
                        '5',
                        'http://localhost:8080/health'
                    ], { silent: true });
                    
                    logger.info(`Container health check response: ${containerHealth}`);
                    if (containerHealthErr) {
                        logger.warn('Container health check stderr:', containerHealthErr);
                    }

                    // Check domain through Traefik
                    const { stdout: domainHealth, stderr: domainHealthErr } = await executeCommand('curl', [
                        '-v',  // verbose output
                        '--max-time',
                        '5',
                        '-H',
                        `Host: ${domain}`,
                        'http://localhost:80'
                    ], { silent: true });
                    
                    logger.info(`Domain health check response: ${domainHealth}`);
                    if (domainHealthErr) {
                        logger.warn('Domain health check stderr:', domainHealthErr);
                    }

                    // If we get here without throwing, both checks passed
                    logger.info('All health checks passed successfully');
                    return { healthy: true };
                    
                } catch (checkError) {
                    logger.warn(`Health check attempt ${i + 1} failed:`, checkError.message);
                    
                    // On last retry, collect debugging information
                    if (i === maxRetries - 1) {
                        const debugInfo = await collectDebugInfo(serviceName, domain);
                        throw new Error(`Health checks failed after ${maxRetries} attempts. Debug info: ${JSON.stringify(debugInfo)}`);
                    }
                    
                    // Wait before next retry
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
        portBindings: null
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

    } catch (error) {
        logger.warn('Error collecting debug info:', error);
    }

    return debugInfo;
}



module.exports = deployApp;