// src/utils/nginxManager.js

const { executeCommand } = require('./executor');
const logger = require('./logger');
const fs = require('fs').promises;
const path = require('path');
const shelljs = require('shelljs');

class NginxManager {
  constructor() {
    this.sitesAvailablePath = '/etc/nginx/sites-available';
    this.sitesEnabledPath = '/etc/nginx/sites-enabled';
  }

  async configureNginx(domain, port, deployDir) {
    try {
      logger.info(`Configuring Nginx for ${domain} on port ${port}`);

      // Check if configuration already exists
      const existingConfig = await this.getExistingConfig(domain);
      if (existingConfig) {
        logger.info(`Found existing Nginx config for ${domain}`);
        
        // Check if the port has changed
        const currentPort = this.extractPortFromConfig(existingConfig);
        if (currentPort === port) {
          logger.info(`Port ${port} unchanged for ${domain}, skipping Nginx reconfiguration`);
          return;
        }
        logger.info(`Port changed from ${currentPort} to ${port} for ${domain}, updating configuration`);
      }

      const nginxConfig = await this.generateNginxConfig(domain, port);
      
      // Write configuration
      const configPath = path.join(this.sitesAvailablePath, domain);
      await executeCommand('sudo', ['bash', '-c', `echo '${nginxConfig}' | sudo tee ${configPath}`]);
      
      // Create symlink if it doesn't exist
      const enabledPath = path.join(this.sitesEnabledPath, domain);
      if (!await this.checkFileExists(enabledPath)) {
        await executeCommand('sudo', ['ln', '-sf', configPath, enabledPath]);
      }

      // Verify configuration and reload
      await this.verifyAndReload();
      
      logger.info(`Nginx configuration completed for ${domain}`);
    } catch (error) {
      logger.error('Nginx configuration failed:', error);
      await this.collectNginxDiagnostics(error);
      throw error;
    }
  }

  async getExistingConfig(domain) {
    try {
      const configPath = path.join(this.sitesAvailablePath, domain);
      const { stdout } = await executeCommand('sudo', ['cat', configPath], { silent: true });
      return stdout;
    } catch (error) {
      // File doesn't exist or other error
      return null;
    }
  }

  extractPortFromConfig(config) {
    const portMatch = config.match(/proxy_pass http:\/\/127\.0\.0\.1:(\d+)/);
    return portMatch ? parseInt(portMatch[1], 10) : null;
  }

  async generateNginxConfig(domain, port) {
    // Read template
    const templatePath = path.join('/opt/cloudlunacy/templates/nginx', 'virtual-host.template');
    const template = await fs.readFile(templatePath, 'utf-8');
    
    // Replace variables
    return template
      .replace(/\{\{domain\}\}/g, domain)
      .replace(/\{\{port\}\}/g, port);
  }

  async checkFileExists(filePath) {
    try {
      await executeCommand('sudo', ['test', '-f', filePath], { silent: true });
      return true;
    } catch (error) {
      return false;
    }
  }

  async verifyAndReload() {
    try {
      // Test nginx configuration
      await executeCommand('sudo', ['nginx', '-t']);
      // Reload nginx
      await executeCommand('sudo', ['systemctl', 'reload', 'nginx']);
    } catch (error) {
      throw new Error(`Failed to verify/reload Nginx: ${error.message}`);
    }
  }

  async collectNginxDiagnostics(error) {
    try {
      const errorLog = await executeCommand('sudo', ['tail', '-n', '50', '/var/log/nginx/error.log'])
        .catch(() => ({ stdout: 'Could not read nginx error log' }));
      
      const journalLog = await executeCommand(
        'sudo',
        ['journalctl', '-xeu', 'nginx.service', '--no-pager', '-n', '50']
      ).catch(() => ({ stdout: 'Could not read journal log' }));

      logger.error('Nginx error log:', errorLog.stdout);
      logger.error('Journal log:', journalLog.stdout);
      logger.error('Original error:', error.message);
    } catch (diagError) {
      logger.error('Failed to collect Nginx diagnostics:', diagError);
    }
  }

  async removeConfig(domain) {
    try {
      // Check if config exists before trying to remove
      const configExists = await this.getExistingConfig(domain);
      if (!configExists) {
        logger.info(`No existing Nginx configuration found for ${domain}`);
        return;
      }

      // Remove nginx config files
      await executeCommand('sudo', ['rm', '-f', path.join(this.sitesAvailablePath, domain)]);
      await executeCommand('sudo', ['rm', '-f', path.join(this.sitesEnabledPath, domain)]);
      
      // Reload nginx
      await this.verifyAndReload();
      
      logger.info(`Removed Nginx configuration for ${domain}`);
    } catch (error) {
      logger.error(`Error removing Nginx config for ${domain}:`, error);
      throw error;
    }
  }
}

module.exports = new NginxManager();