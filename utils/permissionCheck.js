// utils/permissionCheck.js

const fs = require('fs').promises;
const { execSync } = require('child_process');
const path = require('path');
const logger = require('./logger');

async function ensureDeploymentPermissions() {
    try {
        // Ensure deployment directories exist
        const dirs = [
            '/opt/cloudlunacy/deployments',
            '/tmp/cloudlunacy-deployments'
        ];

        for (const dir of dirs) {
            await fs.mkdir(dir, { recursive: true, mode: 0o775 });
        }

        // Check if running as cloudlunacy user
        const currentUser = process.env.USER || execSync('whoami').toString().trim();
        
        if (currentUser !== 'cloudlunacy') {
            throw new Error('Agent must run as cloudlunacy user');
        }

        // Check docker group membership
        const groups = execSync('groups').toString();
        if (!groups.includes('docker')) {
            throw new Error('cloudlunacy user must be in docker group');
        }

        // Check docker socket permissions
        const dockerSock = '/var/run/docker.sock';
        const dockerSockStats = await fs.stat(dockerSock);
        if ((dockerSockStats.mode & 0o777) !== 0o666) {
            logger.warn('Docker socket permissions are not 666, deployment might fail');
        }

        // Check if can run docker commands
        try {
            execSync('docker ps', { stdio: 'ignore' });
        } catch (error) {
            throw new Error('Cannot execute docker commands. Please check permissions.');
        }

        return true;
    } catch (error) {
        logger.error('Permission check failed:', error);
        return false;
    }
}

module.exports = {
    ensureDeploymentPermissions
};