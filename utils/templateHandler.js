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

  async generateDeploymentFiles(appConfig) {
    const {
      appType,
      appName,
      environment,
      port,
      envVars = {},
      buildConfig = {},
      domain,
      ssl,
      api
    } = appConfig;

    logger.info('Generating deployment files with config:', {
      appType,
      appName,
      environment,
      port,
      buildConfig
    });

    if (!this.deployConfig[appType]) {
      throw new Error(`Unsupported application type: ${appType}`);
    }

    const config = this.mergeDefaults(appType, buildConfig);
    const typeConfig = this.deployConfig[appType];

    try {
      const files = {};
      
      // Generate Dockerfile
      const dockerfileTemplate = await this.loadTemplate(typeConfig.dockerfileTemplate);
      const dockerfileContext = {
        nodeVersion: config.nodeVersion,
        usePnpm: config.usePnpm,
        useYarn: config.useYarn,
        buildCommand: config.buildCommand,
        startCommand: config.startCommand,
        buildOutputDir: config.buildOutputDir,
        port,
        environment
      };
      
      logger.info('Generating Dockerfile with context:', dockerfileContext);
      files.dockerfile = dockerfileTemplate(dockerfileContext);

      // Generate docker-compose.yml
      const dockerComposeTemplate = await this.loadTemplate(typeConfig.dockerComposeTemplate);
      const dockerComposeContext = {
        appName,
        environment,
        port,
        envVars,
        volumes: config.volumes,
        dependencies: config.dependencies,
        healthCheckEndpoint: config.healthCheckEndpoint
      };
      
      logger.info('Generating docker-compose.yml with context:', dockerComposeContext);
      files.dockerCompose = dockerComposeTemplate(dockerComposeContext);

      // Log the generated files for debugging
      logger.info('Generated Dockerfile:', files.dockerfile);
      logger.info('Generated docker-compose.yml:', files.dockerCompose);

      return files;
    } catch (error) {
      logger.error('Error generating deployment files:', error);
      // Log the full error stack trace
      logger.error(error.stack);
      throw new Error(`Failed to generate deployment files: ${error.message}`);
    }
}

  async validateGeneratedFiles(files) {
    // Basic validation of generated files
    if (!files.dockerfile || !files.dockerCompose) {
      throw new Error('Missing required deployment files');
    }

    // Validate docker-compose.yml syntax
    const { exec } = require('child_process');
    const util = require('util');
    const execAsync = util.promisify(exec);

    try {
      // Write docker-compose.yml to a temporary file
      const tempFile = path.join('/tmp', `docker-compose-${Date.now()}.yml`);
      await fs.writeFile(tempFile, files.dockerCompose);

      // Validate using docker-compose config
      await execAsync(`docker-compose -f ${tempFile} config`);

      // Clean up
      await fs.unlink(tempFile);
    } catch (error) {
      throw new Error(`Invalid docker-compose.yml: ${error.message}`);
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