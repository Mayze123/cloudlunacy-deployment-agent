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
const net = require("net");

async function deployApp(payload, ws) {
  const {
    deploymentId,
    appType,
    appName, // This is now the complete service name from the backend
    repositoryOwner,
    repositoryName,
    branch,
    githubToken,
    environment,
    port: requestedPort,
    domain,
    envVarsToken,
  } = payload;

  // Use appName directly as it's already properly formatted from the backend
  const serviceName = appName;

  logger.info(
    `Starting deployment ${deploymentId} for ${appType} app: ${serviceName} in ${environment} environment`
  );

  const deployDir = path.join("/opt/cloudlunacy/deployments", deploymentId);
  const currentDir = process.cwd();
  let deploymentPort = null;

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

    // Port allocation with better error handling
    if (requestedPort) {
      logger.info(`Checking availability of requested port ${requestedPort}`);
      const isAvailable = await portManager.ensurePortAvailable(requestedPort);
      if (!isAvailable) {
        logger.warn(
          `Requested port ${requestedPort} is not available, allocating a new port`
        );
        const portAllocation = await portManager.allocatePort(serviceName);
        deploymentPort = portAllocation.hostPort;
      } else {
        deploymentPort = parseInt(requestedPort, 10);
        await portManager.releasePort(serviceName); // Release any existing port first
        const portAllocation = await portManager.allocatePort(serviceName);
        if (portAllocation.hostPort !== deploymentPort) {
          throw new Error(`Failed to allocate requested port ${requestedPort}`);
        }
        logger.info(
          `Using requested port ${deploymentPort} for ${serviceName}`
        );
      }
    } else {
      logger.info(
        `No specific port requested for ${serviceName}, allocating new port`
      );
      const portAllocation = await portManager.allocatePort(serviceName);
      deploymentPort = portAllocation.hostPort;
    }

    logger.info(`Using port ${deploymentPort} for ${serviceName}`);

    // Generate deployment files
    sendLogs(ws, deploymentId, "Generating deployment configuration...");
    const files = await templateHandler.generateDeploymentFiles({
      appType,
      appName: serviceName,
      environment,
      port: deploymentPort,
      envFile: path.basename(envFilePath),
      domain: domain,
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
              sendLogs(
                ws,
                deploymentId,
                `Waiting for domain to become accessible (attempt ${retryCount}/${maxRetries})...`
              );
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
      port: deploymentPort,
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

      // Release allocated port using consistent service name
      if (deploymentPort) {
        await portManager.releasePort(serviceName);
        logger.info(`Released port ${deploymentPort} for ${serviceName}`);
      }

      // Remove Traefik configuration if created
      if (domain) {
        await traefikManager.removeService(domain, serviceName);
        logger.info(`Removed Traefik configuration for ${domain}`);
      }

      // Clean up containers and networks
      await cleanupExistingDeployment(serviceName);
      logger.info(`Cleaned up containers and networks for ${serviceName}`);

      // Remove deployment directory
      await fs.rm(deployDir, { recursive: true, force: true });
      logger.info(`Removed deployment directory ${deployDir}`);
    } catch (cleanupError) {
      logger.error("Cleanup failed:", cleanupError);
    }
  } finally {
    process.chdir(currentDir);
    logger.info(`Deployment process completed for ${serviceName}`);
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

async function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", (err) => {
      server.close();
      if (err.code === "EADDRINUSE") {
        logger.debug(`Host port ${port} is in use`);
        resolve(false);
      } else {
        logger.error(`Error checking host port ${port}:`, err);
        resolve(false);
      }
    });

    server.once("listening", () => {
      server.close();
      logger.debug(`Host port ${port} is available`);
      resolve(true);
    });

    server.listen(port, "127.0.0.1");
  });
}

async function checkContainerPort(containerName, port) {
  try {
    // First check if container is running
    const { stdout: status } = await executeCommand("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}",
      containerName,
    ]);
    if (status.trim() !== "true") {
      logger.error(`Container ${containerName} is not running`);
      return false;
    }

    // Try to execute curl inside the container to check the port
    await executeCommand("docker", [
      "exec",
      containerName,
      "curl",
      "-s",
      "--retry",
      "1",
      "--max-time",
      "2",
      `http://localhost:${port}/health`,
    ]);

    logger.debug(`Container port ${port} is accessible in ${containerName}`);
    return true;
  } catch (error) {
    logger.error(
      `Error checking container port ${port} in ${containerName}:`,
      error
    );
    return false;
  }
}

async function cleanupExistingDeployment(serviceName) {
  try {
    // Check if container exists first
    const { stdout: containerList } = await executeCommand("docker", [
      "ps",
      "-a",
      "--format",
      "{{.Names}}",
    ]);
    if (containerList.includes(serviceName)) {
      // Stop container if it exists
      await executeCommand("docker", ["stop", serviceName]).catch((error) => {
        logger.warn(`Failed to stop container ${serviceName}:`, error.message);
      });

      // Remove container if it exists
      await executeCommand("docker", ["rm", serviceName]).catch((error) => {
        logger.warn(
          `Failed to remove container ${serviceName}:`,
          error.message
        );
      });
    }

    // Check if network exists first
    const { stdout: networkList } = await executeCommand("docker", [
      "network",
      "ls",
      "--format",
      "{{.Name}}",
    ]);
    const networkName = `${serviceName}-network`;
    if (networkList.includes(networkName)) {
      // Remove network if it exists
      await executeCommand("docker", ["network", "rm", networkName]).catch(
        (error) => {
          logger.warn(
            `Failed to remove network ${networkName}:`,
            error.message
          );
        }
      );
    }

    // Remove any dangling images
    const { stdout: imageList } = await executeCommand("docker", [
      "images",
      "-q",
      "-f",
      "dangling=true",
    ]);
    if (imageList) {
      await executeCommand("docker", ["rmi", ...imageList.split("\n")]).catch(
        (error) => {
          logger.warn("Failed to remove dangling images:", error.message);
        }
      );
    }

    return true;
  } catch (error) {
    logger.warn("Cleanup warning:", error);
    return false;
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

    // Check if container is connected to traefik network
    if (!networkInfo.includes("traefik-proxy")) {
      throw new Error("Container is not connected to traefik-proxy network");
    }

    // Get detailed port bindings
    logger.info(`Checking port bindings for ${containerName}...`);
    const { stdout: portBindings } = await executeCommand("docker", [
      "inspect",
      "--format",
      "{{range $p, $conf := .NetworkSettings.Ports}}{{$p}} -> {{range $conf}}{{.HostIp}}:{{.HostPort}}{{end}}{{println}}{{end}}",
      containerName,
    ]);

    logger.info("Port bindings:", portBindings);

    // Check both host port and container port accessibility
    logger.info(`Checking ports accessibility...`);

    // Check host port
    const hostPortCheck = await checkPort(port);
    logger.info(`Host port ${port} accessible: ${hostPortCheck}`);

    // Check container port internally
    const containerPortCheck = await checkContainerPort(containerName, "8080");
    logger.info(`Container port 8080 accessible: ${containerPortCheck}`);

    if (!hostPortCheck && !containerPortCheck) {
      // Get netstat information for debugging
      const { stdout: netstatOutput } = await executeCommand("netstat", [
        "-tulpn",
      ]);
      logger.error("Ports not accessible. Current port usage:", netstatOutput);

      // Get recent container logs
      const { stdout: logs } = await executeCommand("docker", [
        "logs",
        "--tail",
        "50",
        containerName,
      ]);
      logger.error("Recent container logs:", logs);

      throw new Error(
        `Neither host port ${port} nor container port 8080 is accessible`
      );
    }

    // Check application health endpoint through Traefik if domain provided
    if (domain) {
      logger.info(`Verifying Traefik configuration for ${domain}`);

      // Check Traefik router status
      const { stdout: traefikStatus } = await executeCommand("docker", [
        "exec",
        "traefik-proxy",
        "traefik",
        "healthcheck",
      ]).catch(() => ({ stdout: "Traefik healthcheck failed" }));
      logger.info("Traefik status:", traefikStatus);

      // Test domain through Traefik
      try {
        logger.info(`Testing domain access through Traefik: ${domain}`);
        await executeCommand("curl", [
          "--max-time",
          "5",
          "-k", // Allow self-signed certificates during check
          "-H",
          `Host: ${domain}`,
          "https://localhost/health",
        ]);
        logger.info("Domain is accessible through Traefik");
      } catch (error) {
        logger.warn("Domain check through Traefik failed:", error.message);
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
    // Check if container exists first
    const { stdout: containerList } = await executeCommand("docker", [
      "ps",
      "-a",
      "--format",
      "{{.Names}}",
    ]);
    if (containerList.includes(serviceName)) {
      // Stop container if it exists
      await executeCommand("docker", ["stop", serviceName]).catch((error) => {
        logger.warn(`Failed to stop container ${serviceName}:`, error.message);
      });

      // Remove container if it exists
      await executeCommand("docker", ["rm", serviceName]).catch((error) => {
        logger.warn(
          `Failed to remove container ${serviceName}:`,
          error.message
        );
      });
    }

    // Check if network exists first
    const { stdout: networkList } = await executeCommand("docker", [
      "network",
      "ls",
      "--format",
      "{{.Name}}",
    ]);
    const networkName = `${serviceName}-network`;
    if (networkList.includes(networkName)) {
      // Remove network if it exists
      await executeCommand("docker", ["network", "rm", networkName]).catch(
        (error) => {
          logger.warn(
            `Failed to remove network ${networkName}:`,
            error.message
          );
        }
      );
    }

    // Remove any dangling images
    const { stdout: imageList } = await executeCommand("docker", [
      "images",
      "-q",
      "-f",
      "dangling=true",
    ]);
    if (imageList) {
      await executeCommand("docker", ["rmi", ...imageList.split("\n")]).catch(
        (error) => {
          logger.warn("Failed to remove dangling images:", error.message);
        }
      );
    }

    return true;
  } catch (error) {
    logger.warn("Cleanup warning:", error);
    return false;
  }
}

module.exports = deployApp;
