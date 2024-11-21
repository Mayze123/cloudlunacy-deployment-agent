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
        // Increase initial wait time to 30 seconds
        await new Promise(resolve => setTimeout(resolve, 30000));

        // Check container status
        const { stdout: status } = await executeCommand('docker', [
            'inspect',
            '--format',
            '{{.State.Status}}',
            serviceName
        ], { silent: true });

        if (!status || !status.includes('running')) {
            throw new Error('Container is not running');
        }

        // If domain is provided, perform progressive health checks
        if (domain) {
            logger.info(`Verifying domain configuration for ${domain}`);
            
            // Check internal container health first
            const containerHealth = await executeCommand('docker', [
                'inspect',
                '--format',
                '{{.State.Health.Status}}',
                serviceName
            ], { silent: true });
            
            if (containerHealth.stdout && !containerHealth.stdout.includes('healthy')) {
                throw new Error(`Container health check failed: ${containerHealth.stdout}`);
            }

            // Check Traefik router configuration
            const traefikCheck = await executeCommand('docker', [
                'exec',
                'traefik',
                'traefik',
                'healthcheck'
            ], { silent: true });

            if (!traefikCheck.stdout.includes('ok')) {
                throw new Error('Traefik router configuration check failed');
            }

            // Progressive domain checks with retries
            const maxRetries = 5;
            for (let i = 0; i < maxRetries; i++) {
                try {
                    // Try both container port and domain
                    const containerCheck = await executeCommand(
                        'curl',
                        ['--max-time', '5', '-I', `http://localhost:${process.env.PORT || 8080}`],
                        { silent: true }
                    );

                    const domainCheck = await executeCommand(
                        'curl',
                        ['--max-time', '5', '-I', `http://${domain}`, '-H', `Host: ${domain}`],
                        { silent: true }
                    );

                    if (containerCheck.stdout.includes('200 OK') && domainCheck.stdout.includes('200 OK')) {
                        logger.info('Health checks passed successfully');
                        return { healthy: true };
                    }
                } catch (error) {
                    logger.warn(`Health check attempt ${i + 1}/${maxRetries} failed:`, error.message);
                }
                
                // Wait before next retry
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
            
            throw new Error(`Domain ${domain} is not accessible after ${maxRetries} attempts`);
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