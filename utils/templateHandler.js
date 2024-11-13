const Handlebars = require("handlebars");
const fs = require("fs").promises;
const path = require("path");
const logger = require("./logger");
const { exec } = require("child_process");
const util = require("util");
const { executeCommand } = require("./executor");
const execAsync = util.promisify(exec);
const portManager = require("./portManager");

class TemplateHandler {
  constructor(templatesDir, deployConfig) {
    this.templatesDir = templatesDir;
    this.deployConfig = this.processConfigInheritance(deployConfig);
    this.templates = {};
    this.registerHelpers();
  }

  async init() {
    await this.ensureTemplatesExist();
  }

  async ensureTemplatesExist() {
    logger.info("Ensuring all required templates exist...");

    try {
      // Create base templates directory
      await fs.mkdir(this.templatesDir, { recursive: true });

      // Create nginx templates directory
      const nginxTemplateDir = path.join(this.templatesDir, "nginx");
      await fs.mkdir(nginxTemplateDir, { recursive: true });

      const virtualHostTemplate = `server {
    listen 80;
    server_name {{domain}};

    location / {
        proxy_pass http://127.0.0.1:{{port}};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Add timeout configurations
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:{{port}};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket specific timeouts
        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
    }
}`;

      // Write the template file
      const virtualHostPath = path.join(
        nginxTemplateDir,
        "virtual-host.template"
      );
      await fs.writeFile(virtualHostPath, virtualHostTemplate, "utf8");

      logger.info("Templates created successfully");
      return true;
    } catch (error) {
      logger.error("Failed to create templates:", error);
      throw error;
    }
  }

  processConfigInheritance(config) {
    const processedConfig = { ...config };

    for (const [type, typeConfig] of Object.entries(config)) {
      if (typeConfig.extends && config[typeConfig.extends]) {
        const parentConfig = config[typeConfig.extends];
        processedConfig[type] = {
          ...parentConfig,
          ...typeConfig,
          defaults: {
            ...parentConfig.defaults,
            ...typeConfig.defaults,
          },
        };
      }
    }

    return processedConfig;
  }

  registerHelpers() {
    Handlebars.registerHelper("json", function (context) {
      return JSON.stringify(context, null, 2);
    });

    Handlebars.registerHelper("envVar", function (name, value) {
      if (typeof value === "object") {
        value = JSON.stringify(value);
      }
      if (typeof value === "string") {
        value = value.replace(/"/g, '\\"');
      }
      return `${name}=${value}`;
    });

    Handlebars.registerHelper("concat", function (...args) {
      args.pop(); // Remove last argument (Handlebars options)
      return args.join("");
    });

    Handlebars.registerHelper("ifEquals", function (arg1, arg2, options) {
      return arg1 === arg2 ? options.fn(this) : options.inverse(this);
    });

    Handlebars.registerHelper("sanitize", function (text) {
      return text.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    });
  }

  async loadTemplate(templateName) {
    try {
      if (!this.templates[templateName]) {
        const templatePath = path.join(this.templatesDir, templateName);
        const templateContent = await fs.readFile(templatePath, "utf-8");

        // Validate template syntax before compiling
        try {
          const ast = Handlebars.parse(templateContent);
          if (!ast) {
            throw new Error("Invalid template syntax");
          }
        } catch (parseError) {
          logger.error(`Template parse error in ${templateName}:`, parseError);
          throw new Error(
            `Failed to parse template ${templateName}: ${parseError.message}`
          );
        }

        this.templates[templateName] = Handlebars.compile(templateContent, {
          strict: true,
          assumeObjects: true,
          preventIndent: true,
          noEscape: false,
        });

        logger.info(
          `Template ${templateName} loaded and validated successfully`
        );
      }
      return this.templates[templateName];
    } catch (error) {
      logger.error(`Error loading template ${templateName}:`, error);
      throw error;
    }
  }

  async validateTemplate(name, content, context) {
    try {
      // Parse template to check syntax
      const ast = Handlebars.parse(content);
      if (!ast) {
        throw new Error("Invalid template syntax");
      }

      // Try to compile and render with sample context
      const template = Handlebars.compile(content, {
        strict: true,
        assumeObjects: true,
        preventIndent: true,
      });

      const result = template(context);

      // For docker-compose templates, validate YAML
      if (name.includes("docker-compose")) {
        const yaml = require("js-yaml");
        yaml.load(result);
      }

      return true;
    } catch (error) {
      logger.error(`Template validation error in ${name}:`, error);
      throw new Error(
        `Template validation failed for ${name}: ${error.message}`
      );
    }
  }

  mergeDefaults(appType, config) {
    const defaults = this.deployConfig[appType].defaults || {};
    return { ...defaults, ...config };
  }

  async validateGeneratedFiles(files) {
    logger.info("Validating generated files...");

    // Log the exact content that will be written
    logger.info(
      "Docker Compose Content (exact):",
      JSON.stringify(files.dockerCompose)
    );
    logger.info(
      "Dockerfile Content (exact):",
      JSON.stringify(files.dockerfile)
    );

    // Basic validation of generated files
    if (!files.dockerfile || !files.dockerCompose) {
      throw new Error("Missing required deployment files");
    }

    // Create a temporary directory for validation
    const tempDir = `/tmp/deploy-validate-${Date.now()}`;
    try {
      // Create temp directory
      await fs.mkdir(tempDir, { recursive: true });

      // Write files with explicit encoding
      const composePath = path.join(tempDir, "docker-compose.yml");
      const dockerfilePath = path.join(tempDir, "Dockerfile");

      // Create a dummy .env file for validation
      const envPath = path.join(tempDir, ".env.production");

      await Promise.all([
        fs.writeFile(composePath, files.dockerCompose, "utf8"),
        fs.writeFile(dockerfilePath, files.dockerfile, "utf8"),
        fs.writeFile(envPath, "DUMMY_ENV=true\n", "utf8"),
      ]);

      // Log the actual file content after writing
      const writtenContent = await fs.readFile(composePath, "utf8");
      logger.info("Written docker-compose.yml content:", writtenContent);

      // Modified docker-compose command to use --env-file
      const { stdout, stderr } = await execAsync(
        `cd ${tempDir} && docker-compose config`,
        {
          encoding: "utf8",
          env: {
            ...process.env,
            COMPOSE_PROJECT_NAME: "validation",
          },
        }
      );

      if (stdout) logger.info("Docker compose validation stdout:", stdout);
      if (stderr) logger.warn("Docker compose validation stderr:", stderr);

      return true;
    } catch (error) {
      logger.error("Validation error details:", error);
      throw error;
    } finally {
      // Cleanup
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        logger.warn("Error cleaning up temp directory:", cleanupError);
      }
    }
  }

  async generateDeploymentFiles(appConfig) {
    logger.info(
      "Starting file generation with detailed config:",
      JSON.stringify(
        {
          ...appConfig,
          githubToken: "[REDACTED]",
        },
        null,
        2
      )
    );

    const {
      appType,
      appName,
      environment,
      port, // Changed from requestedPort to port
      domain,
      buildConfig = {},
    } = appConfig;

    if (!port) {
      throw new Error("Port must be provided for deployment");
    }

    const CONTAINER_PORT = 8080;
    const sanitizedAppName = appName.toLowerCase().replace(/[^a-z0-9-]/g, "-");

    // Prepare template context with corrected port variables
    const templateContext = {
      appName,
      sanitizedAppName,
      environment,
      containerPort: CONTAINER_PORT,
      port: port.toString(), // This matches the template's {{port}} variable
      nodeVersion: buildConfig.nodeVersion || "18",
      startCommand: buildConfig.startCommand || "npm start",
      healthCheckEndpoint: buildConfig.healthCheckEndpoint || "/health",
      volumes: buildConfig.volumes || [],
      dependencies: buildConfig.dependencies || [],
      envVars: buildConfig.envVars || {},
      traefik: {
        domain: domain || `${sanitizedAppName}.localhost`,
        middlewares: "security-headers@file,rate-limit@file,compress@file",
      },
    };

    logger.info("Template context:", JSON.stringify(templateContext, null, 2));

    try {
      // Load templates
      const dockerComposeTemplate = await this.loadTemplate(
        "docker-compose.node.hbs"
      );
      const dockerfileTemplate = await this.loadTemplate("Dockerfile.node.hbs");

      // Generate configurations
      const dockerComposeContent = dockerComposeTemplate(templateContext);
      const dockerfileContent = dockerfileTemplate(templateContext);

      // Log EXACT generated content for debugging
      logger.info("=== BEGIN GENERATED DOCKER-COMPOSE.YML ===");
      logger.info(dockerComposeContent);
      logger.info("=== END GENERATED DOCKER-COMPOSE.YML ===");

      logger.info("=== BEGIN GENERATED DOCKERFILE ===");
      logger.info(dockerfileContent);
      logger.info("=== END GENERATED DOCKERFILE ===");

      // Create validation directory
      const tempDir = `/tmp/deploy-validate-${Date.now()}`;
      await fs.mkdir(tempDir, { recursive: true });

      try {
        // Write files with explicit encoding and line endings
        const composePath = path.join(tempDir, "docker-compose.yml");
        await fs.writeFile(
          composePath,
          dockerComposeContent.replace(/\r\n/g, "\n"),
          "utf8"
        );

        const dockerfilePath = path.join(tempDir, "Dockerfile");
        await fs.writeFile(
          dockerfilePath,
          dockerfileContent.replace(/\r\n/g, "\n"),
          "utf8"
        );

        const envPath = path.join(tempDir, `.env.${environment}`);
        await fs.writeFile(envPath, "NODE_ENV=production\n", "utf8");

        // Read back the written docker-compose file for verification
        const writtenContent = await fs.readFile(composePath, "utf8");
        logger.info("=== WRITTEN DOCKER-COMPOSE.YML CONTENT ===");
        logger.info(writtenContent);
        logger.info("=== END WRITTEN CONTENT ===");

        // Validate docker-compose file
        const { stdout, stderr } = await executeCommand(
          "docker-compose",
          ["config"],
          { cwd: tempDir }
        );

        if (stderr) {
          throw new Error(`Docker compose validation failed: ${stderr}`);
        }

        logger.info("Configuration validation successful");
        return {
          dockerCompose: dockerComposeContent,
          dockerfile: dockerfileContent,
          allocatedPort: port, // Return the actual port used
        };
      } catch (validationError) {
        throw new Error(`Validation error: ${validationError.message}`);
      } finally {
        // Cleanup
        await fs
          .rm(tempDir, { recursive: true, force: true })
          .catch((error) => {
            logger.warn("Cleanup error:", error);
          });
      }
    } catch (error) {
      logger.error("Template processing error:", error);
      throw error;
    }
  }

  async validateConfig(appConfig) {
    const required = ["appType", "appName", "environment", "port"];
    const missing = required.filter((field) => !appConfig[field]);

    if (missing.length > 0) {
      throw new Error(`Missing required fields: ${missing.join(", ")}`);
    }

    if (!this.deployConfig[appConfig.appType]) {
      throw new Error(`Unsupported application type: ${appConfig.appType}`);
    }

    const typeConfig = this.deployConfig[appConfig.appType];
    const requiredTemplates = [
      typeConfig.dockerfileTemplate,
      typeConfig.dockerComposeTemplate,
      appConfig.appType === "react" ? typeConfig.nginxTemplate : null,
    ].filter(Boolean);

    for (const template of requiredTemplates) {
      try {
        await fs.access(path.join(this.templatesDir, template));
      } catch (error) {
        throw new Error(`Template ${template} not found`);
      }
    }

    return true;
  }
}

module.exports = TemplateHandler;
