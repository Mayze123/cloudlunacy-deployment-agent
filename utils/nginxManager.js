const { executeCommand } = require("./executor");
const logger = require("./logger");
const fs = require("fs").promises;
const path = require("path");

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
      await this.ensureDirectories();
      await this.setupMainConfig();
      await this.startNginx();
      logger.info("NginxManager initialized successfully");
    } catch (error) {
      logger.error("NginxManager initialization failed:", error);
      throw error;
    }
  }

  async setupMainConfig() {
    try {
      const mainConfig = `
user www-data;
worker_processes auto;
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 768;
}

http {
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;

    gzip on;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;

    server_names_hash_bucket_size 64;
    client_max_body_size 50M;
}`;

      await executeCommand("sudo", ["tee", "/etc/nginx/nginx.conf"], {
        input: mainConfig,
      });

      await executeCommand("sudo", [
        "rm",
        "-f",
        "/etc/nginx/sites-enabled/default",
      ]).catch(() => {});
    } catch (error) {
      logger.error("Failed to setup main Nginx config:", error);
      throw error;
    }
  }

  async ensureDirectories() {
    try {
      // Check if we can write to directories directly first
      try {
        await fs.access(this.sitesAvailablePath, fs.constants.W_OK);
        await fs.access(this.sitesEnabledPath, fs.constants.W_OK);
        logger.info("Direct access to nginx directories confirmed");
        return true;
      } catch (error) {
        logger.warn(
          "Cannot directly access nginx directories, falling back to sudo"
        );
      }

      // Try using process.env.SUDO_COMMAND if available (set by installation script)
      if (process.env.SUDO_COMMAND) {
        await executeCommand(process.env.SUDO_COMMAND, [
          "mkdir",
          "-p",
          this.sitesAvailablePath,
        ]);
        await executeCommand(process.env.SUDO_COMMAND, [
          "mkdir",
          "-p",
          this.sitesEnabledPath,
        ]);
        return true;
      }

      // Last resort: try using sudo with -n flag (non-interactive)
      await executeCommand("sudo", [
        "-n",
        "mkdir",
        "-p",
        this.sitesAvailablePath,
      ]);
      await executeCommand("sudo", [
        "-n",
        "mkdir",
        "-p",
        this.sitesEnabledPath,
      ]);
      return true;
    } catch (error) {
      logger.error("Failed to ensure nginx directories:", error);
      return false;
    }
  }

  async startNginx() {
    try {
      await executeCommand("sudo", ["systemctl", "enable", "nginx"]);
      await executeCommand("sudo", ["systemctl", "start", "nginx"]);

      const { stdout } = await executeCommand("sudo", [
        "systemctl",
        "is-active",
        "nginx",
      ]);
      if (stdout.trim() !== "active") {
        throw new Error("Nginx failed to start");
      }
    } catch (error) {
      logger.error("Failed to start Nginx:", error);
      throw error;
    }
  }

  async configureNginx(domain, hostPort) {
    try {
      logger.info(`Configuring Nginx for ${domain} on port ${hostPort}`);

      // Ensure we can access required directories
      if (!(await this.ensureDirectories())) {
        throw new Error("Cannot access required nginx directories");
      }

      // Read template
      let template;
      try {
        template = await fs.readFile(this.templatePath, "utf-8");
      } catch (error) {
        logger.error("Failed to read nginx template:", error);
        throw new Error("Nginx template not found");
      }

      // Replace variables
      const config = template
        .replace(/\{\{domain\}\}/g, domain)
        .replace(/\{\{port\}\}/g, hostPort);

      // Determine available write method
      const writeConfig = async (content, targetPath) => {
        try {
          // Try direct write first
          await fs.writeFile(targetPath, content);
        } catch (error) {
          // Fall back to echo and redirect
          await executeCommand("bash", [
            "-c",
            `echo '${content}' > ${targetPath}`,
          ]);
        }
      };

      // Write configuration
      const configPath = path.join(this.sitesAvailablePath, domain);
      const enabledPath = path.join(this.sitesEnabledPath, domain);

      await writeConfig(config, configPath);

      // Create symlink if it doesn't exist
      try {
        await fs.symlink(configPath, enabledPath);
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
      }

      // Try to reload nginx through systemctl
      try {
        await executeCommand("systemctl", ["reload", "nginx"]);
      } catch (error) {
        logger.warn("Failed to reload nginx through systemctl:", error);
        // Fall back to direct nginx reload
        try {
          await executeCommand("nginx", ["-s", "reload"]);
        } catch (reloadError) {
          logger.error("Failed to reload nginx:", reloadError);
          throw new Error("Failed to reload nginx configuration");
        }
      }

      logger.info(`Nginx configuration completed for ${domain}`);
      return true;
    } catch (error) {
      logger.error(`Nginx configuration failed for ${domain}:`, error);
      throw error;
    }
  }

  async collectDiagnostics(domain) {
    try {
      const configPath = path.join(this.sitesAvailablePath, domain);
      const enabledPath = path.join(this.sitesEnabledPath, domain);

      logger.error("Nginx Diagnostics:");
      logger.error(
        "1. Configuration file existence:",
        await executeCommand("sudo", ["test", "-f", configPath])
          .then(() => "Yes")
          .catch(() => "No")
      );
      logger.error(
        "2. Symlink existence:",
        await executeCommand("sudo", ["test", "-L", enabledPath])
          .then(() => "Yes")
          .catch(() => "No")
      );
      logger.error(
        "3. Nginx error log:",
        (
          await executeCommand("sudo", [
            "tail",
            "-n",
            "20",
            "/var/log/nginx/error.log",
          ])
        ).stdout
      );
      logger.error(
        "4. Nginx configuration test:",
        (await executeCommand("sudo", ["nginx", "-t"])).stderr
      );
    } catch (error) {
      logger.error("Failed to collect diagnostics:", error);
    }
  }

  async verifySiteAccess(domain, hostPort) {
    try {
      // Wait for nginx to fully start
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check if nginx is listening
      const { stdout: listeners } = await executeCommand("sudo", [
        "ss",
        "-tlnp",
      ]);
      if (!listeners.includes(":80")) {
        throw new Error("Nginx is not listening on port 80");
      }

      // Test local access
      await executeCommand("curl", [
        "--fail",
        "--silent",
        `http://localhost:${hostPort}`,
      ]);

      logger.info(`Site verification completed for ${domain}`);
    } catch (error) {
      logger.error(`Site verification failed for ${domain}:`, error);
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
      const configPath = path.join(this.sitesAvailablePath, domain);
      const enabledPath = path.join(this.sitesEnabledPath, domain);

      try {
        await fs.unlink(enabledPath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          logger.warn(`Failed to remove enabled config for ${domain}:`, error);
        }
      }

      try {
        await fs.unlink(configPath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          logger.warn(
            `Failed to remove available config for ${domain}:`,
            error
          );
        }
      }

      // Try to reload nginx configuration
      try {
        await executeCommand("systemctl", ["reload", "nginx"]);
      } catch (error) {
        await executeCommand("nginx", ["-s", "reload"]);
      }

      logger.info(`Removed Nginx configuration for ${domain}`);
    } catch (error) {
      logger.error(`Error removing Nginx config for ${domain}:`, error);
      throw error;
    }
  }
}

module.exports = new NginxManager();
