// utils/traefikManager.js
const { executeCommand } = require("./executor");
const logger = require("./logger");
const fs = require("fs").promises;
const path = require("path");
const yaml = require("js-yaml");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

class TraefikManager {
  constructor() {
    this.baseDir = "/opt/cloudlunacy";
    this.configDir = `${this.baseDir}/traefik`;
    this.proxyNetwork = "traefik-proxy";
    this.proxyContainer = "traefik-proxy";
  }

  async initialize() {
    try {
      // Skip direct chmod of docker.sock - we'll handle permissions differently
      if (!(await this.checkDockerAccess())) {
        throw new Error(
          "Insufficient Docker permissions. Please ensure the cloudlunacy user is in the docker group."
        );
      }

      // Create directories with correct permissions
      await this.ensureDirectories();

      // Create docker-compose file
      await this.ensureComposeFile();

      // Create network
      await this.ensureProxyNetwork();

      // Start proxy
      await this.restartProxy();

      // Verify it's running
      await this.verifyConfiguration();

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

      // First ensure base directory exists with correct permissions
      await fs.mkdir(this.configDir, { recursive: true });
      await executeCommand("chown", [
        "-R",
        "cloudlunacy:docker",
        this.configDir,
      ]);
      await executeCommand("chmod", ["775", this.configDir]);

      for (const dir of dirs) {
        try {
          await fs.access(dir);
        } catch {
          await fs.mkdir(dir, { recursive: true });
        }
        // Use executeCommand instead of fs.chmod for elevated privileges
        await executeCommand("chown", ["-R", "cloudlunacy:docker", dir]);
        await executeCommand("chmod", ["775", dir]);
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

      // Generate secure password for admin user
      const adminPassword = await this.generateSecurePassword();

      const middlewareConfig = `
http:
  middlewares:
    auth-basic:
      basicAuth:
        users:
          - "${adminPassword}"  # Generated during installation
    
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

      // Save admin credentials securely
      await this.saveAdminCredentials();

      // Create empty acme.json with correct permissions
      const acmeFile = path.join(this.configDir, "acme/acme.json");
      await fs.writeFile(acmeFile, "{}", { mode: 0o600 });

      return true;
    } catch (error) {
      logger.error("Failed to ensure directories:", error);
      throw error;
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

      // Stop and remove existing container
      await executeCommand("docker", ["stop", this.proxyContainer]).catch(
        () => {}
      );
      await executeCommand("docker", ["rm", this.proxyContainer]).catch(
        () => {}
      );

      // Ensure network exists
      await executeCommand("docker", [
        "network",
        "create",
        "traefik-proxy",
      ]).catch(() => {});

      // Get compose file path
      const composeFile = path.join(this.baseDir, "docker-compose.proxy.yml");

      // Start the container
      const result = await executeCommand(
        "docker-compose",
        ["-f", composeFile, "up", "-d"],
        {
          env: {
            ...process.env,
            PATH: process.env.PATH,
            HOME: this.baseDir,
          },
        }
      );

      // Wait for container to start
      let attempts = 0;
      while (attempts < 30) {
        try {
          const { stdout } = await executeCommand("docker", [
            "logs",
            this.proxyContainer,
          ]);
          if (stdout.includes("Traefik is ready")) {
            logger.info("Traefik proxy started successfully");
            return true;
          }
        } catch (error) {
          logger.debug(
            `Waiting for Traefik to start (attempt ${attempts + 1}/30)`
          );
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
        attempts++;
      }

      // Get logs if startup failed
      const { stdout: logs } = await executeCommand("docker", [
        "logs",
        this.proxyContainer,
      ]);
      logger.error("Traefik proxy failed to start. Logs:", logs);
      throw new Error("Failed to start Traefik proxy after 30 seconds");
    } catch (error) {
      logger.error("Failed to restart Traefik proxy:", error);
      throw error;
    }
  }

  async ensureComposeFile() {
    try {
      const composeFile = path.join(this.baseDir, "docker-compose.proxy.yml");
      const composeDir = path.dirname(composeFile);

      // Generate auth credentials if not already generated
      if (!this.adminHash) {
        await this.generateSecurePassword();
      }

      // Ensure directory exists with correct permissions
      await fs.mkdir(composeDir, { recursive: true });
      await executeCommand("chown", ["cloudlunacy:docker", composeDir]);
      await executeCommand("chmod", ["775", composeDir]);

      const composeContent = `
version: "3.8"
services:
  traefik-proxy:
    image: traefik:v2.10
    container_name: traefik-proxy
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
      - traefik-proxy
    user: "cloudlunacy:docker"
    environment:
      - TZ=UTC
      - ADMIN_AUTH=admin:${this.adminHash}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.traefik.rule=Host(\`traefik.localhost\`)"
      - "traefik.http.routers.traefik.service=api@internal"
      - "traefik.http.routers.traefik.middlewares=auth-middleware"
      - "traefik.http.middlewares.auth-middleware.basicauth.users=${this.adminHash}"

networks:
  traefik-proxy:
    external: true`;

      // Create middleware configuration
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

    auth-middleware:
      basicAuth:
        users:
          - "${this.adminHash}"
`;

      // Write middleware config
      await fs.writeFile(
        path.join(this.configDir, "dynamic/middleware.yml"),
        middlewareConfig,
        { mode: 0o644 }
      );
      await executeCommand("chown", [
        "cloudlunacy:docker",
        path.join(this.configDir, "dynamic/middleware.yml"),
      ]);

      // Write the compose file
      await fs.writeFile(composeFile, composeContent, { mode: 0o644 });
      await executeCommand("chown", ["cloudlunacy:docker", composeFile]);

      // Save credentials to a file
      const credsFile = path.join(this.configDir, "admin_credentials.txt");
      const credsContent = `
Traefik Dashboard Credentials
----------------------------
Username: admin
Password: ${this.adminPassword}

IMPORTANT: Please save these credentials and delete this file!
`;
      await fs.writeFile(credsFile, credsContent, { mode: 0o600 });
      await executeCommand("chown", ["cloudlunacy:docker", credsFile]);

      logger.info("Admin credentials saved to: " + credsFile);

      return composeFile;
    } catch (error) {
      logger.error("Failed to create docker-compose file:", error);
      throw error;
    }
  }

  async checkDockerAccess() {
    try {
      // Try to run a simple docker command
      await executeCommand("docker", ["info"]);
      return true;
    } catch (error) {
      logger.error("Docker access check failed:", error);

      // Check if user is in docker group
      try {
        const { stdout: groups } = await executeCommand("groups");
        if (!groups.includes("docker")) {
          logger.error(
            "User is not in docker group. Please run: sudo usermod -aG docker cloudlunacy"
          );
        }
      } catch (err) {
        logger.error("Failed to check group membership:", err);
      }

      return false;
    }
  }

  // Add method to generate secure password
  async generateSecurePassword() {
    try {
      // Generate random password
      const password = crypto.randomBytes(16).toString("hex");
      this.adminPassword = password; // Store for later use

      // Generate bcrypt hash
      const salt = bcrypt.genSaltSync(10);
      const hash = bcrypt.hashSync(password, salt);
      this.adminHash = hash; // Store for later use

      return `admin:${hash}`;
    } catch (error) {
      logger.error("Failed to generate secure password:", error);
      throw error;
    }
  }

  // Add method to save admin credentials
  async saveAdminCredentials() {
    try {
      const credsFile = path.join(this.configDir, "admin_credentials.txt");
      const content = `
Initial Traefik Dashboard Credentials
-----------------------------------
Username: admin
Password: ${this.initialAdminPassword}

IMPORTANT: Please change these credentials after first login!
`;

      await fs.writeFile(credsFile, content, { mode: 0o600 });
      await executeCommand("chown", ["cloudlunacy:docker", credsFile]);

      logger.info("Admin credentials saved to:", credsFile);
    } catch (error) {
      logger.error("Failed to save admin credentials:", error);
      throw error;
    }
  }
}

module.exports = new TraefikManager();
