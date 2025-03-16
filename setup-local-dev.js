const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");

async function setupLocalDev() {
  console.log("Setting up local development environment...");

  // Create necessary directories
  const dirs = ["./deployments", "./config", "./templates", "./logs"];

  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    } catch (err) {
      if (err.code !== "EEXIST") {
        console.error(`Error creating directory ${dir}:`, err);
      }
    }
  }

  // Create ports.json file
  const portsFile = path.join("./config", "ports.json");
  try {
    await fs.writeFile(portsFile, JSON.stringify({}, null, 2));
    console.log("Created ports.json file");
  } catch (err) {
    console.error("Error creating ports.json:", err);
  }

  // Copy templates if they don't exist in the templates directory
  const templateFiles = [
    "Dockerfile.node.hbs",
    "docker-compose.node.hbs",
    "Dockerfile.react.hbs",
    "docker-compose.react.hbs",
    "nginx.conf.hbs",
  ];

  for (const file of templateFiles) {
    const sourcePath = path.join("./templates", file);
    const destPath = path.join("./templates", file);

    try {
      await fs.access(destPath);
      console.log(`Template file already exists: ${file}`);
    } catch (err) {
      try {
        // If the file doesn't exist in the templates directory, copy it
        const content = await fs.readFile(sourcePath, "utf8");
        await fs.writeFile(destPath, content);
        console.log(`Copied template file: ${file}`);
      } catch (copyErr) {
        console.error(`Error copying template file ${file}:`, copyErr);
      }
    }
  }

  console.log("Local development environment setup complete!");
  console.log('Run "npm run dev" to start the development environment.');
}

setupLocalDev().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
