
// src/utils/environmentManager.js
const fs = require('fs').promises;
const path = require('path');
const { executeCommand } = require('./executor');
const logger = require('./logger');

class EnvironmentManager {
  constructor(deployDir) {
    this.deployDir = deployDir;
  }

  async writeEnvFile(variables, environment) {
    try {
      const envContent = Object.entries(variables)
        .map(([key, value]) => `${key}=${value}`)
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

  async loadEnvFile(environment) {
    try {
      const envFilePath = path.join(this.deployDir, `.env.${environment}`);
      const content = await fs.readFile(envFilePath, 'utf-8');
      
      const variables = {};
      content.split('\n').forEach(line => {
        if (line && !line.startsWith('#')) {
          const [key, ...valueParts] = line.split('=');
          if (key) {
            variables[key.trim()] = valueParts.join('=').trim();
          }
        }
      });
      
      return variables;
    } catch (error) {
      logger.error('Error loading environment file:', error);
      throw new Error(`Failed to load environment file: ${error.message}`);
    }
  }

  async updateDockerCompose(envFilePath, containerName) {
    try {
      const composeFilePath = path.join(this.deployDir, 'docker-compose.yml');
      const composeContent = await fs.readFile(composeFilePath, 'utf-8');
      
      // Parse YAML
      const yaml = require('js-yaml');
      const compose = yaml.load(composeContent);

      // Update environment configuration
      compose.services[containerName] = {
        ...compose.services[containerName],
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