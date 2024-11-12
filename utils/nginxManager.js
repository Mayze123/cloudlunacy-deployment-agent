const { executeCommand } = require("./executor");
const logger = require("./logger");
const fs = require("fs").promises;
const path = require("path");

class NginxManager {
  constructor() {
    this.baseDir = "/opt/cloudlunacy";
    this.configDir = `${this.baseDir}/nginx/conf.d`;
    this.proxyNetwork = "nginx-proxy";
    this.proxyContainer = "nginx-proxy";
    this.initialize().catch((error) => {
      logger.error("Failed to initialize NginxManager:", error);
    });
  }

  async initialize() {
    try {
      await this.ensureDirectories();
      await this.ensureProxyNetwork();
      await this.ensureProxyRunning();
      logger.info("NginxManager initialized successfully");
    } catch (error) {
      logger.error("NginxManager initialization failed:", error);
      throw error;
    }
  }

  async ensureDirectories() {
    try {
      const dirs = [
        `${this.baseDir}/nginx/conf.d`,
        `${this.baseDir}/nginx/vhost.d`,
        `${this.baseDir}/nginx/html`,
        `${this.baseDir}/nginx/certs`,
      ];

      for (const dir of dirs) {
        await fs.mkdir(dir, { recursive: true });
      }

      // Create default configuration if it doesn't exist
      const defaultConfigPath = path.join(this.configDir, "default.conf");
      if (!(await fs.access(defaultConfigPath).catch(() => false))) {
        const defaultConfig = `
server {
    listen 80 default_server;
    server_name _;
    
    location / {
        return 200 'Server is running\\n';
        add_header Content-Type text/plain;
    }
}`;
        await fs.writeFile(defaultConfigPath, defaultConfig);
      }

      return true;
    } catch (error) {
      logger.error("Failed to ensure directories:", error);
      return false;
    }
  }

  async ensureProxyNetwork() {
    try {
      const { stdout: networks } = await executeCommand("docker", [
        "network",
        "ls",
      ]);
      if (!networks.includes(this.proxyNetwork)) {
        await executeCommand("docker", [
          "network",
          "create",
          this.proxyNetwork,
        ]);
        logger.info(`Created ${this.proxyNetwork} network`);
      }
    } catch (error) {
      logger.error("Failed to ensure proxy network:", error);
      throw error;
    }
  }

  async ensureProxyRunning() {
    try {
      // Check if container exists and is running
      const { stdout: containers } = await executeCommand("docker", [
        "ps",
        "-a",
      ]);
      const isRunning = containers.includes(this.proxyContainer);

      if (!isRunning) {
        // Create docker-compose file for proxy
        const composeFilePath = path.join(
          this.baseDir,
          "docker-compose.proxy.yml"
        );
        const composeConfig = `
version: "3.8"
services:
  nginx-proxy:
    image: nginx:alpine
    container_name: ${this.proxyContainer}
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ${this.baseDir}/nginx/conf.d:/etc/nginx/conf.d
      - ${this.baseDir}/nginx/vhost.d:/etc/nginx/vhost.d
      - ${this.baseDir}/nginx/html:/usr/share/nginx/html
      - ${this.baseDir}/nginx/certs:/etc/nginx/certs:ro
    networks:
      - ${this.proxyNetwork}

networks:
  ${this.proxyNetwork}:
    external: true`;

        await fs.writeFile(composeFilePath, composeConfig);

        // Start the proxy
        await executeCommand("docker-compose", [
          "-f",
          composeFilePath,
          "up",
          "-d",
        ]);
        logger.info("Started nginx proxy container");
      }
    } catch (error) {
      logger.error("Failed to ensure proxy is running:", error);
      throw error;
    }
  }

  async configureNginx(domain, hostPort) {
    try {
      logger.info(`Configuring Nginx for ${domain} on port ${hostPort}`);

      const config = `
server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://host.docker.internal:${hostPort};
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
        proxy_pass http://host.docker.internal:${hostPort};
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

      // Write config file
      await fs.writeFile(path.join(this.configDir, `${domain}.conf`), config);

      // Reload nginx container
      await executeCommand("docker", [
        "exec",
        this.proxyContainer,
        "nginx",
        "-s",
        "reload",
      ]);

      logger.info(`Nginx configuration completed for ${domain}`);
      return true;
    } catch (error) {
      logger.error(`Nginx configuration failed for ${domain}:`, error);
      throw error;
    }
  }

  async removeConfig(domain) {
    try {
      const configPath = path.join(this.configDir, `${domain}.conf`);

      await fs.unlink(configPath).catch(() => {});

      // Reload nginx container
      await executeCommand("docker", [
        "exec",
        this.proxyContainer,
        "nginx",
        "-s",
        "reload",
      ]);

      logger.info(`Removed Nginx configuration for ${domain}`);
    } catch (error) {
      logger.error(`Error removing Nginx config for ${domain}:`, error);
      throw error;
    }
  }

  async verifyAndReload() {
    try {
      await executeCommand("docker", [
        "exec",
        this.proxyContainer,
        "nginx",
        "-t",
      ]);
      await executeCommand("docker", [
        "exec",
        this.proxyContainer,
        "nginx",
        "-s",
        "reload",
      ]);
    } catch (error) {
      throw new Error(`Failed to verify/reload Nginx: ${error.message}`);
    }
  }
}

module.exports = new NginxManager();
