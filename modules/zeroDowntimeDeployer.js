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

  async registerWithFrontServer(serviceName, targetUrl) {
    try {
      const frontApiUrl = process.env.FRONT_API_URL;
      const agentId = process.env.SERVER_ID;
      const jwt = process.env.AGENT_JWT;

      if (!frontApiUrl || !jwt || !agentId) {
        logger.warn(
          "Missing FRONT_API_URL, AGENT_JWT, or SERVER_ID - cannot register with front server",
        );
        return {
          success: false,
          message: "Missing required environment variables",
        };
      }

      logger.info(`Registering ${serviceName} with Traefik front server...`);

      // Use the Traefik API endpoint for HTTP routes only
      const response = await axios.post(
        `${frontApiUrl}/api/proxy/http`,
        {
          agentId,
          subdomain: serviceName,
          targetUrl,
          options: {
            useTls: true,
            check: true,
          },
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
        },
      );

      if (response.data && response.data.success) {
        logger.info(
          `Service ${serviceName} registered successfully with domain: ${response.data.domain}`,
        );
        return {
          success: true,
          domain: response.data.domain,
          message: "Service registered successfully with Traefik",
        };
      } else {
        const errorMessage =
          response.data.message || "Unknown error from front server";
        logger.warn(`Failed to register service: ${errorMessage}`);
        return { success: false, message: errorMessage };
      }
    } catch (error) {
      logger.error(`Failed to register with front server: ${error.message}`);

      // Provide more detailed error information for troubleshooting
      if (error.response) {
        logger.error(`Response status: ${error.response.status}`);
        logger.error(`Response data: ${JSON.stringify(error.response.data)}`);
      }

      return { success: false, message: `Error: ${error.message}` };
    }
  }

  async verifyServiceAccessibility(domain, protocol = "http") {
    try {
      const frontApiUrl = process.env.FRONT_API_URL;
      const jwt = process.env.AGENT_JWT;
      if (!frontApiUrl || !jwt) {
        logger.warn(
          "Missing FRONT_API_URL or AGENT_JWT, skipping service accessibility verification",
        );
        return true;
      }

      logger.info(
        `Verifying service accessibility through Traefik for ${domain}`,
      );

      // Get the base service name from domain (remove the .apps.cloudlunacy.uk part)
      const baseServiceName = domain.split(".")[0];
      logger.info(`Base service name: ${baseServiceName}`);

      try {
        // Query the front server API to check if the service is configured
        const response = await axios.get(`${frontApiUrl}/api/proxy/routes`, {
          headers: {
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
          },
        });

        // Check if the subdomain is in the list
        if (response.data && response.data.routes) {
          const serviceFound = response.data.routes.some(
            (route) => route.subdomain === baseServiceName,
          );

          if (serviceFound) {
            logger.info(
              `Service ${baseServiceName} is accessible through Traefik`,
            );
            return true;
          } else {
            logger.warn(
              `Service ${baseServiceName} is not configured in Traefik`,
            );
            return false;
          }
        } else {
          logger.warn("Invalid response from Traefik routes API");
          return false;
        }
      } catch (apiError) {
        logger.error(
          `Error checking Traefik configuration: ${apiError.message}`,
        );
        return false;
      }
    } catch (error) {
      logger.error(
        `Service accessibility verification failed: ${error.message}`,
      );
      return false;
    }
  }

  async switchTraffic(oldContainer, newContainer, baseServiceName) {
    const LOCAL_IP = execSync("hostname -I | awk '{print $1}'")
      .toString()
      .trim();

    // Log the container objects to help with debugging
    logger.info(`Old container: ${JSON.stringify(oldContainer || {})}`);
    logger.info(`New container: ${JSON.stringify(newContainer || {})}`);

    // Ensure we have the hostPort property and it's a number
    if (!newContainer || typeof newContainer.hostPort !== "number") {
      logger.error(
        `Invalid new container object or missing hostPort: ${JSON.stringify(newContainer)}`,
      );
      throw new Error(
        "Cannot switch traffic: new container is invalid or missing port information",
      );
    }

    const newTargetUrl = `http://${LOCAL_IP}:${newContainer.hostPort}`;

    try {
      logger.info(
        `Preparing to switch traffic to new container with target URL ${newTargetUrl} using base name ${baseServiceName}`,
      );

      // 1. Verify the new container's health before switching traffic
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

      // Verify we have the actual port
      const baseServiceNameWithoutSuffix = baseServiceName.replace(
        /-blue$|-green$/,
        "",
      );
      const { portMapping } = await portManager.verifyPortMapping(
        baseServiceNameWithoutSuffix,
        newContainer.hostPort,
      );
      logger.info(
        `Verified port mapping for ${baseServiceNameWithoutSuffix}: ${portMapping}`,
      );

      // 2. Register the new target with the front server using the base service name
      logger.info(
        `Registering new target URL: ${newTargetUrl} for base service name: ${baseServiceName}`,
      );
      await this.registerWithFrontServer(baseServiceName, newTargetUrl);

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
              `${frontApiUrl}/api/proxy/routes`,
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
          `Traffic successfully switched to container ${newContainer.name} on port ${newContainer.hostPort}`,
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

    // Early return for database deployments - MessageHandler should handle this,
    // but this is an additional safety check
    if (["mongodb", "mongo"].includes(value.appType.toLowerCase())) {
      logger.warn(
        `Received database deployment request for ${value.appType}, but ZeroDowntimeDeployer should not handle this`,
      );
      this.sendError(ws, {
        deploymentId: value.deploymentId,
        status: "failed",
        message:
          "Database deployments should be handled by the database controller",
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

    // Application-specific domain only
    let finalDomain = `${serviceName}.${process.env.APP_DOMAIN}`;

    // Initialize port manager and allocate a host port for this service
    await portManager.initialize();
    const { hostPort, containerPort } =
      await portManager.allocatePort(serviceName);
    logger.info("🚀 ~ ZeroDowntimeDeployer ~ deploy ~ hostPort:", hostPort);

    // Register the application with the front server
    const resolvedTargetUrl = `http://${LOCAL_IP}:${hostPort}`;
    logger.info(
      "🚀 ~ ZeroDowntimeDeployer ~ deploy ~ resolvedTargetUrl:",
      resolvedTargetUrl,
    );

    try {
      await this.registerWithFrontServer(serviceName, resolvedTargetUrl);
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

      if (oldContainer && oldContainer.id !== newContainer.id) {
        logger.info(
          `Removing old container ${oldContainer.name} (${oldContainer.id})`,
        );
        await this.gracefulContainerRemoval(oldContainer);
      } else {
        logger.info(
          "No old container to remove or old container is the same as new",
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
      logger.info(
        `Gracefully removing old container ${container.name} (${container.id})`,
      );

      // Remove ONLY the specified container, not the entire project
      await executeCommand("docker", ["stop", container.id]);
      await executeCommand("docker", ["rm", container.id]);

      logger.info(`Successfully removed old container ${container.name}`);
      return true;
    } catch (error) {
      logger.warn(
        `Failed to remove container ${container.name}: ${error.message}`,
      );
      return false;
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

      // Verify the actual port used by the container
      logger.info(
        `Verifying actual port for container ${newContainerId.trim()}`,
      );
      try {
        const { stdout: portMappings } = await executeCommand("docker", [
          "port",
          newContainerId.trim(),
        ]);

        logger.info(`Container port mappings: ${portMappings}`);

        // Parse the port mappings to find the actual port
        const hostPortMatch = portMappings.match(/0\.0\.0\.0:(\d+)/);
        if (hostPortMatch && hostPortMatch[1]) {
          const actualPort = parseInt(hostPortMatch[1], 10);

          if (actualPort !== hostPort) {
            logger.warn(
              `Port mismatch detected! Expected ${hostPort} but container is using ${actualPort}`,
            );

            // Update port manager with actual port
            await portManager.verifyPortMapping(
              serviceName.replace(/-blue$|-green$/, ""),
              actualPort,
            );

            // Use the actual port instead of the expected one
            hostPort = actualPort;
          }
        }
      } catch (portCheckError) {
        logger.warn(
          `Error checking container port mappings: ${portCheckError.message}`,
        );
      }

      return {
        id: newContainerId.trim(),
        name: serviceName,
        hostPort, // This is now guaranteed to be the actual port used
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
