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
        ? {
            subdomain: serviceName,
            targetIp: targetUrl.split(":")[0],
          }
        : {
            subdomain: serviceName,
            targetUrl: targetUrl,
            protocol: "http",
          };

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

  async switchTraffic(oldContainer, newContainer, baseServiceName) {
    const LOCAL_IP = execSync("hostname -I | awk '{print $1}'")
      .toString()
      .trim();
    const newTargetUrl = `http://${LOCAL_IP}:${newContainer.hostPort}`;

    try {
      logger.info(
        `Preparing to switch traffic to new container with target URL ${newTargetUrl} using base name ${baseServiceName}`,
      );

      // 1. Verify the new container’s health before switching traffic
      logger.info("Verifying new container health before switching traffic...");
      try {
        const healthCheck = await axios.get(`${newTargetUrl}/health`, {
          timeout: 5000,
          validateStatus: (status) => status < 500,
        });
        logger.info(
          `Health check for new container succeeded with status: ${healthCheck.status}`,
        );
      } catch (healthErr) {
        logger.warn(
          `Health check failed, but will continue with traffic switch: ${healthErr.message}`,
        );
      }

      // 2. Register the new target with the front server using the base service name
      logger.info(
        `Registering new target URL: ${newTargetUrl} for base service name: ${baseServiceName}`,
      );
      await this.registerWithFrontServer(baseServiceName, newTargetUrl, "app");

      // 3. Wait briefly to ensure the configuration update propagates
      logger.info("Waiting for configuration to propagate...");
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 4. Verify the traffic switch actually worked
      logger.info("Verifying new routing configuration...");
      let switchSuccessful = false;
      let retryCount = 0;
      while (!switchSuccessful && retryCount < 3) {
        try {
          const frontApiUrl = process.env.FRONT_API_URL;
          const token = process.env.AGENT_JWT;
          if (frontApiUrl && token) {
            const routeCheck = await axios.get(
              `${frontApiUrl}/api/frontdoor/config`,
              {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 5000,
              },
            );
            const configStr = JSON.stringify(routeCheck.data);
            if (configStr.includes(baseServiceName)) {
              logger.info(
                "Route verification successful: base service name found in configuration",
              );
              switchSuccessful = true;
              break;
            } else {
              logger.warn(
                "Route verification failed: base service name not found in configuration",
              );
              retryCount++;
              await new Promise((resolve) => setTimeout(resolve, 2000));
            }
          } else {
            logger.info(
              "Missing front API URL or token, skipping route verification",
            );
            switchSuccessful = true;
            break;
          }
        } catch (verifyErr) {
          logger.warn(
            `Route verification request failed: ${verifyErr.message}`,
          );
          retryCount++;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      if (switchSuccessful) {
        logger.info(
          `Traffic successfully switched to container ${newContainer.name}`,
        );
        return true;
      } else {
        logger.warn(
          "Traffic switch may not have completed successfully, but will continue deployment",
        );
        return false;
      }
    } catch (error) {
      logger.error(`Traffic switch failed: ${error.message}`);
      throw new Error(`Traffic switch failed: ${error.message}`);
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
    logger.info("🚀 ~ ZeroDowntimeDeployer ~ deploy ~ hostPort:", hostPort);

    if (appType.toLowerCase() === "mongo") {
      finalDomain = `${serviceName}.${process.env.MONGO_DOMAIN}`;
    } else {
      finalDomain = `${serviceName}.${process.env.APP_DOMAIN}`;
      const resolvedTargetUrl = `http://${LOCAL_IP}:${hostPort}`;
      logger.info(
        "🚀 ~ ZeroDowntimeDeployer ~ deploy ~ resolvedTargetUrl:",
        resolvedTargetUrl,
      );
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
      await this.switchTraffic(oldContainer, newContainer, serviceName);

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
      // First, aggressively clean up any containers using our service name
      logger.info(
        `Cleaning up any existing containers with name ${serviceName}`,
      );

      try {
        // Find ALL containers (including stopped ones) with this service name
        const { stdout: containerList } = await executeCommand("docker", [
          "ps",
          "-a",
          "--format",
          "{{.ID}}",
          "--filter",
          `name=${serviceName}`,
        ]);

        const containerIds = containerList.trim().split("\n").filter(Boolean);

        if (containerIds.length > 0) {
          logger.info(
            `Found ${containerIds.length} containers to clean up: ${containerIds.join(", ")}`,
          );

          // Force stop and remove each container
          for (const id of containerIds) {
            try {
              await executeCommand("docker", ["stop", "-t", "0", id]); // Force immediate stop
              await executeCommand("docker", ["rm", "-f", id]); // Force removal
            } catch (cleanupError) {
              logger.warn(
                `Error during container cleanup: ${cleanupError.message}`,
              );
            }
          }

          // Add a delay to ensure Docker networking fully releases the port
          logger.info("Waiting for port resources to be fully released...");
          await new Promise((resolve) => setTimeout(resolve, 3000));
        } else {
          logger.info("No existing containers found with this service name.");
        }
      } catch (listError) {
        logger.warn(`Error while listing containers: ${listError.message}`);
      }

      // Check if the assigned port is truly available
      let portAvailable = false;
      let retries = 0;
      const maxRetries = 3;

      while (!portAvailable && retries < maxRetries) {
        try {
          const { stdout: portCheck } = await executeCommand("lsof", [
            "-i",
            `:${hostPort}`,
          ]);

          if (portCheck.trim()) {
            logger.warn(
              `Port ${hostPort} is still in use after cleanup. Details: ${portCheck}`,
            );

            if (retries < maxRetries - 1) {
              retries++;
              logger.info(
                `Retrying port check in 3 seconds... (Attempt ${retries}/${maxRetries})`,
              );
              await new Promise((resolve) => setTimeout(resolve, 3000));
            } else {
              // Find an alternative port as last resort
              logger.info(
                `Port ${hostPort} still unavailable, finding an alternative port...`,
              );
              const portManager = require("../utils/portManager");
              hostPort = await portManager.findFreePort(10000, 30000, hostPort);
              logger.info(`Using alternative port: ${hostPort}`);
              portAvailable = true;
            }
          } else {
            logger.info(`Port ${hostPort} is available`);
            portAvailable = true;
          }
        } catch (portCheckError) {
          // lsof error usually means port is available
          logger.info(
            `Port ${hostPort} appears to be available (no process using it)`,
          );
          portAvailable = true;
        }
      }

      // Now generate deployment files with updated port if necessary
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
        hostPort, // This may be a new port if we had to find an alternative
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

      // Write the files
      await Promise.all([
        fs.writeFile(path.join(deployDir, "Dockerfile"), files.dockerfile),
        fs.writeFile(
          path.join(deployDir, "docker-compose.yml"),
          files.dockerCompose,
        ),
      ]);

      // Build and start the container
      logger.info(`Building container with project name ${projectName}...`);
      await executeCommand(
        "docker-compose",
        ["-p", projectName, "build", "--no-cache"],
        { cwd: deployDir },
      );

      logger.info(`Starting container on port ${hostPort}...`);
      await executeCommand("docker-compose", ["-p", projectName, "up", "-d"], {
        cwd: deployDir,
      });

      // Get the new container ID
      const { stdout: newContainerId } = await executeCommand(
        "docker-compose",
        ["-p", projectName, "ps", "-q", serviceName],
        { cwd: deployDir },
      );

      if (!newContainerId.trim()) {
        throw new Error(
          "Failed to get new container ID - container may not have started properly",
        );
      }

      logger.info(
        `Container started successfully with ID: ${newContainerId.trim()}`,
      );

      // If we used an alternative port, update the port manager's records
      if (hostPort !== containerPort) {
        const portManager = require("../utils/portManager");
        await portManager.verifyPortMapping(serviceName, hostPort);
      }

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
