const { executeCommand } = require("../utils/executor");
const logger = require("../utils/logger");
const fs = require("fs").promises;
const path = require("path");
const TemplateHandler = require("../utils/templateHandler");
const NixpacksBuilder = require("../utils/nixpacksBuilder");
const { ensureDeploymentPermissions } = require("../utils/permissionCheck");
const apiClient = require("../utils/apiClient");
const EnvironmentManager = require("../utils/environmentManager");
const Joi = require("joi");
const axios = require("axios");
const { execSync } = require("child_process");
const portManager = require("../utils/portManager");
const queueService = require("../src/services/queueService");
const repositoryController = require("../src/controllers/repositoryController");

class ZeroDowntimeDeployer {
  constructor() {
    this.healthCheckRetries =
      parseInt(process.env.HEALTH_CHECK_RETRIES, 10) || 3; // Reduced from 5
    this.healthCheckInterval =
      parseInt(process.env.HEALTH_CHECK_INTERVAL, 10) || 5000; // Reduced from 10000
    this.startupGracePeriod =
      parseInt(process.env.STARTUP_GRACE_PERIOD, 10) || 20000; // Reduced from 30000
    this.rollbackTimeout = parseInt(process.env.ROLLBACK_TIMEOUT, 10) || 120000; // Reduced from 180000
    this.templateHandler = null;
    this.deployBaseDir =
      process.env.DEPLOY_BASE_DIR || "/opt/cloudlunacy/deployments";
    this.templatesDir =
      process.env.TEMPLATES_DIR || "/opt/cloudlunacy/templates";
    this.deploymentLocks = new Set();
    this.STANDARD_CONTAINER_PORT = 8080;
    this.useNixpacks = true;
    // this.useNixpacks = process.env.USE_NIXPACKS === "true";
    this.nixpacksConfigDir =
      process.env.NIXPACKS_CONFIG_DIR ||
      path.join(this.templatesDir, "nixpacks");
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

  async registerWithFrontServer(
    serviceName,
    targetUrl,
    jobId = null,
    projectId = null,
  ) {
    try {
      const frontApiUrl = process.env.FRONT_API_URL;
      const agentId = process.env.SERVER_ID;
      const jwt = process.env.AGENT_JWT;

      if (!frontApiUrl || !jwt || !agentId) {
        logger.warn(
          "Missing FRONT_API_URL, AGENT_JWT, or SERVER_ID - cannot register with front server",
        );
        const result = {
          success: false,
          message: "Missing required environment variables",
        };

        // Notify backend via queue if jobId is provided
        if (jobId) {
          await this.notifyQueueOnRegistration(
            jobId,
            serviceName,
            null,
            result,
            projectId,
          );
        }

        return result;
      }

      // Generate the expected domain format on the agent side
      const expectedDomain = `${serviceName}.${process.env.APP_DOMAIN || "apps.cloudlunacy.uk"}`;

      logger.info(`Registering ${serviceName} with Traefik front server...`);
      logger.info(`Expected domain: ${expectedDomain}`);

      // Use the Traefik API endpoint for HTTP routes only
      const response = await axios.post(
        `${frontApiUrl}/api/proxy/http`,
        {
          agentId,
          subdomain: serviceName,
          targetUrl,
          expectedDomain, // Pass the expected domain to the front server
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
        // Use the domain from response if available, otherwise use our expected domain
        const finalDomain = response.data.domain || expectedDomain;

        logger.info(
          `Service ${serviceName} registered successfully with domain: ${finalDomain}`,
        );

        // Give Traefik a moment to reload its configuration after route registration
        logger.info("Waiting for Traefik to reload configuration...");
        await new Promise((resolve) => setTimeout(resolve, 3000)); // 3 second delay

        const result = {
          success: true,
          domain: finalDomain,
          message: "Service registered successfully with Traefik",
        };

        // Notify backend via queue if jobId is provided
        if (jobId) {
          await this.notifyQueueOnRegistration(
            jobId,
            serviceName,
            response.data,
            result,
          );
        }

        return result;
      } else {
        const errorMessage =
          response.data.message || "Unknown error from front server";
        logger.warn(`Failed to register service: ${errorMessage}`);

        // Even if registration failed, we can still provide the expected domain
        const result = {
          success: false,
          message: errorMessage,
          domain: expectedDomain, // Include the expected domain even on failure
        };

        // Notify backend via queue if jobId is provided
        if (jobId) {
          await this.notifyQueueOnRegistration(
            jobId,
            serviceName,
            response.data,
            result,
          );
        }

        return result;
      }
    } catch (error) {
      logger.error(`Failed to register with front server: ${error.message}`);

      // Provide more detailed error information for troubleshooting
      if (error.response) {
        logger.error(`Response status: ${error.response.status}`);
        logger.error(`Response data: ${JSON.stringify(error.response.data)}`);
      }

      const expectedDomain = `${serviceName}.${process.env.APP_DOMAIN || "apps.cloudlunacy.uk"}`;
      const result = {
        success: false,
        message: `Error: ${error.message}`,
        domain: expectedDomain, // Provide the expected domain even on error
      };

      // Notify backend via queue if jobId is provided
      if (jobId) {
        await this.notifyQueueOnRegistration(jobId, serviceName, null, result);
      }

      return result;
    }
  }

  async verifyServiceAccessibility(
    domain,
    protocol = "http",
    maxRetries = 3,
    retryDelay = 2000,
  ) {
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

      // Retry mechanism to handle Traefik routing table update delays
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          logger.info(
            `Verification attempt ${attempt}/${maxRetries} for ${baseServiceName}`,
          );

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
                `Service ${baseServiceName} is accessible through Traefik (verified on attempt ${attempt})`,
              );
              return true;
            } else {
              logger.warn(
                `Service ${baseServiceName} not found in Traefik routes (attempt ${attempt}/${maxRetries})`,
              );

              // If this isn't the last attempt, wait before retrying
              if (attempt < maxRetries) {
                logger.info(`Waiting ${retryDelay}ms before retry...`);
                await new Promise((resolve) => setTimeout(resolve, retryDelay));
              }
            }
          } else {
            logger.warn(
              `Invalid response from Traefik routes API (attempt ${attempt}/${maxRetries})`,
            );

            // If this isn't the last attempt, wait before retrying
            if (attempt < maxRetries) {
              logger.info(`Waiting ${retryDelay}ms before retry...`);
              await new Promise((resolve) => setTimeout(resolve, retryDelay));
            }
          }
        } catch (apiError) {
          logger.error(
            `Error checking Traefik configuration (attempt ${attempt}/${maxRetries}): ${apiError.message}`,
          );

          // If this isn't the last attempt, wait before retrying
          if (attempt < maxRetries) {
            logger.info(`Waiting ${retryDelay}ms before retry...`);
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
          }
        }
      }

      // All retries exhausted
      logger.warn(
        `Service ${baseServiceName} verification failed after ${maxRetries} attempts - service may still be accessible`,
      );
      return false;
    } catch (error) {
      logger.error(
        `Service accessibility verification failed: ${error.message}`,
      );
      return false;
    }
  }

  async switchTraffic(
    oldContainer,
    newContainer,
    baseServiceName,
    jobId = null,
    projectId = null,
  ) {
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

      // Don't pass jobId here - we only want to send job completion notification once at the end
      await this.registerWithFrontServer(
        baseServiceName,
        newTargetUrl,
        null, // Don't send job notification during traffic switching
        projectId,
      );

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
      jobId: Joi.string().optional(), // Optional jobId for API calls that need it
      projectId: Joi.string().optional(), // Optional projectId to track which project this deployment belongs to
      appType: Joi.string().required(),
      autoDetectAppType: Joi.boolean().default(true), // Enable auto-detection of app type
      repositoryUrl: Joi.string().required(),
      branch: Joi.string(),
      githubToken: Joi.string().required(),
      environment: Joi.string().default("production"),
      serviceName: Joi.string().required(),
      domain: Joi.string().optional(), // Domain is optional - will be generated from serviceName
      envVarsToken: Joi.string().required(),
      additionalPorts: Joi.array()
        .items(
          Joi.object({
            port: Joi.number().required(),
            hostPort: Joi.number().optional(),
          }),
        )
        .optional(),
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
      autoDetectAppType,
      repositoryUrl,
      branch,
      githubToken,
      environment,
      serviceName,
      domain,
      envVarsToken,
      additionalPorts,
    } = value;

    // Extract repository owner and name from URL for git operations
    const repoMatch = repositoryUrl.match(
      /github\.com\/([^\/]+)\/([^\.\/]+)(\.git)?$/,
    );

    if (!repoMatch) {
      throw new Error(
        `Could not parse repository information from URL: ${repositoryUrl}`,
      );
    }

    const repositoryOwner = repoMatch[1];
    const repositoryName = repoMatch[2];

    logger.info(
      `Extracted repository info from URL: ${repositoryOwner}/${repositoryName}`,
    );

    logger.info("Deploying with payload:", value);

    const LOCAL_IP = execSync("hostname -I | awk '{print $1}'")
      .toString()
      .trim();

    // Use provided domain or generate from service name using the standard format
    // Ensure all domains follow the {serviceName}.apps.cloudlunacy.uk format
    let finalDomain;
    if (domain && domain.includes(serviceName)) {
      // If domain is provided and contains the service name, use it
      finalDomain = domain;
    } else {
      // Generate the standard domain format
      finalDomain = `${serviceName}.${process.env.APP_DOMAIN || "apps.cloudlunacy.uk"}`;
    }

    logger.info(
      `Using domain: ${finalDomain} ${domain ? "(provided in payload)" : "(generated from service name)"}`,
    );

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
      // Register with front server but don't send job result yet (deployment not complete)
      await this.registerWithFrontServer(
        serviceName,
        resolvedTargetUrl,
        null, // Don't pass jobId here - we'll send result when deployment actually completes
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

    const serviceLockKey = `${serviceName}-${environment}`;
    if (this.deploymentLocks.has(serviceLockKey)) {
      const msg = `Deployment already in progress for ${serviceName} in ${environment}`;
      logger.warn(msg);
      this.sendError(ws, { deploymentId, status: "failed", message: msg });
      return;
    }
    this.deploymentLocks.add(serviceLockKey);

    const projectName = `${deploymentId}-${serviceName}`
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
        repositoryUrl,
      );

      // Auto-detect app type if the flag is set
      let detectedAppType = appType;
      if (autoDetectAppType) {
        logger.info(
          "Auto-detecting application type from repository contents...",
        );
        try {
          const actualAppType =
            await repositoryController.detectAppType(deployDir);

          if (actualAppType && actualAppType !== "unknown") {
            logger.info(
              `Auto-detected app type: ${actualAppType} (original: ${appType})`,
            );
            detectedAppType = actualAppType;
          } else {
            logger.warn(
              `Could not auto-detect app type, using original: ${appType}`,
            );
          }
        } catch (detectionError) {
          logger.warn(
            `App type auto-detection failed: ${detectionError.message}, using original: ${appType}`,
          );
        }
      }

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
        appType: detectedAppType,
        additionalPorts: additionalPorts || [],
        ws,
      });

      // Debug: Log the new container details
      logger.info(`Container creation result: ${JSON.stringify(newContainer)}`);

      if (!newContainer) {
        logger.error("newContainer is null after buildAndStartContainer!");
      } else {
        logger.info(
          `Created container with ID: ${newContainer.id}, hostPort: ${newContainer.hostPort}`,
        );
      }

      await envManager.verifyEnvironmentSetup(newContainer.name);
      await this.performHealthCheck(newContainer);

      // Switch traffic from the old container (if any) to the new container.
      // Pass the jobId to maintain continuity with the front server registration
      await this.switchTraffic(
        oldContainer,
        newContainer,
        serviceName,
        value.jobId,
      );

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

      // Send job completion result to backend (deployment is actually complete now)
      if (value.jobId) {
        // Debug: Log container state before sending notification
        logger.info(
          `About to send job completion. newContainer state: ${JSON.stringify(newContainer)}`,
        );

        try {
          await this.notifyQueueOnRegistration(
            value.jobId,
            serviceName,
            null, // No front server response data at this point
            {
              success: true,
              domain: finalDomain,
              message: "Deployment completed successfully",
              serviceName: serviceName,
              timestamp: new Date().toISOString(),
              // Include container information for logging
              containerDetails: newContainer
                ? {
                    containerId: newContainer.id,
                    containerName: newContainer.name,
                    hostPort: newContainer.hostPort,
                    containerPort: newContainer.containerPort,
                    status: "running",
                  }
                : null,
            },
            value.projectId || null,
          );
          logger.info(
            `Job completion notification sent for job ${value.jobId}`,
          );
        } catch (notifyError) {
          logger.error(
            `Failed to send job completion notification: ${notifyError.message}`,
          );
        }
      }
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

      // Send job failure result to backend
      if (value.jobId) {
        try {
          await this.notifyQueueOnRegistration(
            value.jobId,
            serviceName,
            null, // No front server response data for failures
            {
              success: false,
              domain: null,
              message: `Deployment failed: ${error.message}`,
              serviceName: serviceName,
              timestamp: new Date().toISOString(),
              // Include container information if a container was created before failure
              containerDetails: newContainer
                ? {
                    containerId: newContainer.id,
                    containerName: newContainer.name,
                    hostPort: newContainer.hostPort,
                    containerPort: newContainer.containerPort,
                    status: "failed",
                  }
                : null,
            },
            value.projectId || null,
          );
          logger.info(`Job failure notification sent for job ${value.jobId}`);
        } catch (notifyError) {
          logger.error(
            `Failed to send job failure notification: ${notifyError.message}`,
          );
        }
      }
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

      // First check if the container still exists
      try {
        await executeCommand("docker", ["inspect", container.id]);
        logger.info(
          `Container ${container.id} exists, proceeding with removal`,
        );
      } catch (inspectError) {
        logger.info(
          `Container ${container.id} no longer exists, skipping removal`,
        );
        return true; // Consider this successful since the container is already gone
      }

      // Check if container is still running
      try {
        const { stdout: containerState } = await executeCommand("docker", [
          "inspect",
          "--format",
          "{{.State.Status}}",
          container.id,
        ]);

        if (containerState.trim() === "running") {
          logger.info(`Stopping running container ${container.id}`);
          await executeCommand("docker", ["stop", container.id]);
        } else {
          logger.info(
            `Container ${container.id} is already stopped (${containerState.trim()})`,
          );
        }
      } catch (stateError) {
        logger.warn(`Could not check container state: ${stateError.message}`);
      }

      // Remove the container
      await executeCommand("docker", ["rm", container.id]);

      logger.info(`Successfully removed old container ${container.name}`);
      return true;
    } catch (error) {
      // Check if the error is because container doesn't exist
      if (error.message.includes("No such container")) {
        logger.info(
          `Container ${container.name} (${container.id}) was already removed`,
        );
        return true; // Consider this successful
      }

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

  async cloneRepository(
    deployDir,
    repoOwner,
    repoName,
    branch,
    githubToken,
    repositoryUrl,
  ) {
    // Use repositoryUrl and add authentication token if not already present
    let repoUrl;

    if (
      !repositoryUrl.includes("x-access-token") &&
      !repositoryUrl.includes("@github.com")
    ) {
      const urlParts = repositoryUrl.split("://");
      repoUrl = `${urlParts[0]}://x-access-token:${githubToken}@${urlParts[1]}`;
    } else {
      repoUrl = repositoryUrl;
    }

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
      // Search for containers with blue/green suffixes and base name
      const patterns = [
        `${serviceName}-blue`,
        `${serviceName}-green`,
        serviceName, // fallback to base name
      ];

      const foundContainers = [];

      for (const pattern of patterns) {
        const { stdout } = await executeCommand("docker", [
          "ps",
          "-q",
          "--filter",
          `name=^${pattern}$`, // Use exact name matching
        ]);

        if (stdout.trim()) {
          const containerIds = stdout.trim().split("\n").filter(Boolean);

          for (const containerId of containerIds) {
            try {
              const { stdout: containerInfo } = await executeCommand("docker", [
                "inspect",
                containerId,
                "--format",
                "{{.Name}} {{.Id}} {{.State.Status}} {{.Created}}",
              ]);
              const [name, id, status, created] = containerInfo
                .trim()
                .split(" ");
              foundContainers.push({
                name: name.replace("/", ""),
                id,
                status,
                created: new Date(created),
                pattern,
              });
              logger.info(
                `Found container: ${name} (${id}) - Status: ${status}, Created: ${created}`,
              );
            } catch (inspectError) {
              logger.warn(
                `Error inspecting container ${containerId}: ${inspectError.message}`,
              );
            }
          }
        }
      }

      if (foundContainers.length === 0) {
        logger.info(`No existing containers found for service ${serviceName}`);
        return null;
      }

      // Sort by creation time to get the oldest (currently running) container
      foundContainers.sort((a, b) => a.created - b.created);
      const oldestContainer = foundContainers[0];

      logger.info(
        `Selected oldest container as current: ${oldestContainer.name} (${oldestContainer.id})`,
      );
      return {
        name: oldestContainer.name,
        id: oldestContainer.id,
        status: oldestContainer.status,
      };
    } catch (error) {
      logger.warn(
        `Error getting current container for ${serviceName}: ${error.message}`,
      );
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
    appType,
    additionalPorts,
    ws,
  }) {
    try {
      // Only clean up stopped/failed containers, but preserve running containers
      // for graceful blue-green deployment
      logger.info(
        `Cleaning up stopped/failed containers with name ${serviceName}`,
      );

      try {
        // Find stopped/failed containers with this service name
        const { stdout: containerList } = await executeCommand("docker", [
          "ps",
          "-a",
          "--format",
          "{{.ID}} {{.Status}}",
          "--filter",
          `name=${serviceName}`,
        ]);

        if (containerList.trim()) {
          const containers = containerList.trim().split("\n").filter(Boolean);
          const stoppedContainers = [];

          for (const containerLine of containers) {
            const [id, ...statusParts] = containerLine.split(" ");
            const status = statusParts.join(" ");

            // Only remove containers that are not running (stopped, exited, failed, etc.)
            if (!status.includes("Up")) {
              stoppedContainers.push(id);
            } else {
              logger.info(
                `Preserving running container ${id} for graceful deployment`,
              );
            }
          }

          if (stoppedContainers.length > 0) {
            logger.info(
              `Found ${stoppedContainers.length} stopped containers to clean up: ${stoppedContainers.join(", ")}`,
            );

            // Force stop and remove only stopped containers
            for (const id of stoppedContainers) {
              try {
                await executeCommand("docker", ["rm", "-f", id]); // Force removal of stopped containers
              } catch (cleanupError) {
                logger.warn(
                  `Error during stopped container cleanup: ${cleanupError.message}`,
                );
              }
            }
          } else {
            logger.info("No stopped containers found to clean up.");
          }
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

      // Define the image name
      const imageName = `${serviceName}:latest`;

      // Setup health check with optimized settings
      const health = {
        checkPath: "/health",
        interval: "20s", // Reduced from 30s
        timeout: "10s", // Increased from 5s for React apps
        retries: 2, // Reduced from 3
        start_period: "30s", // Reduced from 40s
      };

      if (this.useNixpacks) {
        // Use Nixpacks to build the Docker image
        logger.info(`Using Nixpacks to build ${serviceName} (${appType})`);

        // Load environment variables from env file
        const envContent = await fs.readFile(envFilePath, "utf-8");
        const envVars = {};
        envContent.split("\n").forEach((line) => {
          if (line && !line.startsWith("#")) {
            const [key, ...valueParts] = line.split("=");
            if (key && valueParts.length) {
              envVars[key.trim()] = valueParts.join("=").trim();
            }
          }
        });

        // Add PORT to environment variables
        envVars["PORT"] = containerPort.toString();

        // For React apps, disable CI mode to prevent ESLint warnings from being treated as errors
        if (appType === "react") {
          envVars["CI"] = "false";
          envVars["GENERATE_SOURCEMAP"] = "false";
          envVars["DISABLE_ESLINT_PLUGIN"] = "true";
          envVars["TSC_COMPILE_ON_ERROR"] = "true";
          envVars["ESLINT_NO_DEV_ERRORS"] = "true";
          envVars["NPM_CONFIG_UPDATE_NOTIFIER"] = "false";
          envVars["NPM_CONFIG_FUND"] = "false";
          envVars["NPM_CONFIG_AUDIT"] = "false";
          logger.info(
            "Applied React build optimizations: disabled sourcemaps, ESLint warnings, and npm notifications",
          );
        }

        // Build the image with Nixpacks with optimizations
        await NixpacksBuilder.buildImage({
          projectDir: deployDir,
          imageName,
          envVars,
        });

        // Enable Docker BuildKit for faster builds if available
        const buildEnv = { ...process.env };
        if (!buildEnv.DOCKER_BUILDKIT) {
          buildEnv.DOCKER_BUILDKIT = "1";
          buildEnv.COMPOSE_DOCKER_CLI_BUILD = "1";
        }

        // Create a minimal docker-compose.yml file directly
        let portsConfig = `      - "${hostPort}:${containerPort}"`;

        // Add additional port mappings if specified
        if (additionalPorts && additionalPorts.length > 0) {
          additionalPorts.forEach((portConfig) => {
            portsConfig += `\n      - "${portConfig.hostPort}:${portConfig.port}"`;
          });
        }

        const dockerComposeContent = `
version: '3.8'

services:
  ${serviceName}:
    container_name: ${serviceName}
    image: ${imageName}
    restart: unless-stopped
    ports:
${portsConfig}
    env_file:
      - "${path.basename(envFilePath)}"
    networks:
      - traefik-network
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.${serviceName}.rule=Host(\`${domain}\`)"
      - "traefik.http.routers.${serviceName}.entrypoints=web,websecure"
      - "traefik.http.routers.${serviceName}.tls.certresolver=letsencrypt"
      - "traefik.http.services.${serviceName}.loadbalancer.server.port=${containerPort}"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:${containerPort}/health"]
      interval: ${health.interval}
      timeout: ${health.timeout}
      retries: ${health.retries}
      start_period: ${health.start_period}

networks:
  traefik-network:
    external: true
`;

        await fs.writeFile(
          path.join(deployDir, "docker-compose.yml"),
          dockerComposeContent,
        );
      } else {
        // Use the traditional template approach for backward compatibility
        // Now generate deployment files with updated port if necessary
        if (!this.templateHandler) {
          this.templateHandler = new TemplateHandler(
            this.templatesDir,
            require("../deployConfig.json"),
          );
        }

        const files = await this.templateHandler.generateDeploymentFiles({
          appType: appType,
          appName: serviceName,
          environment,
          hostPort, // This may be a new port if we had to find an alternative
          containerPort,
          domain,
          envFile: path.basename(envFilePath),
          health,
        });

        // Write the files
        await Promise.all([
          fs.writeFile(path.join(deployDir, "Dockerfile"), files.dockerfile),
          fs.writeFile(
            path.join(deployDir, "docker-compose.yml"),
            files.dockerCompose,
          ),
        ]);

        // Build the container with docker-compose and optimizations
        logger.info(`Building container with project name ${projectName}...`);
        await executeCommand(
          "docker-compose",
          ["-p", projectName, "build", "--no-cache", "--parallel"],
          {
            cwd: deployDir,
            env: {
              ...process.env,
              DOCKER_BUILDKIT: "1",
              COMPOSE_DOCKER_CLI_BUILD: "1",
            },
          },
        );
      }

      // Start the container using docker-compose with optimizations
      logger.info(`Starting container on port ${hostPort}...`);
      await executeCommand("docker-compose", ["-p", projectName, "up", "-d"], {
        cwd: deployDir,
        env: {
          ...process.env,
          DOCKER_BUILDKIT: "1",
          COMPOSE_DOCKER_CLI_BUILD: "1",
        },
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

  /**
   * Notify the queue service with the front server registration result
   * @param {string} jobId - The ID of the job that initiated the registration
   * @param {string} serviceName - The name of the service being registered
   * @param {Object} responseData - The raw response data from the front server
   * @param {Object} result - The processed result object
   * @param {string} projectId - Optional ID of the project this deployment belongs to
   * @returns {Promise<void>}
   */
  async notifyQueueOnRegistration(
    jobId,
    serviceName,
    responseData,
    result,
    projectId = null,
  ) {
    try {
      // Check if queue service is available
      if (!queueService || !queueService.initialized) {
        await queueService.initialize();
      }

      logger.info(
        `Notifying queue about registration result for job ${jobId} and service ${serviceName}`,
      );

      // Send a result message to the queue
      await queueService.publishResult({
        jobId: jobId,
        status: result.success ? "SUCCESS" : "FAILED",
        actionType: "app_deployment_result",
        result: {
          serviceName,
          domain: result.domain || null,
          success: result.success,
          message: result.message,
          timestamp: new Date().toISOString(),
          // Include the project ID if available
          projectId: projectId || null,
          // Include the raw response data if available
          rawResponse: responseData ? JSON.stringify(responseData) : null,
          // Include container details if available
          containerDetails: result.containerDetails || null,
        },
      });

      // Also send a log message for better visibility
      await queueService.publishLog({
        jobId: jobId,
        content: `Front server registration for ${serviceName}: ${result.message} ${result.domain ? `[Domain: ${result.domain}]` : ""}`,
        timestamp: new Date().toISOString(),
      });

      logger.info(
        `Queue notification for front server registration complete for job ${jobId}`,
      );
    } catch (error) {
      logger.error(
        `Failed to notify queue about registration result: ${error.message}`,
      );
      // We don't throw here to avoid affecting the main deployment flow
    }
  }
}

module.exports = new ZeroDowntimeDeployer();
