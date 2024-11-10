const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const { executeCommand } = require('./executor');
const logger = require('./logger');

class EnvironmentManager {
    constructor(deployDir) {
      this.deployDir = deployDir;
    }
  
    async writeEnvFile(variables, environment) {
      try {
        const envContent = Object.entries(variables)
          .map(([key, value]) => {
            // Handle different types of values
            if (typeof value === 'object') {
              value = JSON.stringify(value);
            }
            
            // Properly handle multi-line values (like private keys)
            if (typeof value === 'string' && value.includes('\n')) {
              // Escape newlines and wrap in quotes
              value = `"${value.replace(/\n/g, '\\n')}"`;
            } else if (typeof value === 'string' && (value.includes(' ') || value.includes('"'))) {
              // Wrap values with spaces or quotes in quotes
              value = `"${value.replace(/"/g, '\\"')}"`;
            }
            
            return `${key}=${value}`;
          })
          .join('\n');
  
        const envFilePath = path.join(this.deployDir, `.env.${environment}`);
        await fs.writeFile(envFilePath, envContent, 'utf-8');
        
        // Secure the env file
        await executeCommand('chmod', ['600', envFilePath]);
        
        // Verify the file was written correctly
        const writtenContent = await fs.readFile(envFilePath, 'utf-8');
        logger.info(`Environment file written successfully for ${environment}`);
        logger.debug('Environment file contents:', writtenContent.split('\n').map(line => {
          const [key] = line.split('=');
          return `${key}=<value hidden>`;
        }).join('\n'));
        
        return envFilePath;
      } catch (error) {
        logger.error('Error writing environment file:', error);
        throw new Error(`Failed to write environment file: ${error.message}`);
      }
    }
  
    async updateDockerCompose(envFilePath, serviceName) {
      try {
        const composeFilePath = path.join(this.deployDir, 'docker-compose.yml');
        const composeContent = await fs.readFile(composeFilePath, 'utf-8');
        
        const compose = yaml.load(composeContent);
        
        // Update environment configuration
        compose.services[serviceName] = {
          ...compose.services[serviceName],
          env_file: [path.basename(envFilePath)]
        };
  
        // Write updated compose file
        await fs.writeFile(
          composeFilePath,
          yaml.dump(compose),
          'utf-8'
        );
  
        // Verify the update
        const updatedContent = await fs.readFile(composeFilePath, 'utf-8');
        logger.info('Docker Compose file updated with environment configuration');
        logger.debug('Updated docker-compose.yml:', updatedContent);
        
        return true;
      } catch (error) {
        logger.error('Error updating Docker Compose file:', error);
        throw new Error(`Failed to update Docker Compose file: ${error.message}`);
      }
    }
  
    async verifyEnvironmentSetup(serviceName) {
      try {
        const { stdout } = await executeCommand('docker', [
          'exec',
          serviceName,
          'printenv'
        ]);
        
        logger.info('Environment variables loaded in container:', 
          stdout.split('\n')
            .filter(line => line.startsWith('FIREBASE_'))
            .map(line => {
              const [key] = line.split('=');
              return `${key}=<value hidden>`;
            })
            .join('\n')
        );
        
        return true;
      } catch (error) {
        logger.error('Error verifying environment setup:', error);
        return false;
      }
    }
  }
  
  module.exports = EnvironmentManager;

module.exports = EnvironmentManager;