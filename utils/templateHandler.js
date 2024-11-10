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

    // Basic validation of generated files
    if (!files.dockerfile || !files.dockerCompose) {
      throw new Error('Missing required deployment files');
    }

    logger.info('Generated docker-compose.yml content:', '\n' + files.dockerCompose);

    // Create a temporary directory for validation
    const tempDir = `/tmp/deploy-validate-${Date.now()}`;
    try {
      // Create temp directory
      await fs.mkdir(tempDir, { recursive: true });
      
      // Write files
      const composePath = path.join(tempDir, 'docker-compose.yml');
      const dockerfilePath = path.join(tempDir, 'Dockerfile');
      
      await fs.writeFile(composePath, files.dockerCompose);
      await fs.writeFile(dockerfilePath, files.dockerfile);
      
      logger.info(`Validating docker-compose.yml at ${composePath}`);
      
      // Validate using docker-compose config
      const { stdout, stderr } = await execAsync(`cd ${tempDir} && docker-compose config`, {
        encoding: 'utf8'
      });
      
      logger.info('Docker compose validation stdout:', stdout);
      if (stderr) {
        logger.warn('Docker compose validation stderr:', stderr);
      }

      // Parse the output to ensure it's valid YAML
      const yaml = require('js-yaml');
      const parsedConfig = yaml.load(stdout);
      logger.info('Parsed docker-compose configuration:', JSON.stringify(parsedConfig, null, 2));

    } catch (error) {
      logger.error('Validation error:', error);
      throw new Error(`Invalid docker-compose configuration: ${error.message}`);
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

    logger.info('Generating deployment files for config:', {
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
        port,
        environment
      };
      
      logger.info('Generating Dockerfile with context:', dockerfileContext);
      files.dockerfile = dockerfileTemplate(dockerfileContext);
      
      // Format environment variables for docker-compose
      const formattedEnvVars = Object.entries(envVars).reduce((acc, [key, value]) => {
        let formattedValue = typeof value === 'string' ? value : JSON.stringify(value);
        formattedValue = formattedValue.replace(/"/g, '\\"');
        acc[key] = formattedValue;
        return acc;
      }, {});

      // Generate docker-compose.yml
      const dockerComposeTemplate = await this.loadTemplate(typeConfig.dockerComposeTemplate);
      const dockerComposeContext = {
        appName: appName.toLowerCase().replace(/[^a-z0-9]/g, '-'),
        environment,
        port,
        envVars: formattedEnvVars,
        volumes: config.volumes || [],
        dependencies: config.dependencies || [],
        healthCheckEndpoint: config.healthCheckEndpoint || '/health'
      };
      
      logger.info('Generating docker-compose.yml with context:', dockerComposeContext);
      files.dockerCompose = dockerComposeTemplate(dockerComposeContext);

      // Log generated files
      logger.info('Generated Dockerfile:', '\n' + files.dockerfile);
      logger.info('Generated docker-compose.yml:', '\n' + files.dockerCompose);

      // Validate the generated files
      await this.validateGeneratedFiles(files);

      return files;
    } catch (error) {
      logger.error('Error generating deployment files:', error);
      logger.error(error.stack);
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