const Handlebars = require("handlebars");
const fs = require("fs").promises;
const path = require("path");
const logger = require("./logger");
const { exec } = require("child_process");
const util = require("util");
const { executeCommand } = require("./executor");
const execAsync = util.promisify(exec);

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

  async ensureTemplatesExist() {
    logger.info("Ensuring all required templates exist...");

    try {
      // Create base templates directory
      await fs.mkdir(this.templatesDir, { recursive: true });

      // Create config templates directory
      const configTemplateDir = path.join(this.templatesDir, "config");
      await fs.mkdir(configTemplateDir, { recursive: true });

      // Basic service template for different app types
      const serviceTemplate = {
        node: `version: "3.8"
services:
  {{serviceName}}:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - NODE_ENV={{environment}}
      - PORT={{containerPort}}
    env_file:
      - .env.{{environment}}
    networks:
      - traefik-public
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=traefik-public"
      - "traefik.http.routers.{{serviceName}}.rule=Host(\`{{domain}}\`)"
      - "traefik.http.routers.{{serviceName}}.entrypoints=websecure"
      - "traefik.http.routers.{{serviceName}}.tls.certresolver=letsencrypt"
      - "traefik.http.services.{{serviceName}}.loadbalancer.server.port={{containerPort}}"
      - "traefik.http.middlewares.{{serviceName}}-compress.compress=true"
      - "traefik.http.routers.{{serviceName}}.middlewares={{serviceName}}-compress"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:{{containerPort}}/health"]
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
  traefik-public:
    external: true`,

        react: `version: "3.8"
services:
  {{serviceName}}:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - NODE_ENV={{environment}}
      - PORT={{containerPort}}
    env_file:
      - .env.{{environment}}
    networks:
      - traefik-public
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=traefik-public"
      - "traefik.http.routers.{{serviceName}}.rule=Host(\`{{domain}}\`)"
      - "traefik.http.routers.{{serviceName}}.entrypoints=websecure"
      - "traefik.http.routers.{{serviceName}}.tls.certresolver=letsencrypt"
      - "traefik.http.services.{{serviceName}}.loadbalancer.server.port={{containerPort}}"
      - "traefik.http.middlewares.{{serviceName}}-compress.compress=true"
      - "traefik.http.middlewares.{{serviceName}}-spa.replacepathregex.regex=^/[^/]*$"
      - "traefik.http.middlewares.{{serviceName}}-spa.replacepathregex.replacement=/"
      - "traefik.http.routers.{{serviceName}}.middlewares={{serviceName}}-compress,{{serviceName}}-spa"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:{{containerPort}}/health"]
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
  traefik-public:
    external: true`,
      };

      // Write service templates
      for (const [type, template] of Object.entries(serviceTemplate)) {
        const templatePath = path.join(
          configTemplateDir,
          `${type}-service.template`
        );
        await fs.writeFile(templatePath, template, "utf8");
      }

      logger.info("Templates created successfully");
      return true;
    } catch (error) {
      logger.error("Failed to create templates:", error);
      throw error;
    }
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
    const defaults = this.deployConfig[appType]?.defaults || {};
    return { ...defaults, ...config };
  }

  async validateGeneratedFiles(files) {
    logger.info("Validating generated files...");

    logger.info("Docker Compose Content:", JSON.stringify(files.dockerCompose));
    logger.info("Dockerfile Content:", JSON.stringify(files.dockerfile));

    if (!files.dockerfile || !files.dockerCompose) {
      throw new Error("Missing required deployment files");
    }

    const tempDir = `/tmp/deploy-validate-${Date.now()}`;
    try {
      await fs.mkdir(tempDir, { recursive: true });

      const composePath = path.join(tempDir, "docker-compose.yml");
      const dockerfilePath = path.join(tempDir, "Dockerfile");
      const envPath = path.join(tempDir, ".env.production");

      await Promise.all([
        fs.writeFile(composePath, files.dockerCompose, "utf8"),
        fs.writeFile(dockerfilePath, files.dockerfile, "utf8"),
        fs.writeFile(envPath, "DUMMY_ENV=true\n", "utf8"),
      ]);

      const writtenContent = await fs.readFile(composePath, "utf8");
      logger.info("Written docker-compose.yml content:", writtenContent);

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
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        logger.warn("Error cleaning up temp directory:", cleanupError);
      }
    }
  }

  async generateDeploymentFiles({
    appType,
    appName,
    environment,
    domain,
    envFile,
    buildConfig = {},
  }) {
    logger.info(
      "Starting file generation with config:",
      JSON.stringify(
        {
          appType,
          appName,
          environment,
          domain,
          buildConfig,
        },
        null,
        2
      )
    );

    const config = this.mergeDefaults(appType, buildConfig);
    const CONTAINER_PORT = 8080;
    const serviceName = `${appName}-${environment}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");

    // Load the appropriate service template
    const serviceTemplate = await this.loadTemplate(
      `config/${appType}-service.template`
    );

    const dockerComposeContent = serviceTemplate({
      serviceName,
      environment,
      containerPort: CONTAINER_PORT,
      domain,
      config,
    });

    const dockerfileContent = `FROM node:${config.nodeVersion || "18"}-alpine

# Install curl for healthcheck
RUN apk add --no-cache curl

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Copy environment file
COPY .env.${environment} .env

# Set environment variables
ENV NODE_ENV=${environment}
ENV PORT=${CONTAINER_PORT}

# Create healthcheck endpoint
RUN echo "const http=require('http');const server=http.createServer((req,res)=>{if(req.url==='/health'){res.writeHead(200);res.end('OK');}});server.listen(${CONTAINER_PORT});" > healthcheck.js

# Expose container port
EXPOSE ${CONTAINER_PORT}

# Start the application
CMD ["npm", "start"]`;

    const files = {
      dockerCompose: dockerComposeContent,
      dockerfile: dockerfileContent,
      allocatedPort: CONTAINER_PORT,
    };

    // Validate the generated files
    await this.validateGeneratedFiles(files);

    return files;
  }

  async validateConfig(appConfig) {
    const required = ["appType", "appName", "environment", "domain"];
    const missing = required.filter((field) => !appConfig[field]);

    if (missing.length > 0) {
      throw new Error(`Missing required fields: ${missing.join(", ")}`);
    }

    if (!this.deployConfig[appConfig.appType]) {
      throw new Error(`Unsupported application type: ${appConfig.appType}`);
    }

    return true;
  }
}

module.exports = TemplateHandler;

module.exports = TemplateHandler;
