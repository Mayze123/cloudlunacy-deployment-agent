// src/modules/deployApp.js

const { executeCommand } = require("../utils/executor");
const logger = require("../utils/logger");
const fs = require("fs").promises;
const path = require("path");
const TemplateHandler = require("../utils/templateHandler");
const deployConfig = require("../deployConfig.json");
const { ensureDeploymentPermissions } = require("../utils/permissionCheck");
const apiClient = require("../utils/apiClient");
const EnvironmentManager = require("../utils/environmentManager");
const portManager = require("../utils/portManager");
const traefikManager = require("../utils/traefikManager");

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
    port: requestedPort,
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
    // Initialize port manager early
    await portManager.initialize();

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

    // Get or allocate port
    const deploymentPort = await portManager.allocatePort(appName, environment);
    logger.info(`Using port ${deploymentPort} for ${serviceName}`);

    // Generate deployment files with allocated port
    sendLogs(ws, deploymentId, "Generating deployment configuration...");
    const files = await templateHandler.generateDeploymentFiles({
      appType,
      appName,
      environment,
      port: deploymentPort,
      envFile: path.basename(envFilePath),
      buildConfig: {
        nodeVersion: "18",
        buildOutputDir: "build",
        cacheControl: "public, max-age=31536000",
      },
      domain: domain || `${appName}-${environment}.yourdomain.com`,
    });

    // Write deployment files
    await Promise.all([
      fs.writeFile("Dockerfile", files.dockerfile),
      fs.writeFile("docker-compose.yml", files.dockerCompose),
      files.nginxConf
        ? fs.writeFile("nginx.conf", files.nginxConf)
        : Promise.resolve(),
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

    // Build and start containers
    sendLogs(ws, deploymentId, "Building application...");
    await executeCommand("docker-compose", ["build", "--no-cache"]);
    sendLogs(ws, deploymentId, "Starting application...");
    await executeCommand("docker-compose", ["up", "-d", "--force-recreate"]);

    if (domain) {
      try {
        sendLogs(ws, deploymentId, `Configuring domain: ${domain}`);
        await traefikManager.configureService(
          domain,
          serviceName,
          deploymentPort
        );

        // Verify domain accessibility
        const maxRetries = 5;
        let retryCount = 0;
        let domainAccessible = false;

        while (retryCount < maxRetries && !domainAccessible) {
          try {
            await executeCommand("curl", [
              "--max-time",
              "5",
              "-I",
              "--insecure", // Allow self-signed certs during check
              `https://${domain}`,
            ]);
            domainAccessible = true;
            sendLogs(ws, deploymentId, `Domain ${domain} is accessible`);
          } catch (error) {
            retryCount++;
            if (retryCount < maxRetries) {
              await new Promise((resolve) => setTimeout(resolve, 5000));
            }
          }
        }

        if (!domainAccessible) {
          logger.warn(
            `Domain ${domain} is not accessible after ${maxRetries} attempts`
          );
          sendLogs(
            ws,
            deploymentId,
            `Warning: Domain ${domain} is not yet accessible. DNS may need time to propagate.`
          );
        }
      } catch (error) {
        logger.error(`Failed to configure domain ${domain}:`, error);
        sendLogs(
          ws,
          deploymentId,
          `Warning: Domain configuration encountered an error: ${error.message}`
        );
      }
    }

    // Verify deployment
    sendLogs(ws, deploymentId, "Verifying deployment...");
    const health = await checkDeploymentHealth(
      deploymentPort,
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

    sendStatus(ws, {
      deploymentId,
      status: "failed",
      message: error.message || "Deployment failed",
    });

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

      // Release allocated port
      await portManager.releasePort(appName, environment);

      // Remove Traefik configuration if created
      if (domain) {
        await traefikManager.removeService(domain, serviceName);
      }

      // Clean up containers and networks
      await cleanupExistingDeployment(serviceName);

      // Remove deployment directory
      await fs.rm(deployDir, { recursive: true, force: true });
    } catch (cleanupError) {
      logger.error("Cleanup failed:", cleanupError);
    }
  } finally {
    process.chdir(currentDir);
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

    // Check network connectivity with detailed network info
    logger.info(`Checking network configuration for ${containerName}...`);
    const { stdout: networkInfo } = await executeCommand("docker", [
      "inspect",
      "--format",
      "{{range $network, $config := .NetworkSettings.Networks}}Network: {{$network}}, IP: {{$config.IPAddress}}, Gateway: {{$config.Gateway}}, MacAddress: {{$config.MacAddress}}{{println}}{{end}}",
      containerName,
    ]);

    logger.info("Network configuration:", networkInfo);

    // Get detailed port bindings
    logger.info(`Checking port bindings for ${containerName}...`);
    const { stdout: portBindings } = await executeCommand("docker", [
      "inspect",
      "--format",
      "{{range $p, $conf := .NetworkSettings.Ports}}{{$p}} -> {{range $conf}}{{.HostIp}}:{{.HostPort}}{{end}}{{println}}{{end}}",
      containerName,
    ]);

    logger.info("Port bindings:", portBindings);

    // Check port accessibility using netcat
    logger.info(`Checking port ${port} availability...`);
    const portCheck = await new Promise((resolve) => {
      const net = require("net");
      const socket = net.createConnection(port);

      const timeout = setTimeout(() => {
        socket.destroy();
        logger.warn(`Port ${port} connection timed out`);
        resolve(false);
      }, 5000);

      socket.on("connect", () => {
        clearTimeout(timeout);
        socket.end();
        logger.info(`Successfully connected to port ${port}`);
        resolve(true);
      });

      socket.on("error", (error) => {
        clearTimeout(timeout);
        logger.error("Port connection error:", error);
        resolve(false);
      });
    });

    if (!portCheck) {
      // Get netstat information for debugging
      const { stdout: netstatOutput } = await executeCommand("netstat", [
        "-tulpn",
      ]);
      logger.error("Port not accessible. Current port usage:", netstatOutput);

      // Get recent container logs
      const { stdout: logs } = await executeCommand("docker", [
        "logs",
        "--tail",
        "50",
        containerName,
      ]);
      logger.error("Recent container logs:", logs);

      throw new Error(`Port ${port} is not accessible`);
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

    // Check nginx configuration if domain is provided
    if (domain) {
      logger.info(`Verifying domain configuration for ${domain}`);

      // Test nginx configuration
      const { stdout: nginxStatus } = await executeCommand("sudo", [
        "nginx",
        "-t",
      ]);
      logger.info("Nginx configuration status:", nginxStatus);

      // Test domain resolution locally
      try {
        logger.info(`Testing local domain access for ${domain}...`);
        const { stdout: localCheck } = await executeCommand("curl", [
          "--max-time",
          "5",
          "--verbose",
          "-H",
          `"Host: ${domain}"`,
          `http://localhost:${port}`,
        ]);
        logger.info("Local domain check response:", localCheck);
      } catch (error) {
        logger.warn("Local domain check failed:", error.message);
      }
    }

    // Get final container state and logs
    const { stdout: finalState } = await executeCommand("docker", [
      "inspect",
      "--format",
      "{{.State.Status}} (Running: {{.State.Running}}, ExitCode: {{.State.ExitCode}}, Health: {{.State.Health.Status}})",
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
        portBindings,
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

async function cleanupExistingDeployment(serviceName) {
  try {
    // Stop and remove existing container
    await executeCommand("docker", ["stop", serviceName]).catch(() => {});
    await executeCommand("docker", ["rm", serviceName]).catch(() => {});

    // Kill any process using the required port
    const { stdout: netstatOutput } = await executeCommand("netstat", [
      "-tlpn",
    ]);
    const portProcesses = netstatOutput
      .split("\n")
      .filter((line) => line.includes(":3000 "))
      .map((line) => {
        const match = line.match(/LISTEN\s+(\d+)/);
        return match ? match[1] : null;
      })
      .filter(Boolean);

    for (const pid of portProcesses) {
      try {
        await executeCommand("kill", ["-9", pid]);
        logger.info(`Killed process ${pid} using port 3000`);
      } catch (error) {
        logger.warn(`Failed to kill process ${pid}: ${error.message}`);
      }
    }

    // Remove network
    await executeCommand("docker", ["network", "rm", "app-network"]).catch(
      () => {}
    );
  } catch (error) {
    logger.warn("Cleanup warning:", error);
  }
}

module.exports = deployApp;
