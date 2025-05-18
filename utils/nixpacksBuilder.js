// utils/nixpacksBuilder.js
const { executeCommand } = require("./executor");
const fs = require("fs").promises;
const path = require("path");
const logger = require("./logger");

class NixpacksBuilder {
  /**
   * Builds a Docker image using Nixpacks
   *
   * @param {Object} options - Build options
   * @param {string} options.projectDir - Path to the project directory
   * @param {string} options.imageName - Name for the built image (including tag)
   * @param {Object} options.envVars - Environment variables for the build
   * @param {string} options.buildPlan - Optional custom build plan
   * @param {string} options.configFile - Optional Nixpacks config file path
   * @returns {Promise<string>} - Image ID
   */
  async buildImage({
    projectDir,
    imageName,
    envVars = {},
    buildPlan = null,
    configFile = null,
  }) {
    try {
      // Check if Nixpacks is installed
      await this.checkNixpacksInstallation();

      // Prepare the command
      const args = ["build", projectDir, "--name", imageName];

      // Add environment variables
      for (const [key, value] of Object.entries(envVars)) {
        args.push("--env", `${key}=${value}`);
      }

      // Add build plan if specified
      if (buildPlan) {
        const planPath = path.join(projectDir, "nixpacks-plan.json");
        await fs.writeFile(planPath, JSON.stringify(buildPlan, null, 2));
        args.push("--plan", planPath);
      }

      // Add config file if specified
      if (configFile) {
        args.push("--config", configFile);
      }

      // Execute the Nixpacks build command
      logger.info(`Building image with Nixpacks: ${imageName}`);
      const { stdout, stderr } = await executeCommand("nixpacks", args);

      // Extract the image ID from the output
      const imageIdMatch = stdout.match(/Successfully built (\w+)/);
      const imageId = imageIdMatch ? imageIdMatch[1] : null;

      if (!imageId) {
        logger.warn(`Could not extract image ID from Nixpacks output`);
        logger.debug(`Nixpacks stdout: ${stdout}`);
        logger.debug(`Nixpacks stderr: ${stderr}`);
      }

      return imageId || imageName;
    } catch (error) {
      logger.error(`Failed to build image with Nixpacks: ${error.message}`);
      throw new Error(`Nixpacks build failed: ${error.message}`);
    }
  }

  /**
   * Creates a custom build plan for Nixpacks with support for multiple ports
   *
   * @param {Object} options - Build plan options
   * @param {string} options.appType - Application type (node, react, etc.)
   * @param {number} options.containerPort - Primary port to expose
   * @param {Object} options.healthCheck - Health check configuration
   * @param {Array<{port: number, protocol: string, description: string}>} options.additionalPorts - Additional ports to expose
   * @returns {Object} - Build plan object
   */
  createBuildPlan({
    appType,
    containerPort,
    healthCheck,
    additionalPorts = [],
  }) {
    const plan = {
      providers: [],
      phases: {},
      variables: {
        PORT: containerPort.toString(),
      },
    };

    // Add additional ports to the variables
    if (additionalPorts && additionalPorts.length > 0) {
      additionalPorts.forEach((portConfig, index) => {
        plan.variables[`PORT_${index + 1}`] = portConfig.port.toString();
      });
    }

    // Configure based on app type
    switch (appType.toLowerCase()) {
      case "node":
        plan.providers.push("node");
        plan.phases.setup = {
          cmds: ["npm ci --only=production"],
        };
        plan.phases.build = {
          cmds: ["npm run build"],
        };
        plan.start = "npm start";
        break;

      case "react":
        plan.providers.push("node");
        plan.phases.setup = {
          cmds: ["npm ci"],
        };
        plan.phases.build = {
          cmds: ["npm run build"],
        };
        plan.phases.install = {
          cmds: ["npm install -g serve"],
        };
        plan.start = `serve -s build -l ${containerPort}`;
        break;

      // Add more app types here

      default:
        // Let Nixpacks auto-detect
        break;
    }

    // Add health check if provided
    if (healthCheck) {
      plan.healthcheck = {
        cmd: `curl -f http://localhost:${containerPort}${healthCheck.checkPath || "/health"}`,
        interval: healthCheck.interval || "30s",
        timeout: healthCheck.timeout || "5s",
        retries: healthCheck.retries || 3,
        start_period: healthCheck.start_period || "40s",
      };
    }

    return plan;
  }

  /**
   * Checks if Nixpacks is installed and installs it if not
   */
  async checkNixpacksInstallation() {
    try {
      await executeCommand("nixpacks", ["--version"]);
    } catch (error) {
      logger.warn("Nixpacks is not installed. Trying to install it...");

      try {
        await executeCommand("brew", ["install", "nixpacks"]);
        logger.info("Nixpacks installed successfully!");
      } catch (installError) {
        throw new Error(
          `Failed to install Nixpacks: ${installError.message}. ` +
            "Please install it manually: https://nixpacks.com/docs/getting-started",
        );
      }
    }
  }
}

module.exports = new NixpacksBuilder();
