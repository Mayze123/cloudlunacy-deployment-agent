// src/utils/templateHandler.js

const Handlebars = require('handlebars');
const fs = require('fs').promises;
const path = require('path');

class TemplateHandler {
  constructor(templatesDir, deployConfig) {
    this.templatesDir = templatesDir;
    this.deployConfig = deployConfig;
    this.templates = {};
    this.registerHelpers();
  }

  registerHelpers() {
    Handlebars.registerHelper('json', function(context) {
      return JSON.stringify(context, null, 2);
    });

    Handlebars.registerHelper('envVar', function(name, value) {
      if (typeof value === 'object') {
        value = JSON.stringify(value);
      }
      return `${name}=${value}`;
    });

    Handlebars.registerHelper('concat', function(...args) {
      args.pop(); // Remove last argument (Handlebars options)
      return args.join('');
    });
  }

  async loadTemplate(templateName) {
    if (!this.templates[templateName]) {
      const templatePath = path.join(this.templatesDir, templateName);
      const templateContent = await fs.readFile(templatePath, 'utf-8');
      this.templates[templateName] = Handlebars.compile(templateContent);
    }
    return this.templates[templateName];
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

    if (!this.deployConfig[appType]) {
      throw new Error(`Unsupported application type: ${appType}`);
    }

    const config = this.mergeDefaults(appType, buildConfig);
    const typeConfig = this.deployConfig[appType];

    const files = {};

    // Generate Dockerfile
    files.dockerfile = await this.generateFile(
      typeConfig.dockerfileTemplate,
      {
        nodeVersion: config.nodeVersion,
        usePnpm: config.usePnpm,
        useYarn: config.useYarn,
        buildCommand: config.buildCommand,
        buildOutputDir: config.buildOutputDir,
        port,
        environment
      }
    );

    // Generate docker-compose.yml
    files.dockerCompose = await this.generateFile(
      typeConfig.dockerComposeTemplate,
      {
        appName,
        environment,
        port,
        envVars,
        volumes: config.volumes,
        dependencies: config.dependencies
      }
    );

    // Generate nginx.conf for React apps
    if (appType === 'react') {
      files.nginxConf = await this.generateFile(
        typeConfig.nginxTemplate,
        {
          domain,
          port,
          ssl,
          api,
          cacheControl: config.cacheControl,
          securityHeaders: config.securityHeaders,
          customLocations: config.nginxLocations
        }
      );
    }

    return files;
  }

  async generateFile(templateName, data) {
    const template = await this.loadTemplate(templateName);
    return template(data);
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

    return true;
  }
}

module.exports = TemplateHandler;