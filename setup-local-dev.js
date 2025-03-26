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

  // Check if MongoDB should be enabled based on the presence of MongoDB configuration
  const enableMongoDB = process.env.MONGO_HOST || process.env.MONGO_PORT;

  // MongoDB certificates generation
  if (enableMongoDB) {
    console.log(
      "MongoDB configuration detected. Setting up MongoDB certificates...",
    );
    try {
      // Check if the prepare-mongo-certs.js script exists
      if (
        fs.existsSync(path.join(__dirname, "scripts", "prepare-mongo-certs.js"))
      ) {
        execSync("npm run dev:prepare-mongo", { stdio: "inherit" });
      } else {
        console.log("MongoDB certificate preparation script not found.");

        // Check if we need to create the certificates directory
        const certsDir = path.join(__dirname, "dev-cloudlunacy", "certs");
        if (!fs.existsSync(certsDir)) {
          fs.mkdirSync(certsDir, { recursive: true });
          console.log("Created certificates directory:", certsDir);
        }
      }
    } catch (error) {
      console.error("Failed to prepare MongoDB certificates:", error.message);
    }
  } else {
    console.log(
      "No MongoDB configuration detected. Skipping MongoDB certificates setup.",
    );
  }

  console.log("Local development environment setup complete!");
  console.log('Run "npm run dev" to start the development environment.');
}

setupLocalDev().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
