/**
 * Permission Check Utility
 *
 * Ensures the agent has necessary permissions for deployment operations.
 */

const fs = require("fs").promises;
const { execSync } = require("child_process");
const logger = require("./logger");
const path = require("path");

/**
 * Checks if the deployment directory has proper permissions
 * @param {string} deployDir - Deployment directory path
 * @returns {Promise<boolean>} - Whether the permission check passed
 */
async function checkDeploymentDirPermissions(deployDir) {
  try {
    // Check if directory exists
    try {
      await fs.access(deployDir);
    } catch (error) {
      logger.info(`Creating deployment directory: ${deployDir}`);
      await fs.mkdir(deployDir, { recursive: true });
    }

    // Write a test file to check permissions
    const testFile = path.join(deployDir, ".permission-test");
    await fs.writeFile(testFile, "test");
    await fs.unlink(testFile);

    return true;
  } catch (error) {
    logger.error(`Permission check failed for ${deployDir}: ${error.message}`);
    return false;
  }
}

/**
 * Checks if Docker is available and properly configured
 * @returns {Promise<boolean>} - Whether the Docker check passed
 */
async function checkDockerPermissions() {
  try {
    // Just run a simple docker command to check if we have access
    execSync("docker ps", { stdio: "pipe" });
    return true;
  } catch (error) {
    logger.error(`Docker permission check failed: ${error.message}`);
    return false;
  }
}

/**
 * Ensures the agent has all necessary permissions for deployment operations
 * @returns {Promise<boolean>} - Whether all permission checks passed
 */
async function ensureDeploymentPermissions() {
  // Skip permission check if in development mode or explicitly skipped
  if (
    process.env.SKIP_PERMISSION_CHECK === "true" ||
    process.env.NODE_ENV === "development"
  ) {
    logger.info(
      "Skipping deployment permission check (development mode or explicitly skipped)",
    );
    return true;
  }

  logger.info("Checking deployment permissions...");

  // Get deployment directory from environment or use default
  const deployDir =
    process.env.DEPLOY_BASE_DIR || "/opt/cloudlunacy/deployments";

  // Run all permission checks
  const dirPermissionCheck = await checkDeploymentDirPermissions(deployDir);
  const dockerPermissionCheck = await checkDockerPermissions();

  if (!dirPermissionCheck) {
    logger.error(
      `Directory permission check failed for ${deployDir}. Please check permissions.`,
    );
  }

  if (!dockerPermissionCheck) {
    logger.error(
      "Docker permission check failed. Please ensure Docker is installed and the user has proper permissions.",
    );
  }

  const allChecksPass = dirPermissionCheck && dockerPermissionCheck;

  if (allChecksPass) {
    logger.info("All permission checks passed successfully");
  } else {
    logger.error(
      "Some permission checks failed. Deployment functionality may be limited.",
    );
  }

  return allChecksPass;
}

module.exports = {
  ensureDeploymentPermissions,
  checkDeploymentDirPermissions,
  checkDockerPermissions,
};
