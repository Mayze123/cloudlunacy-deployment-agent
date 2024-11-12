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
    // Helper for JSON stringification
    Handlebars.registerHelper("json", function (context) {
      return JSON.stringify(context, null, 2);
    });

    // Helper for environment variables formatting
    Handlebars.registerHelper("envVar", function (name, value) {
      if (typeof value === "object") {
        value = JSON.stringify(value);
      }
      // Escape quotes in value if it's a string
      if (typeof value === "string") {
        value = value.replace(/"/g, '\\"');
      }
      return `${name}=${value}`;
    });

    // Helper for string concatenation
    Handlebars.registerHelper("concat", function (...args) {
      args.pop(); // Remove last argument (Handlebars options)
      return args.join("");
    });

    // Helper for conditional expressions
    Handlebars.registerHelper("ifEquals", function (arg1, arg2, options) {
      return arg1 === arg2 ? options.fn(this) : options.inverse(this);
    });
  }

  async loadTemplate(templateName) {
    try {
      if (!this.templates[templateName]) {
        const templatePath = path.join(this.templatesDir, templateName);
        const templateContent = await fs.readFile(templatePath, "utf-8");
        this.templates[templateName] = Handlebars.compile(templateContent);
        logger.info(`Template ${templateName} loaded successfully`);
      }
      return this.templates[templateName];
    } catch (error) {
      logger.error(`Error loading template ${templateName}:`, error);
      throw new Error(
        `Failed to load template ${templateName}: ${error.message}`
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
      port: requestedPort,
      envFile,
      buildConfig = {},
      domain,
    } = appConfig;

    // Get or allocate port
    let deploymentPort = requestedPort;
    if (!deploymentPort) {
      deploymentPort = await portManager.allocatePort(appName, environment);
      logger.info(
        `Allocated port ${deploymentPort} for ${appName}-${environment}`
      );
    } else {
      logger.info(
        `Using requested port ${deploymentPort} for ${appName}-${environment}`
      );
    }

    const config = this.mergeDefaults(appType, buildConfig);
    logger.info("Merged configuration:", JSON.stringify(config, null, 2));

    const serviceName = `${appName}-${environment}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");

    // Generate docker-compose.yml without duplicate networks
    const dockerComposeContent = `version: "3.8"
    services:
      ${serviceName}:
        container_name: ${serviceName}
        build:
          context: .
          dockerfile: Dockerfile
        ports:
          - "${deploymentPort}:${deploymentPort}"
        environment:
          - NODE_ENV=${environment}
          - PORT=${deploymentPort}
        env_file:
          - .env.${environment}
        restart: unless-stopped
        networks:
          - app-network
        healthcheck:
          test: ["CMD", "curl", "-f", "http://localhost:${deploymentPort}/health"]
          interval: 30s
          timeout: 10s
          retries: 3
          start_period: 40s
        logging:
          driver: "json-file"
          options:
            max-size: "10m"
            max-file: "3"
    
    networks:
      app-network:
        driver: bridge
        name: ${serviceName}-network`;

    // Generate Dockerfile with curl for healthcheck
    const dockerfileContent = `FROM node:18-alpine
    # Install curl for healthcheck
    RUN apk add --no-cache curl
    
    WORKDIR /app
    
    # Copy package files first for better caching
    COPY package*.json ./
    
    # Install dependencies
    RUN npm ci --only=production
    
    # Copy application files
    COPY . .
    
    # Copy environment file
    COPY .env.${environment} .env
    
    # Set environment variables
    ENV NODE_ENV=${environment}
    ENV PORT=${deploymentPort}  
    
    # Create healthcheck endpoint
    RUN echo "const http=require('http');const server=http.createServer((req,res)=>{if(req.url==='/health'){res.writeHead(200);res.end('OK');}});server.listen(${deploymentPort});" > healthcheck.js  // Changed this
    
    # Add dotenv loading script
    RUN echo "require('dotenv').config(); require('./healthcheck');" > load-env.js
    
    # Start the application
    CMD ["sh", "-c", "node load-env.js & npm start"]`;

    logger.info("Generated docker-compose.yml:", dockerComposeContent);
    logger.info("Generated Dockerfile:", dockerfileContent);

    // Validate the generated files
    const tempValidationDir = `/tmp/validate-${Date.now()}`;
    try {
      await fs.mkdir(tempValidationDir, { recursive: true });
      await fs.writeFile(
        path.join(tempValidationDir, "docker-compose.yml"),
        dockerComposeContent
      );
      await fs.writeFile(
        path.join(tempValidationDir, "Dockerfile"),
        dockerfileContent
      );
      await fs.writeFile(
        path.join(tempValidationDir, `.env.${environment}`),
        "NODE_ENV=production\n"
      );

      // Validate docker-compose file
      const { stdout: validationOutput } = await executeCommand(
        "docker-compose",
        ["config"],
        { cwd: tempValidationDir }
      );
      logger.info("Docker compose validation output:", validationOutput);

      return {
        dockerCompose: dockerComposeContent,
        dockerfile: dockerfileContent,
        allocatedPort: deploymentPort,
      };
    } catch (error) {
      logger.error("File validation failed:", error);
      throw error;
    } finally {
      // Cleanup temporary directory
      await fs
        .rm(tempValidationDir, { recursive: true, force: true })
        .catch(() => {});
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
