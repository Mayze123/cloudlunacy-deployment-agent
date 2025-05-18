// Tests for Nixpacks Plans Manager
const path = require("path");
const fs = require("fs");
const nixpacksPlansManager = require("../utils/nixpacksPlansManager");
const logger = require("../utils/logger");

async function runTests() {
  logger.info("=== NIXPACKS PLANS MANAGER TESTS ===");

  // Test 1: Load and verify default plans
  try {
    logger.info("Test 1: Loading default build plans...");

    const nodePlan = nixpacksPlansManager.getBuildPlan("node");
    if (!nodePlan) {
      throw new Error("Node.js plan not found in default plans");
    }

    const reactPlan = nixpacksPlansManager.getBuildPlan("react");
    if (!reactPlan) {
      throw new Error("React plan not found in default plans");
    }

    logger.info(
      `Found ${Object.keys(nodePlan).length} properties in Node.js plan`,
    );
    logger.info(
      `Found ${Object.keys(reactPlan).length} properties in React plan`,
    );
    logger.info("✅ Test 1 Passed: Default plans loaded successfully");
  } catch (error) {
    logger.error(`❌ Test 1 Failed: ${error.message}`);
    process.exit(1);
  }

  // Test 2: Generate a custom plan with port configuration
  try {
    logger.info("Test 2: Generating custom build plan with ports...");

    const customPlan = nixpacksPlansManager.generateBuildPlan({
      appType: "node",
      containerPort: 3000,
      additionalPorts: [
        { port: 8080, protocol: "tcp", description: "Admin port" },
      ],
      healthCheck: {
        checkPath: "/health",
        interval: "15s",
      },
    });

    // Verify port configuration
    if (customPlan.variables.PORT !== "3000") {
      throw new Error("Primary port not set correctly");
    }

    if (customPlan.variables.PORT_1 !== "8080") {
      throw new Error("Additional port not set correctly");
    }

    // Verify health check
    if (
      !customPlan.healthcheck ||
      !customPlan.healthcheck.cmd.includes("/health")
    ) {
      throw new Error("Health check not configured correctly");
    }

    // Log the plan for inspection
    logger.info("Generated plan:");
    logger.info(JSON.stringify(customPlan, null, 2));

    logger.info("✅ Test 2 Passed: Custom plan generated correctly");
  } catch (error) {
    logger.error(`❌ Test 2 Failed: ${error.message}`);
    process.exit(1);
  }

  // Test 3: Create custom plans file and verify loading
  try {
    logger.info("Test 3: Testing custom plans file loading...");

    // Create a temporary directory for testing
    const testConfigDir = path.join(__dirname, "temp-nixpacks-test");
    if (!fs.existsSync(testConfigDir)) {
      fs.mkdirSync(testConfigDir, { recursive: true });
    }

    // Create a custom plan file
    const customPlansFile = path.join(testConfigDir, "plans.json");
    const customPlans = {
      "custom-app": {
        name: "Custom App Type",
        providers: ["custom"],
        variables: {
          CUSTOM_VAR: "test-value",
        },
        start: "./custom-start.sh",
      },
    };

    fs.writeFileSync(customPlansFile, JSON.stringify(customPlans, null, 2));

    // Temporarily set the config dir environment variable
    const originalConfigDir = process.env.NIXPACKS_CONFIG_DIR;
    process.env.NIXPACKS_CONFIG_DIR = testConfigDir;

    try {
      // Create a new instance to pick up the config dir change
      const tempManager = require("../utils/nixpacksPlansManager");

      // Load the custom plan
      const customPlan = tempManager.getBuildPlan("custom-app");

      if (!customPlan) {
        throw new Error("Custom plan not found");
      }

      if (customPlan.variables.CUSTOM_VAR !== "test-value") {
        throw new Error("Custom plan values not loaded correctly");
      }

      logger.info("✅ Test 3 Passed: Custom plans file loaded successfully");
    } finally {
      // Restore the original config dir
      if (originalConfigDir) {
        process.env.NIXPACKS_CONFIG_DIR = originalConfigDir;
      } else {
        delete process.env.NIXPACKS_CONFIG_DIR;
      }

      // Clean up
      try {
        fs.unlinkSync(customPlansFile);
        fs.rmdirSync(testConfigDir);
      } catch (err) {
        logger.warn(`Error cleaning up test directory: ${err.message}`);
      }
    }
  } catch (error) {
    logger.error(`❌ Test 3 Failed: ${error.message}`);
    process.exit(1);
  }

  logger.info("🎉 All Nixpacks Plans Manager tests completed successfully!");
}

runTests().catch((err) => {
  logger.error(`Test suite failed: ${err.message}`);
  process.exit(1);
});
