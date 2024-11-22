// utils/templateHandler.js

const fs = require('fs').promises;
const path = require('path');
const handlebars = require('handlebars');
const logger = require('./logger'); 

class TemplateHandler {
    constructor(templatesDir, deployConfig) {
        this.templatesDir = templatesDir;
        this.deployConfig = deployConfig;
    }

    async generateDeploymentFiles({ appType, appName, environment, containerPort, domain }) {
        const appTypeLower = appType.toLowerCase();
        logger.info(`Generating deployment files for appType: ${appTypeLower}`);

        // Load the appropriate template based on appType
        const appConfig = this.deployConfig[appTypeLower];
        if (!appConfig) {
            throw new Error(`No template found for appType: ${appType}`);
        }

        const { dockerfileTemplate, dockerComposeTemplate } = appConfig;

        if (!dockerfileTemplate || !dockerComposeTemplate) {
            throw new Error(`Missing template definitions for appType: ${appType}`);
        }

        const dockerfilePath = path.join(this.templatesDir, dockerfileTemplate);
        const dockerComposePath = path.join(this.templatesDir, dockerComposeTemplate);

        // Check if template files exist
        try {
            await fs.access(dockerfilePath);
            await fs.access(dockerComposePath);
            logger.info(`Template files found for appType: ${appType}`);
        } catch (err) {
            throw new Error(`Template file missing for appType: ${appType}. ${err.message}`);
        }

        // Read template contents
        const [dockerfileContent, dockerComposeContent] = await Promise.all([
            fs.readFile(dockerfilePath, 'utf-8'),
            fs.readFile(dockerComposePath, 'utf-8')
        ]);

        // Compile Handlebars templates
        const dockerfileTemplateCompiled = handlebars.compile(dockerfileContent);
        const dockerComposeTemplateCompiled = handlebars.compile(dockerComposeContent);

        // Render templates with provided variables
        const renderedDockerfile = dockerfileTemplateCompiled({
            sanitizedAppName: appName.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
            environment,
            containerPort,
            domain
        });

        const renderedDockerCompose = dockerComposeTemplateCompiled({
            sanitizedAppName: appName.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
            environment,
            containerPort,
            domain
        });

        logger.info(`Rendered deployment files for appType: ${appType}`);

        return {
            dockerfile: renderedDockerfile,
            dockerCompose: renderedDockerCompose
        };
    }
}

module.exports = TemplateHandler;