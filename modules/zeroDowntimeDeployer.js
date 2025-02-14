// deploy/ZeroDowntimeDeployer.js

const { executeCommand } = require("../utils/executor");
const logger = require("../utils/logger");
const fs = require("fs").promises;
const path = require("path");
const TemplateHandler = require("../utils/templateHandler");
const { ensureDeploymentPermissions } = require("../utils/permissionCheck");
const apiClient = require("../utils/apiClient");
const EnvironmentManager = require("../utils/environmentManager");
const Joi = require("joi");

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
    this.deploymentLocks = new Set(); // Simple in-memory lock mechanism
  }

  async deploy(payload, ws) {
    // Define schema for payload validation
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
    });

    // Validate payload
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
    } = value;

    // Override the domain based on appType:
    // - If it's a MongoDB deployment (appType === "mongo"), use the MONGO_DOMAIN
    // - Otherwise, for HTTP apps, use APP_DOMAIN
    let finalDomain = domain; // fallback to the provided one if needed
    if (appType.toLowerCase() === "mongo") {
      const mongoDomain = process.env.MONGO_DOMAIN || "mongodb.cloudlunacy.uk";
      finalDomain = `${serviceName}.${mongoDomain}`;
      logger.info(`Using MongoDB domain: ${finalDomain}`);
    } else {
      // For HTTP apps (e.g. React, Node) use APP_DOMAIN
      const appDomain = process.env.APP_DOMAIN || "apps.cloudlunacy.uk";
      finalDomain = `${serviceName}.${appDomain}`;
      logger.info(`Using HTTP app domain: ${finalDomain}`);
    }

    // Implement deployment lock to prevent concurrent deployments for the same service
    const serviceLockKey = `${serviceName}-${environment}`;
    if (this.deploymentLocks.has(serviceLockKey)) {
      const msg = `Deployment already in progress for service ${serviceName} in environment ${environment}`;
      logger.warn(msg);
      this.sendError(ws, {
        deploymentId,
        status: "failed",
        message: msg,
      });
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
      const permissionsOk = await ensureDeploymentPermissions();
      if (!permissionsOk) {
        throw new Error("Deployment failed: Permission check failed");
      }

      await this.validatePrerequisites();
      await this.setupDirectories(deployDir, backupDir);

      // Initialize environment manager
      envManager = new EnvironmentManager(deployDir);

      // Setup environment by fetching environment variables via apiClient
      const envVars = await this.fetchEnvironmentVariables(
        deploymentId,
        envVarsToken,
      );
      if (!envVars) {
        throw new Error("Failed to retrieve environment variables");
      }

      // Write environment variables to .env file
      const envFilePath = await envManager.writeEnvFile(envVars, environment);
      logger.info("Environment variables written to .env file");

      // Clone repository into deployDir, handling existing backup
      await this.cloneRepository(
        deployDir,
        repositoryOwner,
        repositoryName,
        branch,
        githubToken,
      );

      // Backup old container if exists
      oldContainer = await this.getCurrentContainer(serviceName);
      if (oldContainer) {
        await this.backupCurrentState(oldContainer, backupDir);
      }

      // No need to allocate ports since Traefik handles routing

      const blueGreenLabel = oldContainer ? "green" : "blue";
      const newContainerName = `${serviceName}-${blueGreenLabel}`;

      // Pass the computed finalDomain to the template handler
      newContainer = await this.buildAndStartContainer({
        projectName,
        serviceName: newContainerName,
        deployDir,
        domain: finalDomain, // use the updated domain here
        envFilePath,
        environment,
        payload: value,
        ws,
      });

      const envSetupOk = await envManager.verifyEnvironmentSetup(
        newContainer.name,
      );
      if (!envSetupOk) {
        throw new Error("Environment verification failed");
      }

      await this.performHealthCheck(newContainer, finalDomain);
      await this.switchTraffic(oldContainer, newContainer, finalDomain);

      if (oldContainer) {
        await this.gracefulContainerRemoval(
          oldContainer,
          deployDir,
          projectName,
        );
      }

      this.sendSuccess(ws, {
        deploymentId,
        status: "success",
        message: "Zero-downtime deployment completed successfully",
        domain: finalDomain,
      });
    } catch (error) {
      logger.error(`Deployment ${deploymentId} failed:`, error);
      rollbackNeeded = true;

      try {
        if (rollbackNeeded && oldContainer) {
          await this.performRollback(oldContainer, newContainer, finalDomain);
        }
      } catch (rollbackError) {
        logger.error("Rollback failed:", rollbackError);
      }

      this.sendError(ws, {
        deploymentId,
        status: "failed",
        message: error.message || "Deployment failed",
      });
    } finally {
      this.deploymentLocks.delete(serviceLockKey);
      if (!rollbackNeeded) {
        await this.cleanup(deployDir, rollbackNeeded);
      }
    }
  }

  // ... (the rest of your code remains unchanged)
}

module.exports = new ZeroDowntimeDeployer();
