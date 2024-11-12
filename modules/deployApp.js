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
    let envVars = {};
    let envFilePath;
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

      envVars = data.variables;
      logger.info("Successfully retrieved environment variables");
    } catch (error) {
      logger.error("Environment variables setup failed:", error);
      throw new Error(`Environment variables setup failed: ${error.message}`);
    }

    // Clone repository
    sendLogs(ws, deploymentId, "Cloning repository...");
    const repoUrl = `https://x-access-token:${githubToken}@github.com/${repositoryOwner}/${repositoryName}.git`;
    await executeCommand("git", ["clone", "-b", branch, repoUrl, "."]);

    // Set up environment files
    const envManager = new EnvironmentManager(deployDir);
    envFilePath = await envManager.writeEnvFile(envVars, environment);
    await fs.copyFile(envFilePath, path.join(deployDir, ".env"));

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
        cacheControl: "public, max-age=31536000",
      },
    });

    // Write deployment files
    await Promise.all([
      fs.writeFile("Dockerfile", files.dockerfile),
      fs.writeFile("docker-compose.yml", files.dockerCompose),
    ]);

    // Validate docker-compose file
    try {
      sendLogs(ws, deploymentId, "Validating deployment configuration...");
      const { stdout: configOutput } = await executeCommand("docker-compose", [
        "config",
      ]);
      sendLogs(ws, deploymentId, "Docker Compose configuration validated");
    } catch (error) {
      throw new Error(`Invalid docker-compose configuration: ${error.message}`);
    }

    // Ensure connection to Traefik network
    try {
      await executeCommand("docker", ["network", "inspect", "traefik-public"]);
    } catch (error) {
      sendLogs(ws, deploymentId, "Creating Traefik network...");
      await executeCommand("docker", ["network", "create", "traefik-public"]);
    }

    // Build and start containers
    sendLogs(ws, deploymentId, "Building application...");
    await executeCommand("docker-compose", ["build", "--no-cache"]);
    sendLogs(ws, deploymentId, "Starting application...");
    await executeCommand("docker-compose", ["up", "-d", "--force-recreate"]);

    // Verify deployment
    sendLogs(ws, deploymentId, "Verifying deployment...");
    const health = await checkDeploymentHealth(
      files.allocatedPort,
      serviceName,
      domain
    );

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

    // Send detailed error message
    sendStatus(ws, {
      deploymentId,
      status: "failed",
      message: error.message || "Deployment failed",
    });

    // Cleanup on failure
    await handleDeploymentFailure(error, deploymentId, serviceName, deployDir);
  } finally {
    process.chdir(currentDir);
  }
}

async function handleDeploymentFailure(
  error,
  deploymentId,
  serviceName,
  deployDir
) {
  try {
    // Get container logs before cleanup
    try {
      const { stdout: failureLogs } = await executeCommand("docker", [
        "logs",
        serviceName,
      ]);
      logger.error("Container logs before cleanup:", failureLogs);
    } catch (logError) {
      logger.warn("Could not retrieve container logs:", logError);
    }

    // Clean up containers and networks
    await cleanupExistingDeployment(serviceName);

    // Remove deployment directory
    await fs.rm(deployDir, { recursive: true, force: true });
  } catch (cleanupError) {
    logger.error("Cleanup failed:", cleanupError);
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

async function checkDeploymentHealth(port, containerName, domain) {
  try {
    logger.info(
      `Starting comprehensive health check for ${containerName} on port ${port}`
    );

    // Initial delay to allow container to start
    await new Promise((resolve) => setTimeout(resolve, 15000));

    // Get container state with detailed information
    logger.info(`Checking container state for ${containerName}...`);
    const { stdout: containerStatus } = await executeCommand("docker", [
      "inspect",
      "--format",
      "{{json .State}}",
      containerName,
    ]);

    try {
      const containerState = JSON.parse(containerStatus);
      logger.info("Container state:", JSON.stringify(containerState, null, 2));

      if (!containerState.Running) {
        // Get container logs if not running
        const { stdout: logs } = await executeCommand("docker", [
          "logs",
          containerName,
        ]);
        logger.error("Container failed to start. Logs:", logs);
        throw new Error(
          `Container failed to start: ${
            containerState.Error || "Unknown error"
          }`
        );
      }
    } catch (parseError) {
      logger.error("Failed to parse container state:", containerStatus);
      throw new Error("Failed to parse container state");
    }

    // Check network connectivity
    logger.info(`Checking network configuration for ${containerName}...`);
    const { stdout: networkInfo } = await executeCommand("docker", [
      "inspect",
      "--format",
      "{{range $network, $config := .NetworkSettings.Networks}}Network: {{$network}}, IP: {{$config.IPAddress}}{{println}}{{end}}",
      containerName,
    ]);

    logger.info("Network configuration:", networkInfo);

    // Verify Traefik routing
    logger.info(`Verifying Traefik routing for ${domain}...`);
    try {
      // Check if Traefik picked up the configuration
      const { stdout: traefikRoutes } = await executeCommand("docker", [
        "exec",
        "traefik",
        "traefik",
        "healthcheck",
      ]);
      logger.info("Traefik health check passed");

      // Try to access the service through Traefik
      await executeCommand("curl", [
        "--max-time",
        "5",
        "-I",
        "-H",
        `"Host: ${domain}"`,
        "http://localhost",
      ]);
      logger.info(`Service accessible through Traefik for domain ${domain}`);
    } catch (error) {
      logger.warn("Traefik routing verification failed:", error.message);
    }

    // Check application health endpoint
    try {
      logger.info(`Checking application health endpoint on port ${port}...`);
      const { stdout: healthCheck } = await executeCommand("curl", [
        "--max-time",
        "5",
        "-i",
        `http://localhost:${port}/health`,
      ]);
      logger.info("Health endpoint response:", healthCheck);
    } catch (error) {
      logger.warn("Health endpoint check failed:", error.message);
    }

    // Get final container state and logs
    const { stdout: finalState } = await executeCommand("docker", [
      "inspect",
      "--format",
      "{{.State.Status}} (Running: {{.State.Running}}, ExitCode: {{.State.ExitCode}})",
      containerName,
    ]);
    logger.info("Final container state:", finalState);

    const { stdout: containerLogs } = await executeCommand("docker", [
      "logs",
      "--tail",
      "20",
      containerName,
    ]);
    logger.info("Recent container logs:", containerLogs);

    return {
      healthy: true,
      details: {
        containerState: finalState,
        networkInfo,
      },
    };
  } catch (error) {
    logger.error("Health check failed:", error);
    return {
      healthy: false,
      message: error.message,
      details: error.stack,
    };
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

module.exports = deployApp;
