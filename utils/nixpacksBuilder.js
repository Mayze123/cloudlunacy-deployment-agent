// utils/nixpacksBuilder.js
const { executeCommand } = require("./executor");
const fsPromises = require("fs").promises;
const fs = require("fs");
const path = require("path");
const os = require("os");
const logger = require("./logger");
const nixpacksPlansManager = require("./nixpacksPlansManager");

/**
 * Helper to check if sudo is available without prompting for password
 * @returns {Promise<boolean>} - True if sudo is available without a password
 */
async function checkSudoAvailability() {
  try {
    await executeCommand("sudo", ["-n", "true"], {
      silent: true,
      ignoreError: true,
    });
    return true;
  } catch (error) {
    // If the error message contains "sudo: a password is required", then sudo is available but needs a password
    if (error.message && error.message.includes("password")) {
      logger.info("Sudo is available but requires a password");
      return true;
    }
    logger.debug("Sudo is not available");
    return false;
  }
}

/**
 * Helper to check if a file exists asynchronously
 * @param {string} filePath - Path to check
 * @returns {Promise<boolean>} - True if file exists
 */
async function fileExists(filePath) {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

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
      // Validate input paths
      if (!projectDir || !fs.existsSync(projectDir)) {
        throw new Error(`Project directory does not exist: ${projectDir}`);
      }

      // Check if Nixpacks is installed or install it
      try {
        await this.checkNixpacksInstallation();
      } catch (nixpacksError) {
        logger.error(`Failed to set up Nixpacks: ${nixpacksError.message}`);

        // Check if Docker is available as an alternative
        const hasDocker = await this.detectAvailableTools().then(
          (tools) => tools.docker,
        );
        if (hasDocker) {
          logger.info("Attempting direct Docker build as a fallback...");
          return await this.fallbackToDockerBuild({
            projectDir,
            imageName,
            envVars,
          });
        } else {
          throw new Error(
            `Nixpacks could not be installed and Docker is not available. Cannot build the image.`,
          );
        }
      }

      // Prepare the command
      const args = ["build", projectDir, "--name", imageName];

      // Add environment variables
      for (const [key, value] of Object.entries(envVars)) {
        if (value !== undefined && value !== null) {
          args.push("--env", `${key}=${value}`);
        } else {
          logger.warn(`Skipping undefined/null environment variable: ${key}`);
        }
      }

      // Add build plan if specified
      if (buildPlan) {
        const planPath = path.join(projectDir, "nixpacks-plan.json");
        await fsPromises.writeFile(
          planPath,
          JSON.stringify(buildPlan, null, 2),
        );
        args.push("--json-plan", planPath);
        logger.info(`Using custom build plan at ${planPath}`);
      }

      // Add config file if specified
      if (configFile) {
        if (fs.existsSync(configFile)) {
          args.push("--config", configFile);
          logger.info(`Using config file: ${configFile}`);
        } else {
          logger.warn(`Config file not found, skipping: ${configFile}`);
        }
      }

      // Execute the Nixpacks build command
      logger.info(`Building image with Nixpacks: ${imageName}`);
      logger.debug(`Full Nixpacks command: nixpacks ${args.join(" ")}`);

      const { stdout, stderr } = await executeCommand("nixpacks", args);

      // Extract the image ID from the output
      const imageIdMatch = stdout.match(/Successfully built (\w+)/);
      const imageId = imageIdMatch ? imageIdMatch[1] : null;

      if (!imageId) {
        logger.warn(`Could not extract image ID from Nixpacks output`);
        logger.debug(`Nixpacks stdout: ${stdout}`);
        logger.debug(`Nixpacks stderr: ${stderr}`);
      } else {
        logger.info(`Successfully built image with ID: ${imageId}`);
      }

      return imageId || imageName;
    } catch (error) {
      logger.error(`Failed to build image with Nixpacks: ${error.message}`);
      if (error.stderr) {
        logger.error(`Build error details: ${error.stderr}`);
      }
      throw new Error(`Nixpacks build failed: ${error.message}`);
    }
  }

  /**
   * Fallback method to build directly with Docker when Nixpacks is not available
   */
  async fallbackToDockerBuild({ projectDir, imageName, envVars = {} }) {
    logger.info("Using Docker build fallback method...");

    // Create a simple Dockerfile based on the project type
    const dockerfilePath = path.join(projectDir, "Dockerfile");

    // Check if Dockerfile already exists
    if (fs.existsSync(dockerfilePath)) {
      logger.info("Using existing Dockerfile in the project");
    } else {
      // Try to detect project type and create an appropriate Dockerfile
      const projectType = await this.detectProjectType(projectDir);
      logger.info(`Detected project type: ${projectType}`);

      const dockerfile = this.generateDockerfile(projectType, envVars);
      await fsPromises.writeFile(dockerfilePath, dockerfile);
      logger.info(`Created simple Dockerfile for ${projectType} project`);
    }

    // Build the image
    try {
      logger.info(`Building Docker image: ${imageName}`);
      await executeCommand("docker", ["build", "-t", imageName, projectDir]);
      logger.info(`Successfully built Docker image: ${imageName}`);
      return imageName;
    } catch (error) {
      logger.error(`Docker build failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Detects the type of project based on files in the directory
   */
  async detectProjectType(projectDir) {
    try {
      const files = await fsPromises.readdir(projectDir);

      // Check for package.json (Node.js)
      if (files.includes("package.json")) {
        // Read package.json to check for specific frameworks
        const packageJsonPath = path.join(projectDir, "package.json");
        const packageJson = JSON.parse(
          await fsPromises.readFile(packageJsonPath, "utf8"),
        );

        if (packageJson.dependencies) {
          if (packageJson.dependencies.react) return "react";
          if (packageJson.dependencies.next) return "nextjs";
          if (packageJson.dependencies.express) return "nodejs-express";
        }

        return "nodejs";
      }

      // Check for Python project
      if (
        files.some((file) => file.endsWith(".py")) ||
        files.includes("requirements.txt")
      ) {
        return "python";
      }

      // Check for Ruby project
      if (files.includes("Gemfile")) {
        return "ruby";
      }

      // Default
      return "unknown";
    } catch (error) {
      logger.warn(`Error detecting project type: ${error.message}`);
      return "unknown";
    }
  }

  /**
   * Generates a basic Dockerfile based on the detected project type
   */
  generateDockerfile(projectType, envVars = {}) {
    // Get the PORT env var or default to 3000
    const port = envVars.PORT || process.env.PORT || 3000;

    switch (projectType) {
      case "nodejs":
      case "nodejs-express":
        return `FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
ENV PORT=${port}
${Object.entries(envVars)
  .map(([key, value]) => `ENV ${key}=${value}`)
  .join("\n")}
EXPOSE ${port}
CMD ["npm", "start"]`;

      case "react":
        return `FROM node:18-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE ${port}
CMD ["nginx", "-g", "daemon off;"]`;

      case "nextjs":
        return `FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
${Object.entries(envVars)
  .map(([key, value]) => `ENV ${key}=${value}`)
  .join("\n")}
EXPOSE ${port}
CMD ["npm", "start"]`;

      case "python":
        return `FROM python:3.9-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
${Object.entries(envVars)
  .map(([key, value]) => `ENV ${key}=${value}`)
  .join("\n")}
EXPOSE ${port}
CMD ["python", "app.py"]`;

      case "ruby":
        return `FROM ruby:3.0-slim
WORKDIR /app
COPY Gemfile Gemfile.lock ./
RUN bundle install
COPY . .
${Object.entries(envVars)
  .map(([key, value]) => `ENV ${key}=${value}`)
  .join("\n")}
EXPOSE ${port}
CMD ["ruby", "app.rb"]`;

      default:
        return `FROM alpine:latest
WORKDIR /app
COPY . .
${Object.entries(envVars)
  .map(([key, value]) => `ENV ${key}=${value}`)
  .join("\n")}
EXPOSE ${port}
CMD ["/bin/sh", "-c", "echo 'Add your build commands here'; tail -f /dev/null"]`;
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
    // Use the plans manager to generate a build plan
    return nixpacksPlansManager.generateBuildPlan({
      appType: appType.toLowerCase(),
      containerPort,
      additionalPorts,
      healthCheck,
    });
  }

  /**
   * Checks if Nixpacks is installed and installs it if not
   */
  async checkNixpacksInstallation() {
    try {
      await executeCommand("nixpacks", ["--version"]);
      logger.info("Nixpacks is already installed");
      return;
    } catch (error) {
      // Check if we're in a skip-installation mode (this can be set in config or .env)
      const skipAutoInstall = process.env.NIXPACKS_SKIP_AUTO_INSTALL === "true";

      if (skipAutoInstall) {
        logger.warn(
          "Nixpacks auto-installation is disabled by configuration. Throwing error...",
        );
        throw new Error(
          "Nixpacks is not installed and auto-installation is disabled",
        );
      }

      logger.warn(
        "Nixpacks is not installed. Trying to install it automatically...",
      );

      // First, determine which tools are available in the environment
      const availableTools = await this.detectAvailableTools();
      logger.info(
        `Available tools: ${Object.keys(availableTools)
          .filter((tool) => availableTools[tool])
          .join(", ")}`,
      );

      // Prioritize installation methods based on available tools
      const installMethods = [];

      if (availableTools.npm) {
        installMethods.push({
          method: this.installWithNpm.bind(this),
          name: "npm",
        });
      }

      if (availableTools.curl) {
        installMethods.push({
          method: this.installWithCurl.bind(this),
          name: "curl",
        });
      }

      if (availableTools.brew) {
        installMethods.push({
          method: this.installWithBrew.bind(this),
          name: "brew",
        });
      }

      if (availableTools.docker) {
        installMethods.push({
          method: this.setupDockerFallback.bind(this),
          name: "docker fallback",
        });
      }

      // If no installation methods are available, throw an error
      if (installMethods.length === 0) {
        throw new Error(
          "No suitable installation method found for Nixpacks. " +
            "Please install one of: npm, curl, homebrew, or Docker.",
        );
      }

      // Try each installation method in order
      for (const { method, name } of installMethods) {
        try {
          logger.info(
            `Attempting to install/configure Nixpacks using ${name}...`,
          );
          await method();

          // Verify installation was successful
          try {
            await executeCommand("nixpacks", ["--version"]);
            logger.info(`✅ Nixpacks installed successfully using ${name}!`);
            return;
          } catch (verifyError) {
            logger.warn(
              `Installation with ${name} seemed to succeed but nixpacks command is still not found.`,
            );
          }
        } catch (methodError) {
          logger.warn(
            `Installation with ${name} failed: ${methodError.message}`,
          );
          // Continue to the next method
        }
      }

      // If we get here, all installation methods have failed
      throw new Error(
        "Failed to install Nixpacks automatically after trying all available methods. " +
          "Please install it manually: https://nixpacks.com/docs/getting-started " +
          "or try running with Docker directly.",
      );
    }
  }

  /**
   * Detects which tools are available in the environment
   */
  async detectAvailableTools() {
    const tools = {
      npm: false,
      curl: false,
      brew: false,
      docker: false,
    };

    // Helper function to check if a command exists
    const checkCommand = async (cmd) => {
      try {
        await executeCommand(cmd, ["--version"], {
          silent: true,
          ignoreError: true,
          logOutput: false,
        });
        return true;
      } catch (error) {
        return false;
      }
    };

    // Check each tool
    tools.npm = await checkCommand("npm");
    tools.curl = await checkCommand("curl");
    tools.brew = await checkCommand("brew");
    tools.docker = await checkCommand("docker");

    return tools;
  }

  /**
   * Install Nixpacks using npm
   */
  async installWithNpm() {
    logger.info("Trying to install Nixpacks using npm...");
    await executeCommand("npm", ["install", "-g", "nixpacks"]);
  }

  /**
   * Install Nixpacks using curl (bash script)
   */
  async installWithCurl() {
    logger.info("Trying to install Nixpacks using curl...");
    // Create a temporary script file
    const tempScriptPath = path.join(os.tmpdir(), "install-nixpacks.sh");

    try {
      // Fetch the install script
      await executeCommand("curl", [
        "-sSL",
        "https://nixpacks.com/install.sh",
        "-o",
        tempScriptPath,
      ]);

      // Make it executable
      await executeCommand("chmod", ["+x", tempScriptPath]);

      try {
        // Try normal execution first (when we have correct permissions)
        await executeCommand(tempScriptPath, [], { timeout: 60000 });
      } catch (err) {
        logger.warn(`Standard execution failed: ${err.message}`);

        // Try with sudo if available
        const hasSudo = await checkSudoAvailability();

        if (hasSudo) {
          logger.info(
            "Attempting installation with elevated privileges (sudo)",
          );
          await executeCommand("sudo", [tempScriptPath], { timeout: 60000 });
        } else {
          throw new Error(
            "Installation requires elevated privileges, but sudo is not available",
          );
        }
      }

      return true;
    } catch (error) {
      logger.error(`Curl installation failed: ${error.message}`);
      throw error;
    } finally {
      // Clean up
      try {
        fs.unlinkSync(tempScriptPath);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Install Nixpacks using Homebrew
   */
  async installWithBrew() {
    logger.info("Trying to install Nixpacks using brew...");
    await executeCommand("brew", ["install", "nixpacks"]);
  }

  /**
   * Sets up a Docker-based fallback for Nixpacks
   * Instead of installing Nixpacks directly, this creates a wrapper script
   * that uses the Nixpacks Docker image to perform the same operations
   */
  async setupDockerFallback() {
    logger.info("Setting up Docker-based fallback for Nixpacks...");

    // Try multiple possible directory locations in order of preference
    const possiblePaths = [
      // User directories (no sudo required)
      path.join(os.homedir(), ".local", "bin"),
      path.join(os.homedir(), "bin"),

      // System directories (may require sudo)
      "/usr/local/bin",
      "/usr/bin",
    ];

    let nixpacksWrapperPath = null;
    let nixpacksWrapperFile = null;

    // Try each possible location until we find one we can write to
    for (const candidatePath of possiblePaths) {
      try {
        await fsPromises.mkdir(candidatePath, { recursive: true });
        nixpacksWrapperPath = candidatePath;
        nixpacksWrapperFile = path.join(candidatePath, "nixpacks");

        // Test if we can write to this directory
        const testFile = path.join(candidatePath, ".test-write-permission");
        await fsPromises.writeFile(testFile, "");
        await fsPromises.unlink(testFile);

        logger.info(
          `Using directory ${nixpacksWrapperPath} for the wrapper script`,
        );
        break;
      } catch (err) {
        logger.debug(`Cannot use directory ${candidatePath}: ${err.message}`);
      }
    }

    // If we couldn't find any writable directory, try the first one with sudo
    if (!nixpacksWrapperPath) {
      nixpacksWrapperPath = possiblePaths[0];
      nixpacksWrapperFile = path.join(nixpacksWrapperPath, "nixpacks");
      logger.info(
        `Fallback to creating wrapper at ${nixpacksWrapperPath} (may require sudo)`,
      );

      try {
        await fsPromises.mkdir(nixpacksWrapperPath, { recursive: true });
      } catch (err) {
        if (err.code !== "EEXIST") {
          logger.warn(
            `Cannot create directory ${nixpacksWrapperPath}: ${err.message}`,
          );
        }
      }
    }

    // Create the wrapper script
    const wrapperScript = `#!/bin/sh
# Nixpacks Docker wrapper script
# Generated by CloudLunacy Deployment Agent

NIXPACKS_IMAGE="railwayapp/nixpacks:latest"

# Pull the image silently if it doesn't exist
if ! docker image inspect $NIXPACKS_IMAGE >/dev/null 2>&1; then
  echo "Pulling Nixpacks Docker image (one-time setup)..."
  docker pull $NIXPACKS_IMAGE >/dev/null
fi

# Map the current directory and pass all arguments to the container
exec docker run --rm -v "$(pwd):/workspace" -w "/workspace" $NIXPACKS_IMAGE "$@"
`;

    try {
      await fsPromises.writeFile(nixpacksWrapperFile, wrapperScript);
      await fsPromises.chmod(nixpacksWrapperFile, "755"); // Make executable
      logger.info(`Created Nixpacks Docker wrapper at ${nixpacksWrapperFile}`);
    } catch (err) {
      logger.warn(`Failed to write wrapper script: ${err.message}`);

      // Create a temporary file that the user can move manually
      const tmpWrapperFile = path.join(os.tmpdir(), "nixpacks");
      await fsPromises.writeFile(tmpWrapperFile, wrapperScript);
      await fsPromises.chmod(tmpWrapperFile, "755");

      logger.warn(`Created temporary wrapper at ${tmpWrapperFile}`);
      logger.warn(`Please move it to a directory in your PATH:`);
      logger.warn(
        `sudo mv ${tmpWrapperFile} /usr/local/bin/ && sudo chmod +x /usr/local/bin/nixpacks`,
      );

      // Try to use the temporary wrapper
      nixpacksWrapperFile = tmpWrapperFile;
    }

    // Add to PATH if not already in path
    const currentPath = process.env.PATH || "";
    if (
      nixpacksWrapperPath &&
      !currentPath.split(":").includes(nixpacksWrapperPath)
    ) {
      process.env.PATH = `${nixpacksWrapperPath}:${currentPath}`;
      logger.info(`Added ${nixpacksWrapperPath} to PATH for current session`);

      // Add to profile files for persistence
      try {
        const profileFiles = [
          path.join(os.homedir(), ".profile"),
          path.join(os.homedir(), ".bashrc"),
          path.join(os.homedir(), ".zshrc"),
        ];

        const profileContent = `
# Added by CloudLunacy Deployment Agent for Nixpacks
export PATH="${nixpacksWrapperPath}:$PATH"
`;

        for (const profilePath of profileFiles) {
          if (await fileExists(profilePath)) {
            // Check if entry already exists
            const content = await fsPromises.readFile(profilePath, "utf8");
            if (!content.includes(`${nixpacksWrapperPath}:$PATH`)) {
              await fsPromises.appendFile(profilePath, profileContent);
              logger.info(
                `Added ${nixpacksWrapperPath} to PATH in ${profilePath}`,
              );
            }
          }
        }
      } catch (err) {
        logger.warn(
          `Failed to update profile for persistent PATH: ${err.message}`,
        );
      }
    }

    // Test the wrapper
    try {
      await executeCommand(nixpacksWrapperFile, ["--version"], {
        silent: true,
      });
      logger.info("Docker-based Nixpacks wrapper is working correctly");
      return true;
    } catch (error) {
      logger.error(
        `Failed to run Docker-based Nixpacks wrapper: ${error.message}`,
      );
      throw error;
    }
  }
}

module.exports = new NixpacksBuilder();
