const { execSync } = require("child_process");

console.log("🧹 Cleaning up Docker environment...");

// Helper function to run shell commands
function runCommand(command, options = {}) {
  console.log(`Running: ${command}`);
  try {
    const output = execSync(command, {
      stdio: options.silent ? "pipe" : "inherit",
      ...options,
    });
    return output ? output.toString() : "";
  } catch (error) {
    if (!options.ignoreError) {
      console.error(`Command failed: ${command}`);
      if (error.message) console.error(error.message);
    }
    return error.stdout ? error.stdout.toString() : "";
  }
}

// Stop and remove containers that might conflict
console.log("Stopping and removing existing containers...");
runCommand("docker stop mongodb-agent cloudlunacy-agent", {
  ignoreError: true,
});
runCommand("docker rm mongodb-agent cloudlunacy-agent", { ignoreError: true });

// Also check for any test containers
runCommand("docker stop cloudlunacy-test-agent", { ignoreError: true });
runCommand("docker rm cloudlunacy-test-agent", { ignoreError: true });

console.log("✅ Cleanup completed successfully!");
