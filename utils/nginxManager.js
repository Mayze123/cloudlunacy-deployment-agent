const { executeCommand } = require("./executor");
const logger = require("./logger");
const fs = require("fs").promises;
const path = require("path");
const shelljs = require("shelljs");

class NginxManager {
  constructor() {
    this.sitesAvailablePath = "/etc/nginx/sites-available";
    this.sitesEnabledPath = "/etc/nginx/sites-enabled";
    this.templatePath =
      "/opt/cloudlunacy/templates/nginx/virtual-host.template";
    this.initialize().catch((error) => {
      logger.error("Failed to initialize NginxManager:", error);
    });
  }

  async initialize() {
    try {
      // Create directories if they don't exist
      await this.ensureDirectories();
      logger.info("NginxManager initialized successfully");
    } catch (error) {
      logger.error("NginxManager initialization failed:", error);
      throw error;
    }
  }

  async ensureDirectories() {
    try {
      // Only create template directory since nginx directories should already exist
      await fs
        .mkdir(path.dirname(this.templatePath), { recursive: true })
        .catch(() => {});

      // Create default template if it doesn't exist
      const templateContent = `server {
    listen 80;
    server_name {{domain}};

    location / {
        proxy_pass http://127.0.0.1:{{port}};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:{{port}};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
    }
}`;
      await fs
        .writeFile(this.templatePath, templateContent, "utf8")
        .catch(() => {});
    } catch (error) {
      logger.error("Failed to ensure directories:", error);
      throw error;
    }
  }

  async configureNginx(domain, port) {
    try {
      logger.info(`Configuring Nginx for ${domain} on port ${port}`);

      // Read template
      const template = await fs.readFile(this.templatePath, "utf-8");
      if (!template) {
        throw new Error("Nginx template not found");
      }

      // Replace variables
      const config = template
        .replace(/\{\{domain\}\}/g, domain)
        .replace(/\{\{port\}\}/g, port);

      // Write configuration using tee (allowed in sudoers)
      const configPath = path.join(this.sitesAvailablePath, domain);
      await executeCommand("sudo", ["tee", configPath], { input: config });

      // Create symlink (allowed in sudoers)
      const enabledPath = path.join(this.sitesEnabledPath, domain);
      await executeCommand("sudo", ["ln", "-sf", configPath, enabledPath]);

      // Test and reload nginx (allowed in sudoers)
      await executeCommand("sudo", ["nginx", "-t"]);
      await executeCommand("sudo", ["systemctl", "reload", "nginx"]);

      logger.info(`Nginx configuration completed for ${domain}`);
    } catch (error) {
      logger.error("Nginx configuration failed:", error);
      await this.collectNginxDiagnostics();
      throw error;
    }
  }

  async getExistingConfig(domain) {
    try {
      const configPath = path.join(this.sitesAvailablePath, domain);
      const { stdout } = await executeCommand("sudo", ["cat", configPath], {
        silent: true,
      });
      return stdout;
    } catch (error) {
      return null;
    }
  }

  async verifyAndReload() {
    try {
      await executeCommand("sudo", ["nginx", "-t"]);
      await executeCommand("sudo", ["systemctl", "reload", "nginx"]);
    } catch (error) {
      throw new Error(`Failed to verify/reload Nginx: ${error.message}`);
    }
  }

  async collectNginxDiagnostics() {
    try {
      const errorLog = await executeCommand("sudo", [
        "tail",
        "-n",
        "50",
        "/var/log/nginx/error.log",
      ]).catch(() => ({ stdout: "Could not read nginx error log" }));

      const journalLog = await executeCommand("sudo", [
        "journalctl",
        "-xeu",
        "nginx.service",
        "--no-pager",
        "-n",
        "50",
      ]).catch(() => ({ stdout: "Could not read journal log" }));

      logger.error("Nginx error log:", errorLog.stdout);
      logger.error("Journal log:", journalLog.stdout);
    } catch (error) {
      logger.error("Failed to collect Nginx diagnostics:", error);
    }
  }

  async removeConfig(domain) {
    try {
      const configExists = await this.getExistingConfig(domain);
      if (!configExists) {
        logger.info(`No existing Nginx configuration found for ${domain}`);
        return;
      }

      await executeCommand("sudo", [
        "rm",
        "-f",
        path.join(this.sitesAvailablePath, domain),
      ]);
      await executeCommand("sudo", [
        "rm",
        "-f",
        path.join(this.sitesEnabledPath, domain),
      ]);
      await this.verifyAndReload();

      logger.info(`Removed Nginx configuration for ${domain}`);
    } catch (error) {
      logger.error(`Error removing Nginx config for ${domain}:`, error);
      throw error;
    }
  }
}

module.exports = new NginxManager();
