// modules/checkDeployKey.js

const axios = require('axios');
const logger = require('../utils/logger');

/**
 * Checks with the backend if the deploy key has been added to GitHub.
 * @param {Object} config - Configuration object
 * @param {String} config.backendUrl - Backend API URL
 * @param {String} config.agentToken - Agent authentication token
 * @param {String} config.serverId - Unique server identifier
 * @returns {Boolean} - True if deploy key is added, false otherwise
 */
async function isDeployKeyAdded(config) {
    const { backendUrl, agentToken, serverId } = config;

    try {
        const response = await axios.get(`${backendUrl}/api/keys/${serverId}/status`, {
            headers: {
                'Authorization': `Bearer ${agentToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.status === 200 && response.data.deployKeyAdded === true) {
            logger.info('Deploy key has been added to GitHub.');
            return true;
        } else {
            logger.info('Deploy key has not been added to GitHub yet.');
            return false;
        }
    } catch (error) {
        logger.error(`Error checking deploy key status: ${error.message}`);
        throw error;
    }
}

module.exports = isDeployKeyAdded;