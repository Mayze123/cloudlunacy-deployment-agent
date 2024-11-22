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
    Handlebars.registerHelper('json', function(context) {
      return JSON.stringify(context, null, 2);
    });

    Handlebars.registerHelper('envVar', function(name, value) {
      if (typeof value === 'object') {
        value = JSON.stringify(value);
      }
      if (typeof value === 'string') {
        value = value.replace(/"/g, '\\"');
      }
      return `${name}=${value}`;
    });

    Handlebars.registerHelper('concat', function(...args) {
      args.pop();
      return args.join('');
    });

    Handlebars.registerHelper('ifEquals', function(arg1, arg2, options) {
      return arg1 === arg2 ? options.fn(this) : options.inverse(this);
    });
  }

  mergeDefaults(appType, config) {
    const defaults = this.deployConfig[appType]?.defaults || {};
    return { ...defaults, ...config };
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

  async generateDeploymentFiles(appConfig) {
    logger.info('Starting file generation with config:', JSON.stringify(appConfig, null, 2));

    const {
      appType,
      appName,
      environment,
      containerPort,
      hostPort,
      envFile,
      buildConfig = {},
      domain
    } = appConfig;

    const config = this.mergeDefaults(appType, buildConfig);
    logger.info('Merged config:', JSON.stringify(config, null, 2));

    const files = {};

    const templateContext = {
      appName,
      sanitizedAppName: appName,
      environment,
      containerPort,
      hostPort,
      envFile,
      domain,
      ...config
    };

    const dockerComposeTemplateName = this.deployConfig[appType].dockerComposeTemplate;
    const dockerfileTemplateName = this.deployConfig[appType].dockerfileTemplate;

    const dockerComposeTemplate = await this.loadTemplate(dockerComposeTemplateName);
    const dockerfileTemplate = await this.loadTemplate(dockerfileTemplateName);

    files.dockerCompose = dockerComposeTemplate(templateContext);
    files.dockerfile = dockerfileTemplate(templateContext);

    logger.info('Generated docker-compose content:', files.dockerCompose);
    logger.info('Generated Dockerfile content:', files.dockerfile);

    return files;
  }
}

module.exports = TemplateHandler;