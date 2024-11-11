// src/utils/portManager.js

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

class PortManager {
    constructor() {
        this.portsFile = '/opt/cloudlunacy/config/ports.json';
        this.portRangeStart = 3000;
        this.portRangeEnd = 3999;
        this.reservedPorts = new Set([3000]); // Reserved for system use
    }

    async initialize() {
        try {
            await fs.mkdir(path.dirname(this.portsFile), { recursive: true });
            try {
                const data = await fs.readFile(this.portsFile, 'utf8');
                this.portMap = JSON.parse(data);
            } catch (error) {
                this.portMap = {};
                await this.savePorts();
            }
        } catch (error) {
            logger.error('Failed to initialize port manager:', error);
            throw error;
        }
    }

    async savePorts() {
        await fs.writeFile(this.portsFile, JSON.stringify(this.portMap, null, 2));
    }

    async allocatePort(appName, environment) {
        const appId = `${appName}-${environment}`.toLowerCase();
        
        // If port is already allocated, return it
        if (this.portMap[appId]) {
            return this.portMap[appId];
        }

        // Get all allocated ports
        const allocatedPorts = new Set([
            ...Object.values(this.portMap),
            ...this.reservedPorts
        ]);

        // Find first available port
        let port = this.portRangeStart;
        while (port <= this.portRangeEnd) {
            if (!allocatedPorts.has(port)) {
                this.portMap[appId] = port;
                await this.savePorts();
                return port;
            }
            port++;
        }

        throw new Error('No available ports in the range');
    }

    async releasePort(appName, environment) {
        const appId = `${appName}-${environment}`.toLowerCase();
        if (this.portMap[appId]) {
            delete this.portMap[appId];
            await this.savePorts();
        }
    }

    async getPort(appName, environment) {
        const appId = `${appName}-${environment}`.toLowerCase();
        return this.portMap[appId];
    }
}

module.exports = new PortManager();