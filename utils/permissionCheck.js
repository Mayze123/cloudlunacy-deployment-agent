// utils/permissionCheck.js

const fs = require("fs").promises;
const { execSync } = require("child_process");
const path = require("path");
const logger = require("./logger");

async function ensureDeploymentPermissions() {
  try {
    // Skip permission check in development mode
    if (process.env.SKIP_PERMISSION_CHECK === "true") {
      logger.info("Skipping permission check in development mode");
      return true;
    }

    // Ensure deployment directories exist
    const dirs = [
      "/opt/cloudlunacy/deployments",
      "/tmp/cloudlunacy-deployments",
    ];

    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true, mode: 0o775 });
    }

    // Check if running as cloudlunacy user
    let currentUser;
    try {
      currentUser = execSync("whoami").toString().trim();
    } catch (error) {
      logger.warn("Could not determine current user, continuing anyway");
      currentUser = "unknown";
    }

    if (currentUser !== "cloudlunacy" && currentUser !== "root") {
      logger.warn(
        `Running as ${currentUser} instead of cloudlunacy, but continuing in development mode`,
      );
    }

    // Check docker socket permissions
    try {
      const dockerSock = "/var/run/docker.sock";
      const dockerSockStats = await fs.stat(dockerSock);
      if ((dockerSockStats.mode & 0o777) !== 0o666) {
        logger.warn(
          "Docker socket permissions are not 666, deployment might fail",
        );
      }
    } catch (error) {
      logger.warn("Could not check Docker socket permissions:", error.message);
    }

    // Check if can run docker commands
    try {
      execSync("docker ps", { stdio: "ignore" });
    } catch (error) {
      logger.warn("Cannot execute docker commands. Please check permissions.");
    }

    return true;
  } catch (error) {
    logger.error("Permission check failed:", error);
    // In development mode, don't fail on permission issues
    if (process.env.NODE_ENV === "development") {
      logger.info("Continuing despite permission issues (development mode)");
      return true;
    }
    return false;
  }
}

module.exports = {
  ensureDeploymentPermissions,
};
