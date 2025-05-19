// utils/nixpacksBuilder.js
const { executeCommand } = require("./executor");
const fsPromises = require("fs").promises;
const fs = require("fs");
const path = require("path");
const os = require("os");
const logger = require("./logger");

class NixpacksBuilder {
  /**
   * Builds a Docker image using Nixpacks
   *
   * @param {Object} options - Build options
   * @param {string} options.projectDir - Path to the project directory
   * @param {string} options.imageName - Name for the built image (including tag)
   * @param {Object} options.envVars - Environment variables for the build
   * @returns {Promise<string>} - Image ID or imageName if not found
   */
  async buildImage({ projectDir, imageName, envVars = {} }) {
    if (!projectDir || !fs.existsSync(projectDir)) {
      throw new Error(`Project directory does not exist: ${projectDir}`);
    }

    await this.ensureNixpacksInstalled();

    // Assemble CLI args
    const args = ["build", projectDir, "--name", imageName];
    Object.entries(envVars).forEach(([key, value]) => {
      if (value != null) args.push("--env", `${key}=${value}`);
      else logger.warn(`Skipping null/undefined env var: ${key}`);
    });

    logger.info(`Building image with Nixpacks: ${imageName}`);
    logger.debug(`Command: nixpacks ${args.join(" ")}`);

    const { stdout, stderr } = await executeCommand("nixpacks", args);
    const match = stdout.match(/Successfully built (\w+)/);
    if (match) logger.info(`Built image ID: ${match[1]}`);
    else logger.warn(`No image ID parsed, defaulting to name`);

    return match ? match[1] : imageName;
  }

  async ensureNixpacksInstalled() {
    try {
      await executeCommand("nixpacks", ["--version"]);
      logger.info("Nixpacks installed");
    } catch {
      logger.warn("Nixpacks not found, installing via npm...");
      await executeCommand("npm", ["install", "-g", "nixpacks"]);
    }
  }
}

module.exports = new NixpacksBuilder();
