#!/usr/bin/env node

const path = require("path");
const repositoryController = require("./src/controllers/repositoryController");

async function testAutoDetection() {
  console.log("Testing auto-detection of React app...");

  // Test with cloudlunacy-dashboard directory
  const dashboardPath = "/Users/mahamadoutaibou/Github/cloudlunacy-dashboard";

  try {
    const detectedType =
      await repositoryController.detectAppType(dashboardPath);
    console.log(`✅ Auto-detected app type: ${detectedType}`);

    if (detectedType === "react") {
      console.log("🎉 SUCCESS: Correctly detected React app!");
    } else {
      console.log(`❌ FAIL: Expected 'react', got '${detectedType}'`);
    }
  } catch (error) {
    console.error("❌ FAIL: Auto-detection failed:", error.message);
  }
}

testAutoDetection()
  .then(() => {
    console.log("Test completed.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Test failed:", error);
    process.exit(1);
  });
