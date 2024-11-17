const Handlebars = require('handlebars');
const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

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

  async generateDeploymentFiles(appConfig) {
    logger.info('Starting file generation with config:', JSON.stringify(appConfig, null, 2));

    const {
      appType,
      appName,
      environment,
      port,
      envFile,
      buildConfig = {},
      domain
    } = appConfig;

    const config = this.mergeDefaults(appType, buildConfig);
    logger.info('Merged config:', JSON.stringify(config, null, 2));

    const files = {};
    // Normalize service name to be consistent across all uses
    const serviceName = `${appName}-${environment}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Generate docker-compose.yml with Traefik labels
    const dockerComposeContent = `version: "3.8"
services:
  ${serviceName}:
    container_name: ${serviceName}
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - NODE_ENV=${environment}
    env_file:
      - ${envFile}
    restart: unless-stopped
    networks:
      - traefik-network
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.${serviceName}.rule=Host(\`${domain}\`)"
      - "traefik.http.services.${serviceName}.loadbalancer.server.port=${port}"

networks:
  traefik-network:
    external: true`;

    // Generate Dockerfile
    const dockerfileContent = `FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
COPY ${envFile} .env
ENV NODE_ENV=${environment}
EXPOSE ${port}
CMD ["npm", "start"]`;

    files.dockerCompose = dockerComposeContent;
    files.dockerfile = dockerfileContent;

    logger.info('Generated docker-compose content:', dockerComposeContent);
    logger.info('Generated dockerfile content:', dockerfileContent);

    return files;
  }

  mergeDefaults(appType, config) {
    const defaults = this.deployConfig[appType].defaults || {};
    return { ...defaults, ...config };
  }
}

module.exports = TemplateHandler;