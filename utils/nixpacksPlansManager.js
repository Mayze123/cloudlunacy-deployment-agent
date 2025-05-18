/**
 * Nixpacks Plans Manager
 * Provides utilities for working with Nixpacks build plans
 */
const fs = require("fs");
const path = require("path");
const logger = require("./logger");

class NixpacksPlansManager {
  constructor() {
    this.defaultPlansPath = path.join(
      __dirname,
      "../templates/nixpacks/default-plans.json",
    );
    this.configuredPlansPath = process.env.NIXPACKS_CONFIG_DIR
      ? path.join(process.env.NIXPACKS_CONFIG_DIR, "plans.json")
      : path.join(__dirname, "../config/nixpacks-plans.json");
  }

  /**
   * Get a build plan by application type
   * Will try configured plans first, then fall back to default plans
   *
   * @param {string} appType - Application type (e.g., 'node', 'react', 'python')
   * @returns {Object|null} - The build plan object or null if not found
   */
  getBuildPlan(appType) {
    try {
      // Try to load custom plans first
      if (fs.existsSync(this.configuredPlansPath)) {
        try {
          const customPlans = JSON.parse(
            fs.readFileSync(this.configuredPlansPath, "utf8"),
          );
          if (customPlans[appType]) {
            logger.info(
              `Using custom Nixpacks plan for ${appType} from ${this.configuredPlansPath}`,
            );
            return customPlans[appType];
          }
        } catch (error) {
          logger.warn(`Error loading custom Nixpacks plans: ${error.message}`);
        }
      }

      // Fall back to default plans
      if (fs.existsSync(this.defaultPlansPath)) {
        const defaultPlans = JSON.parse(
          fs.readFileSync(this.defaultPlansPath, "utf8"),
        );
        if (defaultPlans[appType]) {
          logger.info(`Using default Nixpacks plan for ${appType}`);
          return defaultPlans[appType];
        }
      }

      logger.warn(`No Nixpacks plan found for application type: ${appType}`);
      return null;
    } catch (error) {
      logger.error(`Error getting Nixpacks build plan: ${error.message}`);
      return null;
    }
  }

  /**
   * Generate a custom build plan with port configurations
   *
   * @param {Object} options - Options object
   * @param {string} options.appType - Application type
   * @param {number} options.containerPort - Main container port
   * @param {Array<Object>} options.additionalPorts - Additional ports to expose
   * @param {Object} options.healthCheck - Health check configuration
   * @returns {Object} - Final build plan
   */
  generateBuildPlan({
    appType,
    containerPort,
    additionalPorts = [],
    healthCheck = null,
  }) {
    // Start with a base plan for the app type
    const basePlan = this.getBuildPlan(appType) || {
      providers: [],
      phases: {},
      variables: {},
    };

    // Add port configuration
    const plan = {
      ...basePlan,
      variables: {
        ...(basePlan.variables || {}),
        PORT: containerPort.toString(),
      },
    };

    // Add additional ports
    if (additionalPorts && additionalPorts.length > 0) {
      additionalPorts.forEach((portConfig, index) => {
        plan.variables[`PORT_${index + 1}`] = portConfig.port.toString();
      });
    }

    // Add health check if specified
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
}

module.exports = new NixpacksPlansManager();
