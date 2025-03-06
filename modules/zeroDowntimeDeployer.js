const { executeCommand } = require("../utils/executor");
const logger = require("../utils/logger");
const fs = require("fs").promises;
const path = require("path");
const TemplateHandler = require("../utils/templateHandler");
const { ensureDeploymentPermissions } = require("../utils/permissionCheck");
const apiClient = require("../utils/apiClient");
const EnvironmentManager = require("../utils/environmentManager");
const Joi = require("joi");
const axios = require("axios");
const { execSync } = require("child_process");
const portManager = require("../utils/portManager");

class ZeroDowntimeDeployer {
  constructor() {
    this.healthCheckRetries =
      parseInt(process.env.HEALTH_CHECK_RETRIES, 10) || 5;
    this.healthCheckInterval =
      parseInt(process.env.HEALTH_CHECK_INTERVAL, 10) || 10000;
    this.startupGracePeriod =
      parseInt(process.env.STARTUP_GRACE_PERIOD, 10) || 30000;
    this.rollbackTimeout = parseInt(process.env.ROLLBACK_TIMEOUT, 10) || 180000;
    this.templateHandler = null;
    this.deployBaseDir =
      process.env.DEPLOY_BASE_DIR || "/opt/cloudlunacy/deployments";
    this.templatesDir =
      process.env.TEMPLATES_DIR || "/opt/cloudlunacy/templates";
    this.deploymentLocks = new Set();
    this.STANDARD_CONTAINER_PORT = 8080;
  }

  validatePrerequisites = async () => {
    try {
      await executeCommand("which", ["docker"]);
      await executeCommand("which", ["docker-compose"]);
      await this.validateNetworks();
    } catch (error) {
      throw new Error(`Prerequisite validation failed: ${error.message}`);
    }
  };

  async validateNetworks() {
    try {
      const { stdout: networks } = await executeCommand("docker", [
        "network",
        "ls",
        "--format",
        "{{.Name}}",
      ]);
      if (!networks.includes("traefik-network")) {
        logger.info("Creating traefik-network as it doesn't exist");
        await executeCommand("docker", [
          "network",
          "create",
          "traefik-network",
        ]);
      } else {
        logger.debug("traefik-network exists, continuing deployment");
      }
    } catch (error) {
      throw new Error(`Network validation failed: ${error.message}`);
    }
  }

  async registerWithFrontServer(serviceName, targetUrl, appType) {
    const token = process.env.AGENT_JWT;
    const frontApiUrl = process.env.FRONT_API_URL;

    if (!token) {
      throw new Error(
        "AGENT_JWT is not set - agent not properly registered with front server",
      );
    }
    if (!frontApiUrl) {
      throw new Error(
        "FRONT_API_URL is not set - cannot communicate with front server",
      );
    }

    logger.info(
      `Registering service ${serviceName} with front server at ${frontApiUrl}`,
    );

    // Extract port from target URL
    let actualPort = null;
    try {
      const urlObj = new URL(targetUrl);
      actualPort = parseInt(urlObj.port, 10);
      if (actualPort && !isNaN(actualPort)) {
        await portManager.verifyPortMapping(serviceName, actualPort);
      }
    } catch (err) {
      logger.warn(
        `Could not parse URL ${targetUrl} to extract port: ${err.message}`,
      );
    }

    // Determine the endpoint based on app type
    const endpoint =
      appType.toLowerCase() === "mongo"
        ? `${frontApiUrl}/api/frontdoor/add-subdomain`
        : `${frontApiUrl}/api/frontdoor/add-app`;

    const payload =
      appType.toLowerCase() === "mongo"
        ? { subdomain: serviceName, targetIp: targetUrl.split(":")[0] }
        : { subdomain: serviceName, targetUrl };

    const maxRetries = 5;
    const initialDelay = 1000; // 1 second

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.post(endpoint, payload, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          timeout: 10000,
        });
        logger.info(
          `Service registration successful on attempt ${attempt}:`,
          response.data,
        );
        return response.data;
      } catch (error) {
        const statusCode = error.response?.status;
        const errorData = error.response?.data;
        logger.error(`Registration attempt ${attempt} failed:`, {
          statusCode,
          error: errorData || error.message,
        });
        if ([400, 401, 403].includes(statusCode)) {
          throw new Error(
            `Service registration failed: ${errorData?.message || error.message}`,
          );
        }
        if (attempt === maxRetries) {
          throw new Error(
            `Service registration failed after ${maxRetries} attempts`,
          );
        }
        const delay = initialDelay * Math.pow(2, attempt - 1);
        logger.info(`Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async verifyServiceAccessibility(domain, protocol = "http") {
    logger.info(`Verifying service accessibility at ${protocol}://${domain}`);
    const maxAttempts = 10;
    const retryDelay = 5000;
    const serviceName = domain.split(".")[0];
    let directPortCheck = false;
    let directPort = null;
    if (this.portMap && this.portMap[serviceName]) {
      directPort = this.portMap[serviceName];
      logger.info(`Will also attempt direct port check on port ${directPort}`);
      directPortCheck = true;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await axios.get(`${protocol}://${domain}`, {
          timeout: 5000,
          validateStatus: (status) => status < 500,
        });
        logger.info(
          `Service at ${domain} is accessible (Status: ${response.status})`,
        );
        return true;
      } catch (domainError) {
        logger.warn(
          `Attempt ${attempt}/${maxAttempts}: Service at ${domain} not accessible via domain: ${domainError.message}`,
        );
        if (directPortCheck && directPort) {
          try {
            const LOCAL_IP = execSync("hostname -I | awk '{print $1}'")
              .toString()
              .trim();
            const directUrl = `http://${LOCAL_IP}:${directPort}`;
            logger.info(`Attempting direct port check: ${directUrl}`);
            const directResponse = await axios.get(directUrl, {
              timeout: 3000,
              validateStatus: (status) => status < 500,
            });
            logger.info(
              `Direct port check successful (Status: ${directResponse.status})`,
            );
            logger.warn(
              "Service is accessible directly but not via domain. DNS or front server issue likely.",
            );
            return true;
          } catch (directError) {
            logger.warn(
              `Direct port check also failed: ${directError.message}`,
            );
          }
        }
        if (attempt === maxAttempts) {
          logger.error(
            `Service verification failed after ${maxAttempts} attempts`,
          );
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
    return false;
  }

  /**
   * Switch traffic from the old container to the new container by re-registering
   * the service with the updated target URL. This will update the dynamic configuration
   * and trigger Traefik to route traffic to the new container.
   */
  async switchTraffic(oldContainer, newContainer, domain) {
    const LOCAL_IP = execSync("hostname -I | awk '{print $1}'")
      .toString()
      .trim();
    const newTargetUrl = `http://${LOCAL_IP}:${newContainer.hostPort}`;
    try {
      logger.info(
        `Switching traffic to new container ${newContainer.name} with URL ${newTargetUrl}`,
      );
      // Re-register the service with the updated target URL.
      await this.registerWithFrontServer(
        newContainer.name,
        newTargetUrl,
        "app",
      );
      logger.info(
        `Traffic successfully switched to container ${newContainer.name}`,
      );
    } catch (error) {
      logger.error(`Traffic switch failed: ${error.message}`);
      throw new Error("Traffic switch failed");
    }
  }

  async deploy(payload, ws) {
    const payloadSchema = Joi.object({
      deploymentId: Joi.string().required(),
      appType: Joi.string().required(),
      appName: Joi.string().required(),
      repositoryOwner: Joi.string().required(),
      repositoryName: Joi.string().required(),
      branch: Joi.string().required(),
      githubToken: Joi.string().required(),
      environment: Joi.string().required(),
      serviceName: Joi.string().required(),
      domain: Joi.string().required(),
      envVarsToken: Joi.string().required(),
      targetUrl: Joi.string().optional(),
    });

    const { error, value } = payloadSchema.validate(payload);
    if (error) {
      logger.error(`Invalid payload: ${error.message}`);
      this.sendError(ws, {
        deploymentId: payload.deploymentId || "unknown",
        status: "failed",
        message: `Invalid payload: ${error.message}`,
      });
      return;
    }

    const {
      deploymentId,
      appType,
      appName,
      repositoryOwner,
      repositoryName,
      branch,
      githubToken,
      environment,
      serviceName,
      domain,
      envVarsToken,
      targetUrl,
    } = value;
    logger.info("Deploying with payload:", value);

    const LOCAL_IP = execSync("hostname -I | awk '{print $1}'")
      .toString()
      .trim();
    let finalDomain = domain;

    // Initialize port manager and allocate a host port for this service
    await portManager.initialize();
    const { hostPort, containerPort } =
      await portManager.allocatePort(serviceName);

    if (appType.toLowerCase() === "mongo") {
      finalDomain = `${serviceName}.${process.env.MONGO_DOMAIN}`;
    } else {
      finalDomain = `${serviceName}.${process.env.APP_DOMAIN}`;
      const resolvedTargetUrl = `http://${LOCAL_IP}:${hostPort}`;

      try {
        await this.registerWithFrontServer(
          serviceName,
          resolvedTargetUrl,
          appType,
        );
        const isAccessible = await this.verifyServiceAccessibility(finalDomain);
        if (!isAccessible) {
          logger.warn(
            `Service at ${finalDomain} is not yet accessible, but deployment will continue`,
          );
        } else {
          logger.info(
            `Service at ${finalDomain} is accessible and properly routed`,
          );
        }
      } catch (err) {
        logger.error(
          `Failed to register service with front server: ${err.message}`,
        );
        logger.warn("Continuing deployment despite front API error");
      }
    }

    const serviceLockKey = `${serviceName}-${environment}`;
    if (this.deploymentLocks.has(serviceLockKey)) {
      const msg = `Deployment already in progress for ${serviceName} in ${environment}`;
      logger.warn(msg);
      this.sendError(ws, { deploymentId, status: "failed", message: msg });
      return;
    }
    this.deploymentLocks.add(serviceLockKey);

    const projectName = `${deploymentId}-${appName}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    const deployDir = path.join(this.deployBaseDir, deploymentId);
    const backupDir = path.join(deployDir, "backup");

    let oldContainer = null;
    let newContainer = null;
    let rollbackNeeded = false;
    let envManager = null;

    try {
      await ensureDeploymentPermissions();
      await this.validatePrerequisites();
      await this.setupDirectories(deployDir, backupDir);

      envManager = new EnvironmentManager(deployDir);
      const envVars = await this.fetchEnvironmentVariables(
        deploymentId,
        envVarsToken,
      );
      const envFilePath = await envManager.writeEnvFile(envVars, environment);

      await this.cloneRepository(
        deployDir,
        repositoryOwner,
        repositoryName,
        branch,
        githubToken,
      );

      oldContainer = await this.getCurrentContainer(serviceName);
      if (oldContainer) await this.backupCurrentState(oldContainer, backupDir);

      const blueGreenLabel = oldContainer ? "green" : "blue";
      const newContainerName = `${serviceName}-${blueGreenLabel}`;

      newContainer = await this.buildAndStartContainer({
        projectName,
        serviceName: newContainerName,
        deployDir,
        domain: finalDomain,
        envFilePath,
        environment,
        hostPort,
        containerPort,
        payload: value,
        ws,
      });

      await envManager.verifyEnvironmentSetup(newContainer.name);
      await this.performHealthCheck(newContainer);

      // Switch traffic from the old container (if any) to the new container.
      await this.switchTraffic(oldContainer, newContainer, finalDomain);

      if (oldContainer) {
        await this.gracefulContainerRemoval(
          oldContainer,
          deployDir,
          projectName,
        );
      }

      if (newContainer) {
        logger.info(`Verifying service accessibility at ${finalDomain}...`);
        const isAccessible = await this.verifyServiceAccessibility(finalDomain);
        if (isAccessible) {
          logger.info(`Service at ${finalDomain} is confirmed accessible`);
        } else {
          logger.warn(
            `Service deployed but may not be accessible at ${finalDomain}`,
          );
        }
      }

      this.sendSuccess(ws, {
        deploymentId,
        status: "success",
        message: "Deployment completed",
        domain: finalDomain,
      });
    } catch (error) {
      logger.error(`Deployment ${deploymentId} failed:`, error);
      rollbackNeeded = true;
      try {
        if (rollbackNeeded && oldContainer)
          await this.performRollback(oldContainer, newContainer, finalDomain);
      } catch (rollbackError) {
        logger.error("Rollback failed:", rollbackError);
      }
      this.sendError(ws, {
        deploymentId,
        status: "failed",
        message: error.message,
      });
    } finally {
      this.deploymentLocks.delete(serviceLockKey);
      if (!rollbackNeeded) await this.cleanup(deployDir, rollbackNeeded);
    }
  }

  async gracefulContainerRemoval(container, deployDir, projectName) {
    try {
      await executeCommand(
        "docker-compose",
        ["-p", projectName, "down", "-v"],
        { cwd: deployDir },
      );
    } catch (error) {
      throw new Error(
        `Failed to remove container ${container.name}: ${error.message}`,
      );
    }
  }

  async fetchEnvironmentVariables(deploymentId, envVarsToken) {
    try {
      const response = await apiClient.post(
        `/api/deploy/env-vars/${deploymentId}`,
        { token: envVarsToken },
      );
      return response.data.variables;
    } catch (error) {
      logger.warn(`Could not fetch environment variables: ${error.message}`);
      return null;
    }
  }

  async setupDirectories(deployDir, backupDir) {
    try {
      await fs.mkdir(deployDir, { recursive: true });
      await fs.mkdir(backupDir, { recursive: true });
    } catch (error) {
      throw new Error(`Directory setup failed: ${error.message}`);
    }
  }

  async cloneRepository(deployDir, repoOwner, repoName, branch, githubToken) {
    const repoUrl = `https://x-access-token:${githubToken}@github.com/${repoOwner}/${repoName}.git`;
    const tempDir = path.join(
      path.dirname(deployDir),
      `${path.basename(deployDir)}_temp_${Date.now()}`,
    );
    try {
      await executeCommand("git", [
        "clone",
        "-b",
        branch,
        "--depth",
        "1",
        repoUrl,
        tempDir,
      ]);
      const files = await fs.readdir(tempDir);
      for (const file of files) {
        const srcPath = path.join(tempDir, file);
        const destPath = path.join(deployDir, file);
        const stat = await fs.lstat(srcPath);
        if (stat.isDirectory()) {
          await fs.cp(srcPath, destPath, { recursive: true, force: true });
        } else {
          await fs.copyFile(srcPath, destPath);
        }
      }
    } finally {
      if (await this.directoryExists(tempDir)) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }
  }

  async backupCurrentState(container, backupDir) {
    try {
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .toLowerCase();
      const backupName = `backup-${container.name}-${timestamp}`;
      await executeCommand("docker", ["commit", container.id, backupName]);
      const backupMetadata = {
        containerId: container.id,
        containerName: container.name,
        timestamp: new Date().toISOString(),
        backupName,
      };
      await fs.writeFile(
        path.join(backupDir, "backup-metadata.json"),
        JSON.stringify(backupMetadata, null, 2),
      );
    } catch (error) {
      logger.warn(`Backup failed: ${error.message}`);
    }
  }

  async getCurrentContainer(serviceName) {
    try {
      const { stdout } = await executeCommand("docker", [
        "ps",
        "-q",
        "--filter",
        `name=${serviceName}`,
      ]);
      const containerId = stdout.trim();
      if (!containerId) return null;
      const { stdout: containerInfo } = await executeCommand("docker", [
        "inspect",
        containerId,
        "--format",
        "{{.Name}} {{.Id}} {{.State.Status}}",
      ]);
      const [name, id, status] = containerInfo.trim().split(" ");
      return { name: name.replace("/", ""), id, status };
    } catch (error) {
      return null;
    }
  }

  async performHealthCheck(container) {
    let healthy = false;
    let attempts = 0;
    while (!healthy && attempts < this.healthCheckRetries) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.healthCheckInterval),
      );
      try {
        const { stdout } = await executeCommand("docker", [
          "inspect",
          "--format",
          "{{.State.Health.Status}}",
          container.id,
        ]);
        if (stdout.trim() === "healthy") {
          healthy = true;
          break;
        }
      } catch (error) {
        attempts++;
      }
    }
    if (!healthy) throw new Error("Container failed health checks");
  }

  /**
   * Build and start the container, returning an object with additional properties
   * (hostPort and containerPort) needed for traffic switching.
   */
  async buildAndStartContainer({
    projectName,
    serviceName,
    deployDir,
    domain,
    envFilePath,
    environment,
    hostPort,
    containerPort,
    payload,
    ws,
  }) {
    try {
      // First, stop and remove any existing container with the same service name
      // This is critical to free up the port before starting the new container
      const { stdout: existingId } = await executeCommand("docker", [
        "ps",
        "-a",
        "-q",
        "--filter",
        `name=^/${serviceName}$`,
      ]);

      if (existingId && existingId.trim()) {
        logger.info(
          `Found existing container ${serviceName} (${existingId.trim()}). Stopping and removing it...`,
        );
        // Stop the container first to ensure a clean shutdown
        await executeCommand("docker", ["stop", existingId.trim()]);
        // Then remove it after it's stopped
        await executeCommand("docker", ["rm", existingId.trim()]);

        // Add a small delay to ensure the port is fully released
        logger.info(`Waiting for port to be released...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      // Check if the port is actually free now
      try {
        const { stdout: portCheck } = await executeCommand("lsof", [
          "-i",
          `:${hostPort}`,
        ]);

        if (portCheck.trim()) {
          logger.warn(
            `Port ${hostPort} is still in use after container removal. Details: ${portCheck}`,
          );
          // We might need to force kill processes using this port or pick a different port
        }
      } catch (portCheckError) {
        // lsof returning nothing is actually good - it means the port is free
        logger.info(`Port ${hostPort} is available for use`);
      }

      // Generate the deployment files from templates
      if (!this.templateHandler) {
        this.templateHandler = new TemplateHandler(
          this.templatesDir,
          require("../deployConfig.json"),
        );
      }

      const files = await this.templateHandler.generateDeploymentFiles({
        appType: payload.appType,
        appName: serviceName,
        environment,
        hostPort,
        containerPort,
        domain,
        envFile: path.basename(envFilePath),
        health: {
          checkPath: "/health",
          interval: "30s",
          timeout: "5s",
          retries: 3,
          start_period: "40s",
        },
      });

      await Promise.all([
        fs.writeFile(path.join(deployDir, "Dockerfile"), files.dockerfile),
        fs.writeFile(
          path.join(deployDir, "docker-compose.yml"),
          files.dockerCompose,
        ),
      ]);

      // Build and start the new container
      await executeCommand(
        "docker-compose",
        ["-p", projectName, "build", "--no-cache"],
        { cwd: deployDir },
      );

      await executeCommand("docker-compose", ["-p", projectName, "up", "-d"], {
        cwd: deployDir,
      });

      const { stdout: newContainerId } = await executeCommand(
        "docker-compose",
        ["-p", projectName, "ps", "-q", serviceName],
        { cwd: deployDir },
      );

      return {
        id: newContainerId.trim(),
        name: serviceName,
        hostPort,
        containerPort,
      };
    } catch (error) {
      throw new Error(`Failed to build/start container: ${error.message}`);
    }
  }
  async performRollback(oldContainer, newContainer, domain) {
    try {
      if (newContainer) {
        await executeCommand("docker-compose", [
          "-p",
          newContainer.name,
          "down",
          "-v",
        ]);
      }
      if (oldContainer) {
        const backupMetadataPath = path.join(
          "/opt/cloudlunacy/deployments",
          oldContainer.name,
          "backup",
          "backup-metadata.json",
        );
        if (await this.fileExists(backupMetadataPath)) {
          const backupMetadata = JSON.parse(
            await fs.readFile(backupMetadataPath, "utf-8"),
          );
          await executeCommand("docker", [
            "run",
            "-d",
            "--name",
            backupMetadata.containerName,
            backupMetadata.backupName,
          ]);
          await this.performHealthCheck({
            id: backupMetadata.containerId,
            name: backupMetadata.containerName,
          });
        }
      }
    } catch (error) {
      throw new Error(`Failed to restore old container: ${error.message}`);
    }
  }

  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async sendSuccess(ws, data) {
    if (ws?.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "status",
          payload: { ...data, timestamp: new Date().toISOString() },
        }),
      );
    }
  }

  async sendError(ws, data) {
    if (ws?.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "error",
          payload: { ...data, timestamp: new Date().toISOString() },
        }),
      );
    }
  }

  async cleanup(deployDir, keepBackup = false) {
    try {
      if (!keepBackup) {
        const backupDir = path.join(deployDir, "backup");
        if (await this.directoryExists(backupDir)) {
          await fs.rm(backupDir, { recursive: true, force: true });
        }
      }
    } catch (error) {
      logger.warn(`Cleanup error: ${error.message}`);
    }
  }

  async directoryExists(dir) {
    try {
      await fs.access(dir);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = new ZeroDowntimeDeployer();
