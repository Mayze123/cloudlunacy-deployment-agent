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
      // Create required directories
      const dirs = [
        "/etc/nginx/sites-available",
        "/etc/nginx/sites-enabled",
        "/etc/nginx/conf.d",
        path.dirname(this.templatePath),
      ];

      for (const dir of dirs) {
        await executeCommand("sudo", ["mkdir", "-p", dir]).catch(() => {});
      }

      const templateContent = `server {
    listen 80;
    server_name {{domain}};

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;

    # Application
    location / {
        proxy_pass http://127.0.0.1:{{hostPort}};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Better timeout configuration
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # WebSocket support
    location /socket.io/ {
        proxy_pass http://127.0.0.1:{{hostPort}};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket specific timeouts
        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
    }

    # Error pages
    error_page 404 /404.html;
    error_page 500 502 503 504 /50x.html;

    # Enable gzip compression
    gzip on;
    gzip_disable "msie6";
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;
}`;

      await executeCommand("sudo", ["tee", this.templatePath], {
        input: templateContent,
      });

      await executeCommand("sudo", [
        "chown",
        "-R",
        "www-data:www-data",
        "/etc/nginx",
      ]);
    } catch (error) {
      logger.error("Failed to ensure directories:", error);
      throw error;
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
      logger.info(
        `Starting Nginx configuration for ${domain} on port ${hostPort}`
      );

      // Verify directories exist
      await executeCommand("sudo", ["mkdir", "-p", this.sitesAvailablePath]);
      await executeCommand("sudo", ["mkdir", "-p", this.sitesEnabledPath]);

      // Read template
      const template = await fs.readFile(this.templatePath, "utf-8");
      if (!template) {
        throw new Error("Nginx template not found");
      }

      // Replace variables
      const config = template
        .replace(/\{\{domain\}\}/g, domain)
        .replace(/\{\{hostPort\}\}/g, hostPort);

      // Write configuration with explicit logging
      const configPath = path.join(this.sitesAvailablePath, domain);
      logger.info(`Writing Nginx config to ${configPath}`);
      await executeCommand("sudo", ["tee", configPath], { input: config });

      // Verify the file was written
      const writtenConfig = await executeCommand("sudo", ["cat", configPath]);
      if (!writtenConfig.stdout.includes(domain)) {
        throw new Error("Nginx configuration file was not written correctly");
      }

      // Create symlink with verification
      const enabledPath = path.join(this.sitesEnabledPath, domain);
      await executeCommand("sudo", ["ln", "-sf", configPath, enabledPath]);

      // Verify symlink
      const symlinkExists = await executeCommand("sudo", [
        "test",
        "-L",
        enabledPath,
      ]);
      if (symlinkExists.code !== 0) {
        throw new Error("Nginx symlink was not created correctly");
      }

      // Test configuration before reload
      await executeCommand("sudo", ["nginx", "-t"]);

      // Reload nginx
      await executeCommand("sudo", ["systemctl", "reload", "nginx"]);

      logger.info(`Nginx configuration completed for ${domain}`);
    } catch (error) {
      logger.error(`Nginx configuration failed for ${domain}:`, error);
      // Collect diagnostic information
      await this.collectDiagnostics(domain);
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
