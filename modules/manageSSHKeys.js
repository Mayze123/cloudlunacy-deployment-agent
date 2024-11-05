// modules/manageSSHKeys.js

const { executeCommand } = require('../utils/executor');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

/**
 * Manages SSH keys: generates if not present and sends public key to backend.
 * @param {Object} config - Configuration object
 * @param {String} config.baseDir - Base directory for the agent
 * @param {String} config.serverId - Unique server identifier
 * @param {String} config.backendUrl - Backend API URL
 * @param {String} config.agentToken - Agent authentication token
 */
async function manageSSHKeys(config) {
    const { baseDir, serverId, backendUrl, agentToken } = config;
    const sshDir = path.join(baseDir, '.ssh');
    const privateKeyPath = path.join(sshDir, 'id_ed25519');
    const publicKeyPath = path.join(sshDir, 'id_ed25519.pub');

    try {
        // Ensure .ssh directory exists
        try {
            await fs.access(sshDir);
        } catch {
            await fs.mkdir(sshDir, { recursive: true });
            logger.info(`Created SSH directory at ${sshDir}`);
        }

        // Check if SSH keys exist
        try {
            await fs.access(privateKeyPath);
            await fs.access(publicKeyPath);
            logger.info('SSH keys already exist.');
        } catch {
            // SSH keys do not exist; generate them
            logger.info('SSH keys not found. Generating new SSH key pair.');
            await executeCommand('ssh-keygen', ['-t', 'ed25519', '-f', privateKeyPath, '-N', ''], baseDir);
            logger.info('SSH key pair generated.');
        }

        // Read public key
        const publicKey = await fs.readFile(publicKeyPath, 'utf-8');

        // Send public key to backend
        logger.info('Sending public SSH key to backend.');
        const response = await axios.post(`${backendUrl}/api/keys`, {
            serverId,
            publicKey
        }, {
            headers: {
                'Authorization': `Bearer ${agentToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.status === 200) {
            logger.info('Public SSH key sent to backend successfully.');
        } else {
            logger.warn(`Unexpected response from backend: ${response.status}`);
        }

    } catch (error) {
        logger.error(`Error managing SSH keys: ${error.message}`);
        throw error;
    }
}

module.exports = manageSSHKeys;