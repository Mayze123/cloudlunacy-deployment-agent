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

  validateNetworks = async () => {
    try {
      const { stdout: networks } = await executeCommand("docker", [
        "network",
        "ls",
        "--format",
        "{{.Name}}",
      ]);
      if (!networks.includes("traefik-network")) {
        await executeCommand("docker", [
          "network",
          "create",
          "traefik-network",
        ]);
      }
    } catch (error) {
      throw new Error(`Network validation failed: ${error.message}`);
    }
  };

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
    console.log("🚀 ~ ZeroDowntimeDeployer ~ deploy ~ value:", value);

    const LOCAL_IP = execSync("hostname -I | awk '{print $1}'")
      .toString()
      .trim();
    let finalDomain = domain;

    const token = process.env.AGENT_JWT;
    console.log("🚀 ~ ZeroDowntimeDeployer ~ deploy ~ token:", token);
    console.log(
      "🚀 ~ ZeroDowntimeDeployer ~ deploy ~ appType.toLowerCase():",
      appType.toLowerCase(),
    );

    if (appType.toLowerCase() === "mongo") {
      finalDomain = `${serviceName}.${process.env.MONGO_DOMAIN}`;
    } else {
      finalDomain = `${serviceName}.${process.env.APP_DOMAIN}`;

      const frontApiUrl = process.env.FRONT_API_URL;
      const resolvedTargetUrl =
        targetUrl || `http://${LOCAL_IP}:${value.containerPort || 8080}`;
      console.log("resolvedTargetUrl" + resolvedTargetUrl);
      console.log(
        "[DEBUG] Calling frontdoor add-app endpoint at:",
        `${frontApiUrl}/api/frontdoor/add-app`,
      );
      try {
        // Use the JWT loaded in process.env.AGENT_JWT
        const token = process.env.AGENT_JWT;
        console.log("🚀 ~ ZeroDowntimeDeployer ~ deploy ~ token:", token);
        const response = await axios.post(
          `${frontApiUrl}/api/frontdoor/add-app`,
          {
            subdomain: serviceName,
            targetUrl: resolvedTargetUrl,
          },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            timeout: 20000, // 10-second timeout
          },
        );
        console.log("[DEBUG] Frontdoor add-app response:", response.data);
      } catch (err) {
        console.log("🚀 ~ ZeroDowntimeDeployer ~ deploy ~ err:", err);
        console.error(
          "[ERROR] Failed to call frontdoor add-app endpoint:",
          err.message,
        );
        // throw err;
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
        payload: value,
        ws,
      });

      await envManager.verifyEnvironmentSetup(newContainer.name);
      await this.performHealthCheck(newContainer, finalDomain);
      await this.switchTraffic(oldContainer, newContainer, finalDomain);

      if (oldContainer)
        await this.gracefulContainerRemoval(
          oldContainer,
          deployDir,
          projectName,
        );

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
      await executeCommand("git", ["clone", "-b", branch, repoUrl, tempDir]);
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
      if (await this.directoryExists(tempDir))
        await fs.rm(tempDir, { recursive: true, force: true });
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
    } catch (error) {}
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

  async switchTraffic(oldContainer, newContainer, domain) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  async buildAndStartContainer({
    projectName,
    serviceName,
    deployDir,
    domain,
    envFilePath,
    environment,
    payload,
    ws,
  }) {
    try {
      const existingContainers = await executeCommand("docker-compose", [
        "-p",
        projectName,
        "ps",
        "-q",
        serviceName,
      ]);
      const containerIds = existingContainers.stdout
        .trim()
        .split("\n")
        .filter((id) => id);
      for (const id of containerIds)
        await executeCommand("docker-compose", [
          "-p",
          projectName,
          "down",
          "-v",
        ]);

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
        containerPort: payload.containerPort || 8080,
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
      return { id: newContainerId.trim(), name: serviceName };
    } catch (error) {
      throw new Error(`Failed to build/start container: ${error.message}`);
    }
  }

  async performRollback(oldContainer, newContainer, domain) {
    try {
      if (newContainer)
        await executeCommand("docker-compose", [
          "-p",
          newContainer.name,
          "down",
          "-v",
        ]);
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
        if (await this.directoryExists(backupDir))
          await fs.rm(backupDir, { recursive: true, force: true });
      }
    } catch (error) {}
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
