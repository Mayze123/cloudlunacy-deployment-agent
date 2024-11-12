const { executeCommand } = require("../utils/executor");
const logger = require("../utils/logger");
const fs = require("fs").promises;
const path = require("path");
const TemplateHandler = require("../utils/templateHandler");
const deployConfig = require("../deployConfig.json");
const { ensureDeploymentPermissions } = require("../utils/permissionCheck");
const apiClient = require("../utils/apiClient");
const EnvironmentManager = require("../utils/environmentManager");

async function deployApp(payload, ws) {
  const {
    deploymentId,
    appType,
    appName,
    repositoryOwner,
    repositoryName,
    branch,
    githubToken,
    environment,
    domain,
    envVarsToken,
  } = payload;

  const serviceName = `${appName}-${environment}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  const deployDir = path.join("/opt/cloudlunacy/deployments", deploymentId);
  const currentDir = process.cwd();

  logger.info(
    `Starting deployment ${deploymentId} for ${appType} app: ${appName}`
  );

  try {
    // Initialize template handler
    const templateHandler = new TemplateHandler(
      path.join("/opt/cloudlunacy/templates"),
      deployConfig
    );
    await templateHandler.init();

    // Check permissions
    const permissionsOk = await ensureDeploymentPermissions();
    if (!permissionsOk) {
      throw new Error("Deployment failed: Permission check failed");
    }

    // Clean up existing deployment
    await cleanupExistingDeployment(serviceName);

    // Set up deployment directory
    await fs.mkdir(deployDir, { recursive: true });
    process.chdir(deployDir);

    // Send initial status
    sendStatus(ws, {
      deploymentId,
      status: "in_progress",
      message: "Starting deployment...",
    });

    // Retrieve environment variables
    sendLogs(ws, deploymentId, "Retrieving environment variables...");
    const envVars = await retrieveEnvironmentVariables(
      deploymentId,
      envVarsToken
    );

    // Clone repository
    sendLogs(ws, deploymentId, "Cloning repository...");
    const repoUrl = `https://x-access-token:${githubToken}@github.com/${repositoryOwner}/${repositoryName}.git`;
    await executeCommand("git", ["clone", "-b", branch, repoUrl, "."]);

    // Set up environment files
    const envManager = new EnvironmentManager(deployDir);
    const envFilePath = await envManager.writeEnvFile(envVars, environment);
    await fs.copyFile(envFilePath, path.join(deployDir, ".env"));

    // Ensure Traefik network exists
    await ensureTraefikNetwork();

    // Generate deployment files
    sendLogs(ws, deploymentId, "Generating deployment configuration...");
    const files = await templateHandler.generateDeploymentFiles({
      appType,
      appName,
      environment,
      domain,
      envFile: path.basename(envFilePath),
      buildConfig: {
        nodeVersion: "18",
        buildOutputDir: "build",
      },
    });

    // Write and validate deployment files
    await writeDeploymentFiles(files);
    await validateDockerCompose();

    // Build and start containers with detailed logging
    await buildAndStartContainers(ws, deploymentId, serviceName);

    // Verify deployment with enhanced checks
    sendLogs(ws, deploymentId, "Verifying deployment...");
    const health = await checkDeploymentHealth(serviceName, domain);

    if (!health.healthy) {
      throw new Error(`Deployment health check failed: ${health.message}`);
    }

    // Send success status
    sendStatus(ws, {
      deploymentId,
      status: "success",
      message: "Deployment completed successfully",
      domain,
    });
  } catch (error) {
    logger.error(`Deployment ${deploymentId} failed:`, error);
    await handleDeploymentFailure(
      error,
      ws,
      deploymentId,
      serviceName,
      deployDir
    );
  } finally {
    process.chdir(currentDir);
  }
}

async function buildAndStartContainers(ws, deploymentId, serviceName) {
  sendLogs(ws, deploymentId, "Building application...");

  try {
    // Build with detailed output
    const buildResult = await executeCommand(
      "docker-compose",
      ["build", "--no-cache"],
      {
        stdout: (data) => sendLogs(ws, deploymentId, `Build: ${data}`),
        stderr: (data) => sendLogs(ws, deploymentId, `Build error: ${data}`),
      }
    );

    sendLogs(ws, deploymentId, "Starting application...");

    // Start containers with detailed output
    const startResult = await executeCommand(
      "docker-compose",
      ["up", "-d", "--force-recreate"],
      {
        stdout: (data) => sendLogs(ws, deploymentId, `Start: ${data}`),
        stderr: (data) => sendLogs(ws, deploymentId, `Start error: ${data}`),
      }
    );

    // Verify container is actually running
    const { stdout: containerList } = await executeCommand("docker", [
      "ps",
      "--filter",
      `name=${serviceName}`,
    ]);
    if (!containerList.includes(serviceName)) {
      // Get container logs if it exists but isn't running
      try {
        const { stdout: logs } = await executeCommand("docker", [
          "logs",
          serviceName,
        ]);
        throw new Error(`Container failed to start. Logs:\n${logs}`);
      } catch (logError) {
        throw new Error("Container failed to start and no logs available");
      }
    }
  } catch (error) {
    throw new Error(`Failed to build/start containers: ${error.message}`);
  }
}

async function handleDeploymentFailure(
  error,
  ws,
  deploymentId,
  serviceName,
  deployDir
) {
  // Send error status
  sendStatus(ws, {
    deploymentId,
    status: "failed",
    message: error.message,
  });

  try {
    // Get container logs if possible
    try {
      const logs = await getContainerLogs(serviceName);
      logger.error(`Container logs before cleanup:\n${logs}`);
    } catch (logError) {
      logger.warn(`Could not retrieve container logs: ${logError.message}`);
    }

    // Clean up deployment
    await cleanupExistingDeployment(serviceName);
    await fs.rm(deployDir, { recursive: true, force: true });
  } catch (cleanupError) {
    logger.error(`Cleanup failed: ${cleanupError.message}`);
  }
}

async function cleanupExistingDeployment(serviceName) {
  try {
    // Stop and remove existing container
    await executeCommand("docker", ["stop", serviceName]).catch(() => {});
    await executeCommand("docker", ["rm", serviceName]).catch(() => {});

    // Get container ID if it exists
    const { stdout: containerId } = await executeCommand("docker", [
      "ps",
      "-aq",
      "-f",
      `name=${serviceName}`,
    ]).catch(() => ({ stdout: "" }));

    if (containerId) {
      // Force remove container if it still exists
      await executeCommand("docker", ["rm", "-f", containerId]).catch(() => {});
    }

    // Remove any dangling images
    const { stdout: images } = await executeCommand("docker", [
      "images",
      "-q",
      "-f",
      "dangling=true",
    ]).catch(() => ({ stdout: "" }));

    if (images) {
      await executeCommand("docker", [
        "rmi",
        "-f",
        ...images.split("\n"),
      ]).catch(() => {});
    }

    logger.info(`Cleaned up deployment for ${serviceName}`);
  } catch (error) {
    logger.warn("Cleanup warning:", error);
  }
}

async function checkDeploymentHealth(serviceName, domain) {
  try {
    logger.info(`Starting health check for ${serviceName}`);

    // Wait for container to start
    await new Promise((resolve) => setTimeout(resolve, 10000));

    // Check if container exists and is running
    const containerInfo = await getContainerInfo(serviceName);
    if (!containerInfo) {
      throw new Error("Container not found");
    }

    if (!containerInfo.State.Running) {
      const logs = await getContainerLogs(serviceName);
      throw new Error(`Container is not running. Logs:\n${logs}`);
    }

    // Check Traefik routing
    const traefikCheck = await checkTraefikRouting(domain);
    if (!traefikCheck.success) {
      throw new Error(`Traefik routing check failed: ${traefikCheck.error}`);
    }

    return { healthy: true };
  } catch (error) {
    return {
      healthy: false,
      message: error.message,
    };
  }
}

async function getContainerInfo(serviceName) {
  try {
    const { stdout } = await executeCommand("docker", ["inspect", serviceName]);
    return JSON.parse(stdout)[0];
  } catch (error) {
    logger.error(`Failed to get container info: ${error.message}`);
    return null;
  }
}

async function checkTraefikRouting(domain) {
  try {
    // Check if Traefik is running
    const { stdout: traefikStatus } = await executeCommand("docker", [
      "ps",
      "--filter",
      "name=traefik",
      "--format",
      "{{.Status}}",
    ]);
    if (!traefikStatus) {
      return { success: false, error: "Traefik container not running" };
    }

    // Check for Traefik router configuration
    const { stdout: traefikRouters } = await executeCommand("docker", [
      "exec",
      "traefik",
      "traefik",
      "status",
      "--error-detail",
    ]);
    if (!traefikRouters.includes(domain)) {
      return { success: false, error: "Domain not configured in Traefik" };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function sendStatus(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(
      JSON.stringify({
        type: "status",
        payload: data,
      })
    );
  }
}

function sendLogs(ws, deploymentId, log) {
  if (ws.readyState === ws.OPEN) {
    ws.send(
      JSON.stringify({
        type: "logs",
        payload: {
          deploymentId,
          log,
          timestamp: new Date().toISOString(),
        },
      })
    );
  }
}

async function retrieveEnvironmentVariables(deploymentId, envVarsToken) {
  try {
    logger.info(`Fetching env vars for deployment ${deploymentId}`);
    const { data } = await apiClient.post(
      `/api/deploy/env-vars/${deploymentId}`,
      {
        token: envVarsToken,
      }
    );

    if (!data || !data.variables) {
      throw new Error("Invalid response format for environment variables");
    }

    logger.info("Successfully retrieved environment variables");
    return data.variables;
  } catch (error) {
    logger.error("Environment variables setup failed:", error);
    throw new Error(`Environment variables setup failed: ${error.message}`);
  }
}

async function getContainerLogs(serviceName) {
  try {
    const { stdout: logs } = await executeCommand("docker", [
      "logs",
      serviceName,
    ]);
    return logs;
  } catch (error) {
    throw new Error(`Failed to get container logs: ${error.message}`);
  }
}

async function ensureTraefikNetwork() {
  try {
    // Check if network exists
    const { stdout: networks } = await executeCommand("docker", [
      "network",
      "ls",
      "--format",
      "{{.Name}}",
    ]);
    if (!networks.includes("traefik-public")) {
      logger.info("Creating traefik-public network...");
      await executeCommand("docker", ["network", "create", "traefik-public"]);
      logger.info("Created traefik-public network");
    }
  } catch (error) {
    throw new Error(`Failed to ensure Traefik network: ${error.message}`);
  }
}

async function writeDeploymentFiles(files) {
  try {
    await Promise.all([
      fs.writeFile("Dockerfile", files.dockerfile),
      fs.writeFile("docker-compose.yml", files.dockerCompose),
    ]);
    logger.info("Deployment files written successfully");
  } catch (error) {
    throw new Error(`Failed to write deployment files: ${error.message}`);
  }
}

async function validateDockerCompose() {
  try {
    const { stdout } = await executeCommand("docker-compose", ["config"]);
    logger.info("Docker Compose configuration validated");
    return true;
  } catch (error) {
    throw new Error(`Invalid docker-compose configuration: ${error.message}`);
  }
}

module.exports = deployApp;
