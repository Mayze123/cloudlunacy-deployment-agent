// scripts/test-agent.js
// Set environment to test
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const { execSync } = require("child_process");
const os = require("os");

// Test results tracking
const testResults = {
  passed: 0,
  failed: 0,
  tests: [],
};

// Helper function to log test results
function logTestResult(testName, passed, error = null) {
  const result = {
    name: testName,
    passed,
    error: error ? error.message || String(error) : null,
  };

  testResults.tests.push(result);

  if (passed) {
    testResults.passed++;
    console.log(`✅ ${testName}: Passed`);
  } else {
    testResults.failed++;
    console.log(
      `❌ ${testName}: Failed${error ? " - " + (error.message || String(error)) : ""}`,
    );
  }
}

// Test Docker container status
async function testDockerStatus() {
  try {
    console.log("\n🐳 Testing Docker container status...");

    // Execute docker ps command to check if containers are running
    const result = execSync(
      "docker ps --format '{{.Names}}' | grep cloudlunacy",
    ).toString();

    if (result.includes("cloudlunacy")) {
      logTestResult("Docker containers", true);
      console.log("Running containers:", result.trim());
      return true;
    } else {
      logTestResult(
        "Docker containers",
        false,
        "No cloudlunacy containers found",
      );
      return false;
    }
  } catch (error) {
    // If grep doesn't find anything, it will exit with code 1
    logTestResult(
      "Docker containers",
      false,
      "No cloudlunacy containers running",
    );
    return false;
  }
}

// Main test function
async function runTests() {
  console.log("🚀 Starting CloudLunacy Agent Testing Process");
  console.log("\n🧪 Running tests...");

  try {
    // Run Docker status test
    await testDockerStatus();

    // Print test summary
    console.log("\n🏁 Test Results:");
    console.log(`✅ Passed: ${testResults.passed}`);
    console.log(`❌ Failed: ${testResults.failed}`);

    if (testResults.failed > 0) {
      console.log("❌ Some tests failed!");
      process.exit(1);
    } else {
      console.log("✅ All tests passed!");
      process.exit(0);
    }
  } catch (error) {
    console.error("❌ Test execution failed:", error);
    process.exit(1);
  }
}

// Run the tests
runTests();
