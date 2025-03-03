// utils/templateHandler.js

const fs = require("fs").promises;
const path = require("path");
const Handlebars = require("handlebars");
const logger = require("./logger");

class TemplateHandler {
  constructor(templatesDir, deployConfig) {
    this.templatesDir = templatesDir;
    this.deployConfig = deployConfig;
  }

  async generateDeploymentFiles({
    appType,
    appName,
    environment,
    hostPort,
    containerPort,
    domain,
    envFile,
    health,
  }) {
    const config = this.deployConfig[appType.toLowerCase()];
    if (!config) {
      throw new Error(`No template found for appType: ${appType}`);
    }

    const dockerfileTemplatePath = path.join(
      this.templatesDir,
      config.dockerfileTemplate,
    );
    const dockerComposeTemplatePath = path.join(
      this.templatesDir,
      config.dockerComposeTemplate,
    );

    // Check if template files exist
    await Promise.all([
      fs.access(dockerfileTemplatePath),
      fs.access(dockerComposeTemplatePath),
    ]);

    const dockerfileTemplateContent = await fs.readFile(
      dockerfileTemplatePath,
      "utf-8",
    );
    const dockerComposeTemplateContent = await fs.readFile(
      dockerComposeTemplatePath,
      "utf-8",
    );

    const dockerfileTemplate = Handlebars.compile(dockerfileTemplateContent);
    const dockerComposeTemplate = Handlebars.compile(
      dockerComposeTemplateContent,
    );

    // Compute sanitizedAppName
    const sanitizedAppName = appName.toLowerCase().replace(/[^a-z0-9-]/g, "-");

    // Render templates with variables
    const renderedDockerfile = dockerfileTemplate({
      appName,
      sanitizedAppName,
      environment,
      containerPort,
      health,
    });

    const renderedDockerCompose = dockerComposeTemplate({
      appName,
      sanitizedAppName,
      environment,
      hostPort,
      containerPort,
      domain,
      envFile,
    });

    logger.info(`Rendered deployment files for appType: ${appType}`);

    return {
      dockerfile: renderedDockerfile,
      dockerCompose: renderedDockerCompose,
    };
  }
}

module.exports = TemplateHandler;
