// Tests for Nixpacks installation and fallback mechanisms
const path = require("path");
const fs = require("fs");
const { executeCommand } = require("../utils/executor");
const nixpacksBuilder = require("../utils/nixpacksBuilder");
const nixpacksPlansManager = require("../utils/nixpacksPlansManager");
const logger = require("../utils/logger");

async function runTests() {
  logger.info("=== NIXPACKS INSTALLATION & FALLBACK TESTS ===");

  // Test 1: Check if the available tools detection works
  try {
    logger.info("Test 1: Detecting available installation tools...");
    const tools = await nixpacksBuilder.detectAvailableTools();
    logger.info(
      `Available tools: ${Object.entries(tools)
        .filter(([_, available]) => available)
        .map(([name]) => name)
        .join(", ")}`,
    );
    logger.info("✅ Test 1 Passed: Successfully detected available tools");
  } catch (error) {
    logger.error(`❌ Test 1 Failed: ${error.message}`);
    process.exit(1);
  }

  // Test 2: Try to uninstall Nixpacks if it exists (for clean testing)
  try {
    logger.info("Test 2: Checking if Nixpacks is currently installed...");

    try {
      await executeCommand("which", ["nixpacks"], { ignoreError: true });
      logger.info(
        "Nixpacks is installed. Attempting to uninstall for clean testing...",
      );

      // Try to uninstall based on available tools
      const tools = await nixpacksBuilder.detectAvailableTools();

      if (tools.brew) {
        logger.info("Uninstalling Nixpacks via Homebrew...");
        await executeCommand("brew", ["uninstall", "nixpacks"], {
          ignoreError: true,
        });
      } else if (tools.npm) {
        logger.info("Uninstalling Nixpacks via npm...");
        await executeCommand("npm", ["uninstall", "-g", "nixpacks"], {
          ignoreError: true,
        });
      }

      // Remove any Docker wrapper
      const wrapperPath = path.join(
        process.env.HOME,
        ".local",
        "bin",
        "nixpacks",
      );
      if (fs.existsSync(wrapperPath)) {
        logger.info(`Removing Docker wrapper at ${wrapperPath}...`);
        fs.unlinkSync(wrapperPath);
      }
    } catch (e) {
      logger.info(
        "Nixpacks is not currently installed, proceeding with clean testing.",
      );
    }

    logger.info("✅ Test 2 Passed: Environment prepared for testing");
  } catch (error) {
    logger.warn(`⚠️ Test 2 Warning: ${error.message}`);
    // Continue with tests
  }

  // Test 3: Test Nixpacks installation
  try {
    logger.info("Test 3: Testing Nixpacks installation...");
    await nixpacksBuilder.checkNixpacksInstallation();

    // Verify Nixpacks is now working
    try {
      const { stdout } = await executeCommand("nixpacks", ["--version"]);
      logger.info(`Nixpacks installed correctly, version: ${stdout.trim()}`);
      logger.info("✅ Test 3 Passed: Nixpacks installation successful");
    } catch (e) {
      throw new Error(`Nixpacks installed but not working: ${e.message}`);
    }
  } catch (error) {
    logger.error(`❌ Test 3 Failed: ${error.message}`);
    process.exit(1);
  }

  // Test 4: Create a simple test project and build it
  try {
    logger.info("Test 4: Testing build with a simple project...");

    // Create a simple Node.js project
    const testDir = path.join(__dirname, "nixpacks-test-project");
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    // Create package.json
    fs.writeFileSync(
      path.join(testDir, "package.json"),
      JSON.stringify(
        {
          name: "nixpacks-test",
          version: "1.0.0",
          main: "index.js",
          scripts: {
            start: "node index.js",
          },
        },
        null,
        2,
      ),
    );

    // Create index.js
    fs.writeFileSync(
      path.join(testDir, "index.js"),
      'console.log("Hello from nixpacks test app!");',
    );

    // Try to build the image
    await nixpacksBuilder.buildImage({
      projectDir: testDir,
      imageName: "nixpacks-test-image:latest",
      envVars: { PORT: "3000" },
    });

    logger.info("✅ Test 4 Passed: Successfully built test project");

    // Clean up
    try {
      await executeCommand("docker", ["rmi", "nixpacks-test-image:latest"], {
        ignoreError: true,
      });
      logger.info("Cleaned up test image");
    } catch (e) {
      // Ignore cleanup errors
    }
  } catch (error) {
    logger.error(`❌ Test 4 Failed: ${error.message}`);
    process.exit(1);
  }

  logger.info("🎉 All tests completed successfully!");
}

runTests().catch((err) => {
  logger.error(`Test suite failed: ${err.message}`);
  process.exit(1);
});
