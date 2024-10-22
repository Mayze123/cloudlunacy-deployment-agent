// modules/deployApp.js

const { executeCommand } = require('../utils/executor');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');
const Handlebars = require('handlebars');

const deployConfig = require('../deployConfig.json');

/**
 * Deploys an application based on the provided payload using configuration.
 * @param {Object} payload - Deployment details
 * @param {WebSocket} ws - WebSocket connection to send status updates
 */
async function deployApp(payload, ws) {
    const { appType, appName, repoUrl, branch, envVars, dockerPort } = payload;

    logger.info(`Starting deployment for ${appType} app: ${appName}`);

    // Validate payload
    const requiredFields = ['appType', 'appName', 'repoUrl', 'branch'];
    for (const field of requiredFields) {
        if (!payload[field]) {
            logger.error(`Missing required field: ${field}`);
            sendStatus(ws, 'deploy_app', 'failure', `Missing required field: ${field}`);
            return;
        }
    }

    try {
        const config = deployConfig[appType.toLowerCase()];
        if (!config) {
            throw new Error(`Unsupported application type: ${appType}`);
        }

        const BASE_DIR = process.env.BASE_DIR || '/opt/cloudlunacy';
        const appDir = path.join(BASE_DIR, appName);
        const dockerfileTemplatePath = path.join(__dirname, '..', config.dockerfileTemplate);
        const dockerComposeTemplatePath = path.join(__dirname, '..', config.dockerComposeTemplate);
        const dockerfilePath = path.join(appDir, 'Dockerfile');
        const dockerComposePath = path.join(appDir, 'docker-compose.yml');

        // Clone the repository with retry logic
        await cloneRepositoryWithRetry(repoUrl, appDir, 3, 2000);

        // Checkout the specified branch
        await executeCommand(`git checkout ${branch}`, appDir);

        // Read and compile Dockerfile template
        const dockerfileTemplate = await fs.readFile(dockerfileTemplatePath, 'utf-8');
        const dockerfileContent = Handlebars.compile(dockerfileTemplate)({ appName, envVars });
        await fs.writeFile(dockerfilePath, dockerfileContent);
        logger.info(`Dockerfile created at ${dockerfilePath}`);

        // Read and compile Docker Compose template
        const dockerComposeTemplate = await fs.readFile(dockerComposeTemplatePath, 'utf-8');
        const dockerComposeContent = Handlebars.compile(dockerComposeTemplate)({
            appName,
            dockerPort: dockerPort || config.defaultPort,
            envVars
        });
        await fs.writeFile(dockerComposePath, dockerComposeContent);
        logger.info(`Docker Compose file created at ${dockerComposePath}`);

        // Deploy the container using Docker Compose
        await executeCommand(`docker-compose up -d`, appDir);
        logger.info(`${appType} app ${appName} deployed successfully using Docker Compose.`);

        // Send success status to backend
        sendStatus(ws, 'deploy_app', 'success', `${appType} app ${appName} deployed successfully.`);
    } catch (error) {
        logger.error(`Error deploying ${appType} app ${appName}: ${error.message}`);

        // Send failure status to backend
        sendStatus(ws, 'deploy_app', 'failure', `Error deploying ${appType} app ${appName}: ${error.message}`);

        // Optional: Cleanup resources
        // await executeCommand(`rm -rf ${appDir}`, '/opt/cloudlunacy');
    }
}

/**
 * Clones a Git repository with retry logic.
 * @param {String} repoUrl - Repository URL
 * @param {String} appDir - Directory to clone into
 * @param {Number} retries - Number of retry attempts
 * @param {Number} delay - Delay between retries in milliseconds
 */
async function cloneRepositoryWithRetry(repoUrl, appDir, retries, delay) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await executeCommand(`git clone ${repoUrl} ${appDir}`, '/opt/cloudlunacy');
            logger.info(`Repository cloned to ${appDir}`);
            return;
        } catch (error) {
            if (attempt === retries) {
                throw new Error(`Failed to clone repository after ${retries} attempts.`);
            }
            logger.warn(`Clone attempt ${attempt} failed. Retrying in ${delay}ms...`);
            await new Promise(res => setTimeout(res, delay));
        }
    }
}

/**
 * Sends status updates back to the backend via WebSocket.
 * @param {WebSocket} ws - WebSocket connection
 * @param {String} commandType - Type of command executed
 * @param {String} status - 'success' or 'failure'
 * @param {String} message - Detailed message
 */
function sendStatus(ws, commandType, status, message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        logger.warn('WebSocket is not open. Cannot send status.');
        return;
    }

    ws.send(JSON.stringify({
        type: 'status',
        payload: {
            commandType,
            status,
            message
        }
    }));
}

module.exports = deployApp;
