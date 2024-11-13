// utils/traefikManager.js
const { executeCommand } = require("./executor");
const logger = require("./logger");
const fs = require("fs").promises;
const path = require("path");

class TraefikManager {
  constructor() {
    this.baseDir = "/opt/cloudlunacy";
    this.configDir = `${this.baseDir}/traefik`;
    this.proxyNetwork = "traefik-proxy";
    this.proxyContainer = "traefik-proxy";
  }

  async initialize() {
    try {
      await this.ensureDirectories();
      await this.ensureProxyNetwork();
      await this.ensureProxyRunning();
      logger.info("TraefikManager initialized successfully");
    } catch (error) {
      logger.error("TraefikManager initialization failed:", error);
      throw error;
    }
  }

  async ensureDirectories() {
    try {
      const dirs = [
        `${this.configDir}/dynamic`,
        `${this.configDir}/acme`,
        `${this.configDir}/logs`,
      ];

      for (const dir of dirs) {
        try {
          await fs.access(dir);
        } catch {
          await fs.mkdir(dir, { recursive: true, mode: 0o775 });
        }
        await fs.chmod(dir, 0o775);
      }

      // Create initial traefik.yml configuration
      const traefikConfig = `
global:
  checkNewVersion: true
  sendAnonymousUsage: false

log:
  level: INFO
  filePath: "/etc/traefik/logs/traefik.log"

accessLog:
  filePath: "/etc/traefik/logs/access.log"
  bufferingSize: 100

api:
  dashboard: true
  insecure: false

entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ":443"
    http:
      tls:
        certResolver: letsencrypt

providers:
  docker:
    endpoint: "unix:///var/run/docker.sock"
    watch: true
    exposedByDefault: false
    network: ${this.proxyNetwork}
  file:
    directory: "/etc/traefik/dynamic"
    watch: true

certificatesResolvers:
  letsencrypt:
    acme:
      email: "admin@example.com"  # Will be replaced during setup
      storage: "/etc/traefik/acme/acme.json"
      httpChallenge:
        entryPoint: web
`;

      await fs.writeFile(
        path.join(this.configDir, "traefik.yml"),
        traefikConfig,
        { mode: 0o644 }
      );

      // Create dynamic configuration directory for custom middleware
      const middlewareConfig = `
http:
  middlewares:
    security-headers:
      headers:
        frameDeny: true
        sslRedirect: true
        browserXssFilter: true
        contentTypeNosniff: true
        stsIncludeSubdomains: true
        stsPreload: true
        stsSeconds: 31536000
        customResponseHeaders:
          X-Robots-Tag: "noindex,nofollow,nosnippet,noarchive,notranslate,noimageindex"
          Server: ""
    
    rate-limit:
      rateLimit:
        average: 100
        burst: 50
        period: 1s
    
    compress:
      compress: {}
`;

      await fs.writeFile(
        path.join(this.configDir, "dynamic/middleware.yml"),
        middlewareConfig,
        { mode: 0o644 }
      );

      // Create empty acme.json with correct permissions
      const acmeFile = path.join(this.configDir, "acme/acme.json");
      await fs.writeFile(acmeFile, "{}", { mode: 0o600 });

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
      const { stdout: containers } = await executeCommand("docker", [
        "ps",
        "-a",
      ]);
      const isRunning = containers.includes(this.proxyContainer);

      if (!isRunning) {
        const composeFilePath = path.join(
          this.baseDir,
          "docker-compose.proxy.yml"
        );
        const composeConfig = `
version: "3.8"
services:
  traefik-proxy:
    image: traefik:v2.10
    container_name: ${this.proxyContainer}
    restart: always
    security_opt:
      - no-new-privileges:true
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /etc/localtime:/etc/localtime:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ${this.configDir}/traefik.yml:/etc/traefik/traefik.yml:ro
      - ${this.configDir}/dynamic:/etc/traefik/dynamic:ro
      - ${this.configDir}/acme:/etc/traefik/acme
      - ${this.configDir}/logs:/etc/traefik/logs
    networks:
      - ${this.proxyNetwork}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.dashboard.rule=Host(\`traefik.localhost\`)"
      - "traefik.http.routers.dashboard.service=api@internal"
      - "traefik.http.routers.dashboard.middlewares=auth-middleware"
      - "traefik.http.middlewares.auth-middleware.basicauth.users=admin:$$apr1$$xyz123...$$"  # Will be replaced during setup

networks:
  ${this.proxyNetwork}:
    external: true`;

        await fs.writeFile(composeFilePath, composeConfig);
        await executeCommand("docker-compose", [
          "-f",
          composeFilePath,
          "up",
          "-d",
        ]);
        logger.info("Started traefik proxy container");
      }
    } catch (error) {
      logger.error("Failed to ensure proxy is running:", error);
      throw error;
    }
  }

  async configureService(domain, serviceName, port) {
    try {
      logger.info(`Configuring Traefik for ${domain} on port ${port}`);

      // Try to disconnect from network first (ignore errors)
      await executeCommand("docker", [
        "network",
        "disconnect",
        this.proxyNetwork,
        serviceName,
      ]).catch(() => {});

      // Connect to traefik network
      await executeCommand("docker", [
        "network",
        "connect",
        this.proxyNetwork,
        serviceName,
      ]).catch((error) => {
        // Only throw if error is not "already connected"
        if (!error.message.includes("already exists")) {
          throw error;
        }
      });

      // Update container labels - Fixed syntax for docker container update
      for (const label of [
        `traefik.enable=true`,
        `traefik.http.routers.${serviceName}.rule=Host(\`${domain}\`)`,
        `traefik.http.services.${serviceName}.loadbalancer.server.port=8080`,
        `traefik.http.routers.${serviceName}.middlewares=security-headers@file,rate-limit@file,compress@file`,
        `traefik.http.routers.${serviceName}.tls=true`,
        `traefik.http.routers.${serviceName}.tls.certresolver=letsencrypt`,
        `traefik.http.routers.${serviceName}.entrypoints=websecure`,
      ]) {
        await executeCommand("docker", [
          "container",
          "update",
          "--label-rm",
          `traefik.enable`,
          "--label-add",
          label,
          serviceName,
        ]);
      }

      // Verify Traefik is running before checking configuration
      await this.ensureProxyRunning();

      await this.verifyConfiguration();

      logger.info(`Traefik configuration completed for ${domain}`);
      return true;
    } catch (error) {
      logger.error(`Traefik configuration failed for ${domain}:`, error);
      throw error;
    }
  }

  async removeService(domain, serviceName) {
    try {
      // Remove service from traefik network
      await executeCommand("docker", [
        "network",
        "disconnect",
        this.proxyNetwork,
        serviceName,
      ]).catch(() => {});

      logger.info(`Removed Traefik configuration for ${domain}`);
    } catch (error) {
      logger.error(`Error removing Traefik config for ${domain}:`, error);
      throw error;
    }
  }

  async verifyConfiguration() {
    try {
      // First check if container is running
      const { stdout: containerStatus } = await executeCommand("docker", [
        "container",
        "inspect",
        "-f",
        "{{.State.Running}}",
        this.proxyContainer,
      ]);

      if (containerStatus.trim() !== "true") {
        throw new Error("Traefik container is not running");
      }

      // Then check configuration
      const { stdout: configCheck } = await executeCommand("docker", [
        "exec",
        this.proxyContainer,
        "traefik",
        "healthcheck",
      ]);

      if (!configCheck.includes("OK")) {
        throw new Error("Traefik configuration check failed");
      }

      return true;
    } catch (error) {
      logger.error("Failed to verify Traefik configuration:", error);
      // Attempt to restart the proxy
      await this.restartProxy();
      throw new Error(
        `Failed to verify Traefik configuration: ${error.message}`
      );
    }
  }

  async updateSSLConfig(email) {
    try {
      const configPath = path.join(this.configDir, "traefik.yml");
      let config = await fs.readFile(configPath, "utf8");
      config = config.replace(
        /email: .*$/m,
        `email: "${email}"  # Updated configuration`
      );
      await fs.writeFile(configPath, config);
      await this.restartProxy();
    } catch (error) {
      throw new Error(`Failed to update SSL configuration: ${error.message}`);
    }
  }

  async restartProxy() {
    try {
      logger.info("Attempting to restart Traefik proxy...");

      // Stop the container first
      await executeCommand("docker", ["stop", this.proxyContainer]).catch(
        () => {}
      );

      // Remove the container
      await executeCommand("docker", ["rm", this.proxyContainer]).catch(
        () => {}
      );

      // Start it again using docker-compose
      await executeCommand("docker-compose", [
        "-f",
        path.join(this.baseDir, "docker-compose.proxy.yml"),
        "up",
        "-d",
      ]);

      // Wait for container to be ready
      let attempts = 0;
      const maxAttempts = 5;

      while (attempts < maxAttempts) {
        try {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const { stdout } = await executeCommand("docker", [
            "exec",
            this.proxyContainer,
            "traefik",
            "healthcheck",
          ]);

          if (stdout.includes("OK")) {
            logger.info("Traefik proxy restarted successfully");
            return;
          }
        } catch (error) {
          logger.warn(
            `Attempt ${
              attempts + 1
            }/${maxAttempts} to verify Traefik health failed`
          );
        }
        attempts++;
      }

      throw new Error("Failed to verify Traefik health after restart");
    } catch (error) {
      logger.error("Failed to restart Traefik proxy:", error);
      throw error;
    }
  }
}

module.exports = new TraefikManager();
