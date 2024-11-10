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
          return `${key}=${value}`;
        })
        .join('\n');

      const envFilePath = path.join(this.deployDir, `.env.${environment}`);
      await fs.writeFile(envFilePath, envContent, 'utf-8');
      
      // Secure the env file
      await executeCommand('chmod', ['600', envFilePath]);
      
      logger.info(`Environment file written successfully for ${environment}`);
      return envFilePath;
    } catch (error) {
      logger.error('Error writing environment file:', error);
      throw new Error(`Failed to write environment file: ${error.message}`);
    }
  }

  async updateDockerCompose(envFilePath, containerName) {
    try {
      const composeFilePath = path.join(this.deployDir, 'docker-compose.yml');
      const composeContent = await fs.readFile(composeFilePath, 'utf-8');
      
      // Parse YAML
      const compose = yaml.load(composeContent);

      // Find the service
      const serviceName = Object.keys(compose.services)[0];
      
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

      logger.info('Docker Compose file updated with environment configuration');
    } catch (error) {
      logger.error('Error updating Docker Compose file:', error);
      throw new Error(`Failed to update Docker Compose file: ${error.message}`);
    }
  }
}

module.exports = EnvironmentManager;