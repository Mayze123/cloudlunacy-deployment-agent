const Handlebars = require('handlebars');
const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');
const { exec } = require('child_process');
const util = require('util');
const { executeCommand } = require('./executor');
const execAsync = util.promisify(exec);

class TemplateHandler {
  constructor(templatesDir, deployConfig) {
    this.templatesDir = templatesDir;
    this.deployConfig = this.processConfigInheritance(deployConfig);
    this.templates = {};
    this.registerHelpers();
  }

  async init() {
    await this.ensureTemplatesExist();
  }

  async ensureTemplatesExist() {
    logger.info('Ensuring all required templates exist...');
    
    try {
      // Create base templates directory
      await fs.mkdir(this.templatesDir, { recursive: true });
      
      // Create nginx templates directory
      const nginxTemplateDir = path.join(this.templatesDir, 'nginx');
      await fs.mkdir(nginxTemplateDir, { recursive: true });

      const virtualHostTemplate = `server {
    listen 80;
    server_name {{domain}};

    location / {
        proxy_pass http://127.0.0.1:{{port}};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Add timeout configurations
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:{{port}};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket specific timeouts
        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
    }
}`;

      // Write the template file
      const virtualHostPath = path.join(nginxTemplateDir, 'virtual-host.template');
      await fs.writeFile(virtualHostPath, virtualHostTemplate, 'utf8');
      
      logger.info('Templates created successfully');
      return true;
    } catch (error) {
      logger.error('Failed to create templates:', error);
      throw error;
    }
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
      const dockerfilePath = path.join(tempDir, 'Dockerfile');
      
      // Create a dummy .env file for validation
      const envPath = path.join(tempDir, '.env.production');
      
      await Promise.all([
        fs.writeFile(composePath, files.dockerCompose, 'utf8'),
        fs.writeFile(dockerfilePath, files.dockerfile, 'utf8'),
        fs.writeFile(envPath, 'DUMMY_ENV=true\n', 'utf8')
      ]);
      
      // Log the actual file content after writing
      const writtenContent = await fs.readFile(composePath, 'utf8');
      logger.info('Written docker-compose.yml content:', writtenContent);
      
      // Modified docker-compose command to use --env-file
      const { stdout, stderr } = await execAsync(`cd ${tempDir} && docker-compose config`, {
        encoding: 'utf8',
        env: {
          ...process.env,
          COMPOSE_PROJECT_NAME: 'validation'
        }
      });
      
      if (stdout) logger.info('Docker compose validation stdout:', stdout);
      if (stderr) logger.warn('Docker compose validation stderr:', stderr);

      return true;
    } catch (error) {
      logger.error('Validation error details:', error);
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
    // Ensure templates exist before generating files
    await this.ensureTemplatesExist();
    
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
    const serviceName = `${appName}-${environment}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

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
      - .env.${environment}
    restart: unless-stopped
    networks:
      - app-network

networks:
  app-network:
    driver: bridge`;

    const dockerfileContent = `FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
COPY .env.${environment} .env
ENV NODE_ENV=${environment}
EXPOSE ${port}

# Add explicit dotenv loading
RUN echo "require('dotenv').config();" > load-env.js

CMD ["sh", "-c", "node load-env.js && npm start"]`;

    files.dockerCompose = dockerComposeContent;
    files.dockerfile = dockerfileContent;

    logger.info('Generated docker-compose content:', dockerComposeContent);
    logger.info('Generated dockerfile content:', dockerfileContent);

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