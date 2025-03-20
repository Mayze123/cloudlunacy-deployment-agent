// tests/index.js - Main test runner
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// Test categories and their corresponding scripts
const testSuites = {
  // We're only keeping the mongo connections test
  mongo: ["test-mongo-connections.js"],
  // Add more test categories as needed
};

// Parse command line arguments
const args = process.argv.slice(2);
const selectedSuites = args.length > 0 ? args : Object.keys(testSuites);

// Results tracking
const results = {
  passed: 0,
  failed: 0,
  suites: {},
};

async function runTests() {
  console.log("🚀 CloudLunacy Deployment Agent Test Runner");
  console.log("===========================================\n");

  for (const suite of selectedSuites) {
    if (!testSuites[suite]) {
      console.log(`⚠️  Unknown test suite: ${suite}`);
      continue;
    }

    console.log(`\n📋 Running ${suite} tests...`);
    results.suites[suite] = { passed: 0, failed: 0 };

    for (const testFile of testSuites[suite]) {
      const testPath = path.join(__dirname, suite, testFile);

      // Check if the test file exists
      if (!fs.existsSync(testPath)) {
        console.log(`❌ Test file not found: ${testPath}`);
        results.suites[suite].failed++;
        results.failed++;
        continue;
      }

      console.log(`\n🧪 Running test: ${testFile}`);

      try {
        execSync(`node ${testPath}`, { stdio: "inherit" });
        console.log(`✅ Test passed: ${testFile}`);
        results.suites[suite].passed++;
        results.passed++;
      } catch (error) {
        console.log(`❌ Test failed: ${testFile}`);
        results.suites[suite].failed++;
        results.failed++;
      }
    }
  }

  // Print summary
  console.log("\n📊 Test Summary");
  console.log("===========================================");
  console.log(`Total: ${results.passed + results.failed} tests`);
  console.log(`Passed: ${results.passed} tests`);
  console.log(`Failed: ${results.failed} tests`);

  for (const suite in results.suites) {
    const suiteResult = results.suites[suite];
    console.log(
      `\n${suite}: ${suiteResult.passed} passed, ${suiteResult.failed} failed`,
    );
  }

  // Exit with appropriate code
  process.exit(results.failed > 0 ? 1 : 0);
}

runTests();
