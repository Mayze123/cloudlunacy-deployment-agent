// utils/traefikManager.js
const { executeCommand } = require("./executor");
const logger = require("./logger");
const fs = require("fs").promises;
const path = require("path");
const yaml = require("js-yaml");

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
      const { stdout: status } = await executeCommand("docker", [
        "inspect",
        "-f",
        "{{.State.Running}}",
        this.proxyContainer,
      ]);

      if (status.trim() !== "true") {
        logger.info("Traefik proxy not running, attempting to start...");
        await this.restartProxy();
      }

      return true;
    } catch (error) {
      logger.error("Error checking Traefik status:", error);
      await this.restartProxy();
    }
  }

  async configureService(domain, serviceName, port) {
    try {
      logger.info(`Configuring Traefik for ${domain} on port ${port}`);

      // Get the current docker-compose.yml content
      const composePath = path.join(
        "/opt/cloudlunacy/deployments",
        serviceName,
        "docker-compose.yml"
      );
      let composeContent = await fs.readFile(composePath, "utf-8");
      let compose = yaml.load(composeContent);

      // Update the service labels
      compose.services[serviceName].labels = [
        "traefik.enable=true",
        "traefik.docker.network=traefik-proxy",
        `traefik.http.routers.${serviceName}.rule=Host(\`${domain}\`)`,
        "traefik.http.routers.${serviceName}.entrypoints=websecure",
        "traefik.http.routers.${serviceName}.tls=true",
        "traefik.http.routers.${serviceName}.tls.certresolver=letsencrypt",
        `traefik.http.services.${serviceName}.loadbalancer.server.port=8080`,
        "traefik.http.routers.${serviceName}.middlewares=security-headers@file,rate-limit@file,compress@file",
      ];

      // Write updated docker-compose.yml
      await fs.writeFile(composePath, yaml.dump(compose), "utf-8");

      // Try to disconnect from network first (ignore errors)
      await executeCommand("docker", [
        "network",
        "disconnect",
        this.proxyNetwork,
        serviceName,
      ]).catch(() => {});

      // Recreate the container with updated labels
      await executeCommand(
        "docker-compose",
        ["-f", composePath, "up", "-d", "--force-recreate", serviceName],
        { cwd: path.dirname(composePath) }
      );

      // Connect to traefik network if not already connected
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

      // Wait for container to be ready
      await this.waitForContainer(serviceName);

      // Ensure Traefik is running
      await this.ensureProxyRunning();

      // Verify configuration
      await this.verifyConfiguration();

      logger.info(`Traefik configuration completed for ${domain}`);
      return true;
    } catch (error) {
      logger.error(`Traefik configuration failed for ${domain}:`, error);
      throw error;
    }
  }

  async waitForContainer(serviceName, timeout = 30000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        const { stdout } = await executeCommand("docker", [
          "inspect",
          "-f",
          "{{.State.Running}}",
          serviceName,
        ]);

        if (stdout.trim() === "true") {
          // Check if container is healthy if it has health check
          const { stdout: health } = await executeCommand("docker", [
            "inspect",
            "-f",
            "{{.State.Health.Status}}",
            serviceName,
          ]);

          if (health.trim() === "healthy" || health.trim() === "<no value>") {
            return true;
          }
        }
      } catch (error) {
        // Ignore errors and continue waiting
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timeout waiting for container ${serviceName} to be ready`);
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
      // Wait a bit for Traefik to initialize
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const { stdout: status } = await executeCommand("docker", [
        "inspect",
        "-f",
        "{{.State.Running}}",
        this.proxyContainer,
      ]);

      if (status.trim() !== "true") {
        throw new Error("Traefik container is not running");
      }

      const { stdout } = await executeCommand("docker", [
        "exec",
        this.proxyContainer,
        "traefik",
        "healthcheck",
      ]);

      if (!stdout.includes("OK")) {
        throw new Error("Traefik health check failed");
      }

      return true;
    } catch (error) {
      logger.error("Failed to verify Traefik configuration:", error);
      throw error;
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
      logger.info("Restarting Traefik proxy...");

      // Stop the container
      await executeCommand("docker", ["stop", this.proxyContainer]).catch(
        () => {}
      );

      // Remove the container
      await executeCommand("docker", ["rm", this.proxyContainer]).catch(
        () => {}
      );

      // Start using docker-compose
      const composeFile = path.join(this.baseDir, "docker-compose.proxy.yml");
      await executeCommand("docker-compose", ["-f", composeFile, "up", "-d"]);

      // Wait for proxy to be ready
      let attempts = 0;
      const maxAttempts = 30;

      while (attempts < maxAttempts) {
        try {
          const { stdout } = await executeCommand("docker", [
            "inspect",
            "-f",
            "{{.State.Running}}",
            this.proxyContainer,
          ]);

          if (stdout.trim() === "true") {
            logger.info("Traefik proxy started successfully");
            return true;
          }
        } catch (error) {
          // Ignore errors and continue waiting
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
        attempts++;
      }

      throw new Error("Failed to start Traefik proxy after multiple attempts");
    } catch (error) {
      logger.error("Failed to restart Traefik proxy:", error);
      throw error;
    }
  }
}

module.exports = new TraefikManager();
