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

      // Read template
      const template = await fs.readFile(this.templatePath, 'utf-8');
      if (!template) {
        throw new Error('Nginx template not found');
      }

      // Replace variables
      const config = template
        .replace(/\{\{domain\}\}/g, domain)
        .replace(/\{\{port\}\}/g, port);

      // Write configuration using sudo
      const configPath = path.join(this.sitesAvailablePath, domain);
      await executeCommand('sudo', ['bash', '-c', `echo '${config}' | sudo tee ${configPath} > /dev/null`]);
      
      // Create symlink
      const enabledPath = path.join(this.sitesEnabledPath, domain);
      await executeCommand('sudo', ['ln', '-sf', configPath, enabledPath]);

      // Test configuration
      try {
        await executeCommand('sudo', ['nginx', '-t']);
      } catch (error) {
        logger.error('Nginx configuration test failed:', error);
        await this.collectNginxDiagnostics();
        throw error;
      }

      // Reload nginx
      await executeCommand('sudo', ['systemctl', 'reload', 'nginx']);
      
      logger.info(`Nginx configuration completed for ${domain}`);
    } catch (error) {
      logger.error('Nginx configuration failed:', error);
      await this.collectNginxDiagnostics();
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

  async collectNginxDiagnostics() {
    try {
      // Use sudo with proper permissions
      const errorLog = await executeCommand('sudo', ['cat', '/var/log/nginx/error.log'])
        .catch(() => ({ stdout: 'Could not read nginx error log' }));
      
      const journalLog = await executeCommand(
        'sudo',
        ['journalctl', '-xeu', 'nginx.service', '--no-pager', '-n', '50']
      ).catch(() => ({ stdout: 'Could not read journal log' }));

      logger.error('Nginx error log:', errorLog.stdout);
      logger.error('Journal log:', journalLog.stdout);
    } catch (error) {
      logger.error('Failed to collect Nginx diagnostics:', error);
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