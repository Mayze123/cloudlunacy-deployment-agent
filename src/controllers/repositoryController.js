/**
 * Repository Controller
 *
 * Handles repository access checking and validation.
 */

const { execSync } = require("child_process");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const logger = require("../../utils/logger");

class RepositoryController {
  /**
   * Check if the agent has access to a repository
   * @param {Object} payload - Repository information
   * @param {WebSocket} ws - WebSocket connection to respond on
   */
  async checkRepositoryAccess(payload, ws) {
    const tempDir = path.join(os.tmpdir(), `repo-check-${Date.now()}`);
    let accessGranted = false;
    let errorMessage = null;

    try {
      logger.info(
        `Checking access to repository: ${payload.repoOwner}/${payload.repoName}`,
      );

      // Validate payload
      this.validateRepositoryPayload(payload);

      // Create temporary directory for cloning
      await fs.mkdir(tempDir, { recursive: true });

      // Prepare git command based on authentication method
      let gitCommand = "";

      if (payload.githubToken) {
        // Clone with GitHub token
        gitCommand = `git clone https://${payload.githubToken}@github.com/${payload.repoOwner}/${payload.repoName}.git --depth 1 --branch ${payload.branch || "main"} ${tempDir}`;
      } else if (payload.sshKey) {
        // Clone with SSH key
        const sshKeyPath = path.join(os.tmpdir(), `github-ssh-${Date.now()}`);
        await fs.writeFile(sshKeyPath, payload.sshKey, { mode: 0o600 });

        // Use GIT_SSH_COMMAND to specify the identity file
        gitCommand = `GIT_SSH_COMMAND="ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no" git clone git@github.com:${payload.repoOwner}/${payload.repoName}.git --depth 1 --branch ${payload.branch || "main"} ${tempDir}`;
      } else {
        // Clone public repository
        gitCommand = `git clone https://github.com/${payload.repoOwner}/${payload.repoName}.git --depth 1 --branch ${payload.branch || "main"} ${tempDir}`;
      }

      // Execute git clone
      execSync(gitCommand, { stdio: "pipe" });
      accessGranted = true;

      // Check for package.json or other indicators of app type
      const appType = await this.detectAppType(tempDir);

      // Send success response
      this.sendResponse(ws, {
        type: "repository_check_result",
        success: true,
        repoOwner: payload.repoOwner,
        repoName: payload.repoName,
        branch: payload.branch || "main",
        accessGranted,
        appType,
        requestId: payload.requestId,
      });
    } catch (error) {
      logger.error(`Repository access check failed: ${error.message}`);
      errorMessage = error.message;

      // Send error response
      this.sendResponse(ws, {
        type: "repository_check_result",
        success: false,
        repoOwner: payload.repoOwner,
        repoName: payload.repoName,
        branch: payload.branch || "main",
        accessGranted: false,
        error: errorMessage,
        requestId: payload.requestId,
      });
    } finally {
      // Clean up the temporary directory
      try {
        await this.cleanupTempDir(tempDir);
      } catch (cleanupError) {
        logger.warn(
          `Failed to clean up temporary directory: ${cleanupError.message}`,
        );
      }
    }
  }

  /**
   * Validate repository check payload
   * @param {Object} payload - Repository check payload
   * @throws {Error} If validation fails
   */
  validateRepositoryPayload(payload) {
    const requiredFields = ["repoOwner", "repoName"];
    const missingFields = requiredFields.filter((field) => !payload[field]);

    if (missingFields.length > 0) {
      throw new Error(
        `Missing required repository fields: ${missingFields.join(", ")}`,
      );
    }

    if (payload.isPrivate === true && !payload.githubToken && !payload.sshKey) {
      throw new Error(
        "Private repository requires either a GitHub token or SSH key for authentication",
      );
    }
  }

  /**
   * Detect the application type from the repository contents
   * @param {string} repoDir - Path to the cloned repository
   * @returns {string} - Detected application type
   */
  async detectAppType(repoDir) {
    try {
      // Check for package.json
      const packageJsonPath = path.join(repoDir, "package.json");
      const packageJsonExists = await this.fileExists(packageJsonPath);

      if (packageJsonExists) {
        const packageJson = JSON.parse(
          await fs.readFile(packageJsonPath, "utf8"),
        );

        // Check for specific dependencies to determine app type
        const dependencies = {
          ...packageJson.dependencies,
          ...packageJson.devDependencies,
        };

        if (dependencies.next) {
          return "nextjs";
        } else if (dependencies.react) {
          return "react";
        } else if (dependencies.express) {
          return "nodejs";
        } else if (dependencies.vue) {
          return "vue";
        } else if (dependencies.angular) {
          return "angular";
        }

        return "nodejs"; // Default for package.json
      }

      // Check for other project type indicators
      const composerJsonPath = path.join(repoDir, "composer.json");
      if (await this.fileExists(composerJsonPath)) {
        return "php";
      }

      const requirementsPath = path.join(repoDir, "requirements.txt");
      if (await this.fileExists(requirementsPath)) {
        return "python";
      }

      const gemfilePath = path.join(repoDir, "Gemfile");
      if (await this.fileExists(gemfilePath)) {
        return "ruby";
      }

      const goModPath = path.join(repoDir, "go.mod");
      if (await this.fileExists(goModPath)) {
        return "golang";
      }

      // Default to static if nothing specific is detected
      return "static";
    } catch (error) {
      logger.warn(`Failed to detect app type: ${error.message}`);
      return "unknown";
    }
  }

  /**
   * Check if a file exists
   * @param {string} filePath - Path to the file
   * @returns {Promise<boolean>} - Whether the file exists
   */
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up temporary directory
   * @param {string} dirPath - Path to the directory to clean up
   */
  async cleanupTempDir(dirPath) {
    try {
      if (os.platform() === "win32") {
        execSync(`rmdir /s /q "${dirPath}"`, { stdio: "ignore" });
      } else {
        execSync(`rm -rf "${dirPath}"`, { stdio: "ignore" });
      }
    } catch (error) {
      logger.warn(`Failed to remove directory ${dirPath}: ${error.message}`);
    }
  }

  /**
   * Send a response over the WebSocket
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} data - Response data
   */
  sendResponse(ws, data) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    } else {
      logger.warn("Unable to send response: WebSocket not connected");
    }
  }
}

module.exports = new RepositoryController();
