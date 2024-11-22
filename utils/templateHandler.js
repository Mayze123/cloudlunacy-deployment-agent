// utils/templateHandler.js

const fs = require('fs').promises;
const path = require('path');
const handlebars = require('handlebars');

class TemplateHandler {
    constructor(templatesDir, deployConfig) {
        this.templatesDir = templatesDir;
        this.deployConfig = deployConfig;
    }

    async generateDeploymentFiles({ appType, appName, environment, containerPort, domain }) {
        // Load the appropriate template based on appType
        const templateFile = this.deployConfig[appType]?.template;
        if (!templateFile) {
            throw new Error(`No template found for appType: ${appType}`);
        }

        const templatePath = path.join(this.templatesDir, templateFile);
        const templateContent = await fs.readFile(templatePath, 'utf-8');

        // Compile the Handlebars template
        const template = handlebars.compile(templateContent);

        // Render the template with provided variables
        const rendered = template({
            sanitizedAppName: appName.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
            environment,
            containerPort,
            domain
        });

        // Assuming the template includes both Dockerfile and docker-compose.yml separated by a delimiter
        const delimiter = '---';
        const [dockerfileContent, dockerComposeContent] = rendered.split(delimiter).map(part => part.trim());

        if (!dockerfileContent || !dockerComposeContent) {
            throw new Error('Template must include both Dockerfile and docker-compose.yml separated by "---"');
        }

        return {
            dockerfile: dockerfileContent,
            dockerCompose: dockerComposeContent
        };
    }
}

module.exports = TemplateHandler;