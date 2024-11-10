const Handlebars = require('handlebars');
const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

class TemplateHandler {
  constructor(templatesDir, deployConfig) {
    this.templatesDir = templatesDir;
    this.deployConfig = this.processConfigInheritance(deployConfig);
    this.templates = {};
    this.registerHelpers();
  }

  processConfigInheritance(config) {
    const processedConfig = { ...config };
    
    for (const [type, typeConfig] of Object.entries(config)) {
      if (typeConfig.extends && config[typeConfig.extends]) {
        const parentConfig = config[typeConfig.extends];
        processedConfig[type] = {
          ...parentConfig,
          ...typeConfig,
          defaults: {
            ...parentConfig.defaults,
            ...typeConfig.defaults
          }
        };
      }
    }
    
    return processedConfig;
  }

  registerHelpers() {
    // Helper for JSON stringification
    Handlebars.registerHelper('json', function(context) {
      return JSON.stringify(context, null, 2);
    });

    // Helper for environment variables formatting
    Handlebars.registerHelper('envVar', function(name, value) {
      if (typeof value === 'object') {
        value = JSON.stringify(value);
      }
      // Escape quotes in value if it's a string
      if (typeof value === 'string') {
        value = value.replace(/"/g, '\\"');
      }
      return `${name}=${value}`;
    });

    // Helper for string concatenation
    Handlebars.registerHelper('concat', function(...args) {
      args.pop(); // Remove last argument (Handlebars options)
      return args.join('');
    });

    // Helper for conditional expressions
    Handlebars.registerHelper('ifEquals', function(arg1, arg2, options) {
      return (arg1 === arg2) ? options.fn(this) : options.inverse(this);
    });
  }

  async loadTemplate(templateName) {
    try {
      if (!this.templates[templateName]) {
        const templatePath = path.join(this.templatesDir, templateName);
        const templateContent = await fs.readFile(templatePath, 'utf-8');
        this.templates[templateName] = Handlebars.compile(templateContent);
        logger.info(`Template ${templateName} loaded successfully`);
      }
      return this.templates[templateName];
    } catch (error) {
      logger.error(`Error loading template ${templateName}:`, error);
      throw new Error(`Failed to load template ${templateName}: ${error.message}`);
    }
  }

  mergeDefaults(appType, config) {
    const defaults = this.deployConfig[appType].defaults || {};
    return { ...defaults, ...config };
  }

  async validateGeneratedFiles(files) {
    logger.info('Validating generated files...');
    
    // Log the exact content that will be written
    logger.info('Docker Compose Content (exact):', JSON.stringify(files.dockerCompose));
    logger.info('Dockerfile Content (exact):', JSON.stringify(files.dockerfile));

    // Basic validation of generated files
    if (!files.dockerfile || !files.dockerCompose) {
      throw new Error('Missing required deployment files');
    }

    // Create a temporary directory for validation
    const tempDir = `/tmp/deploy-validate-${Date.now()}`;
    try {
      // Create temp directory
      await fs.mkdir(tempDir, { recursive: true });
      
      // Write files with explicit encoding
      const composePath = path.join(tempDir, 'docker-compose.yml');
      await fs.writeFile(composePath, files.dockerCompose, 'utf8');
      
      // Log the actual file content after writing
      const writtenContent = await fs.readFile(composePath, 'utf8');
      logger.info('Written docker-compose.yml content:', writtenContent);
      
      // Validate using docker-compose config
      const { stdout, stderr } = await execAsync(`cd ${tempDir} && cat docker-compose.yml && docker-compose config`, {
        encoding: 'utf8'
      });
      
      if (stdout) logger.info('Docker compose validation stdout:', stdout);
      if (stderr) logger.warn('Docker compose validation stderr:', stderr);

    } catch (error) {
      logger.error('Validation error details:', {
        message: error.message,
        stdout: error.stdout,
        stderr: error.stderr
      });
      throw error;
    } finally {
      // Cleanup
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        logger.warn('Error cleaning up temp directory:', cleanupError);
      }
    }
  }

  async generateDeploymentFiles(appConfig) {
    logger.info('Starting file generation with config:', JSON.stringify(appConfig, null, 2));

    const {
      appType,
      appName,
      environment,
      port,
      envFile,
      buildConfig = {},
    } = appConfig;

    const config = this.mergeDefaults(appType, buildConfig);
    logger.info('Merged config:', JSON.stringify(config, null, 2));

    const files = {};
    // Normalize service name to be consistent across all uses
    const serviceName = `${appName}-${environment}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Generate docker-compose.yml with consistent service naming
    const dockerComposeContent = `version: "3.8"
services:
  ${serviceName}:
    container_name: ${serviceName}
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "${port}:${port}"
    environment:
      - NODE_ENV=${environment}
    env_file:
      - ${envFile || `.env.${environment}`}
    restart: unless-stopped
    networks:
      - app-network

networks:
  app-network:
    driver: bridge`;

    files.dockerCompose = dockerComposeContent;
    logger.info('Generated docker-compose content:', dockerComposeContent);

    // Generate Dockerfile with consistent configuration
    const dockerfileContent = `FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
ENV NODE_ENV=${environment}
EXPOSE ${port}
CMD ["npm", "start"]`;

    files.dockerfile = dockerfileContent;
    logger.info('Generated dockerfile content:', dockerfileContent);

    // Validate the generated files
    try {
      await this.validateGeneratedFiles(files);
      return files;
    } catch (error) {
      logger.error('Validation failed:', error);
      throw new Error(`Failed to generate deployment files: ${error.message}`);
    }
  }

  async validateConfig(appConfig) {
    const required = ['appType', 'appName', 'environment', 'port'];
    const missing = required.filter(field => !appConfig[field]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required fields: ${missing.join(', ')}`);
    }

    if (!this.deployConfig[appConfig.appType]) {
      throw new Error(`Unsupported application type: ${appConfig.appType}`);
    }

    const typeConfig = this.deployConfig[appConfig.appType];
    const requiredTemplates = [
      typeConfig.dockerfileTemplate,
      typeConfig.dockerComposeTemplate,
      appConfig.appType === 'react' ? typeConfig.nginxTemplate : null
    ].filter(Boolean);

    for (const template of requiredTemplates) {
      try {
        await fs.access(path.join(this.templatesDir, template));
      } catch (error) {
        throw new Error(`Template ${template} not found`);
      }
    }

    return true;
  }
}

module.exports = TemplateHandler;