const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config({ path: ".env.dev" });

// Configuration
const FRONT_API_URL = process.env.FRONT_API_URL || "http://localhost:3005";
const SERVER_ID = process.env.SERVER_ID || "dev-server-id";
const AGENT_TOKEN = process.env.AGENT_API_TOKEN || "dev-token";

// Use a local directory for development instead of /opt/cloudlunacy
const BASE_DIR =
  process.env.NODE_ENV === "production"
    ? "/opt/cloudlunacy"
    : path.join(__dirname, "..", "dev-cloudlunacy");
const CERTS_DIR = path.join(BASE_DIR, "certs");
const JWT_FILE = path.join(BASE_DIR, ".agent_jwt.json");

// Ensure directories exist
async function ensureDirectories() {
  console.log("Ensuring necessary directories exist...");
  try {
    await fs.mkdir(CERTS_DIR, { recursive: true });
    console.log(`Created certificates directory: ${CERTS_DIR}`);
    return true;
  } catch (error) {
    console.error(`Failed to create directories: ${error.message}`);
    return false;
  }
}

// Register agent with front server
async function registerAgent() {
  console.log("Registering agent with front server...");
  try {
    // Get local IP address
    const LOCAL_IP = "127.0.0.1"; // For development, we use localhost

    console.log(`Using LOCAL_IP: ${LOCAL_IP}`);
    console.log(`Using FRONT_API_URL: ${FRONT_API_URL}`);

    const response = await axios.post(
      `${FRONT_API_URL}/api/agent/register`,
      { agentId: SERVER_ID },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Agent-IP": LOCAL_IP,
        },
      },
    );

    if (response.data && response.data.token) {
      console.log("Agent registered successfully");

      // Save JWT to file
      await fs.writeFile(JWT_FILE, JSON.stringify(response.data, null, 2));
      console.log(`JWT saved to ${JWT_FILE}`);

      return response.data.token;
    } else {
      console.error(
        "Registration response did not contain token:",
        response.data,
      );
      return null;
    }
  } catch (error) {
    console.error("Agent registration failed:", error.message);
    if (error.response) {
      console.error("Response data:", error.response.data);
    }
    return null;
  }
}

// Fetch certificates from front server
async function fetchCertificates(token) {
  console.log("Fetching TLS certificates from front server...");

  try {
    // Fetch CA certificate
    console.log("Fetching CA certificate...");
    const caResponse = await axios.get(
      `${FRONT_API_URL}/api/certificates/mongodb-ca`,
    );

    if (!caResponse.data) {
      console.error("Failed to fetch CA certificate");
      return false;
    }

    await fs.writeFile(`${CERTS_DIR}/ca.crt`, caResponse.data);
    console.log("CA certificate saved successfully");

    // Fetch agent certificates
    console.log("Fetching agent certificates...");
    const certResponse = await axios.get(
      `${FRONT_API_URL}/api/certificates/agent/${SERVER_ID}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!certResponse.data || !certResponse.data.success) {
      console.error("Failed to fetch agent certificates:", certResponse.data);
      return false;
    }

    const { serverKey, serverCert } = certResponse.data.certificates;

    await fs.writeFile(`${CERTS_DIR}/server.key`, serverKey);
    await fs.writeFile(`${CERTS_DIR}/server.crt`, serverCert);
    await fs.writeFile(`${CERTS_DIR}/server.pem`, serverKey + serverCert);

    console.log("Agent certificates saved successfully");

    // Set proper permissions
    try {
      execSync(`chmod 600 ${CERTS_DIR}/server.key`);
      execSync(`chmod 600 ${CERTS_DIR}/server.pem`);
      execSync(`chmod 644 ${CERTS_DIR}/server.crt`);
      execSync(`chmod 644 ${CERTS_DIR}/ca.crt`);
      console.log("Certificate permissions set successfully");
    } catch (error) {
      console.warn("Failed to set certificate permissions:", error.message);
      // Continue anyway as this might not be critical in dev environment
    }

    return true;
  } catch (error) {
    console.error("Failed to fetch certificates:", error.message);
    if (error.response) {
      console.error("Response data:", error.response.data);
    }
    return false;
  }
}

// Add this function after the MongoDB setup (around line 188)
async function connectMongoDBNetworks() {
  console.log("Connecting MongoDB container to required networks...");

  try {
    // Check if MongoDB container is running
    execSync("docker inspect mongodb-agent-dev", { stdio: "ignore" });

    // Connect to traefik-network if not already connected
    try {
      execSync("docker network inspect traefik-network", { stdio: "ignore" });
      execSync("docker network connect traefik-network mongodb-agent-dev", {
        stdio: "ignore",
      });
      console.log("Connected MongoDB to traefik-network");
    } catch (error) {
      console.warn(
        "Could not connect to traefik-network. It may not exist in development mode.",
      );
    }

    // Connect to cloudlunacy-network if not already connected
    try {
      execSync("docker network connect cloudlunacy-network mongodb-agent-dev", {
        stdio: "ignore",
      });
      console.log("Connected MongoDB to cloudlunacy-network");
    } catch (error) {
      console.warn("Could not connect to cloudlunacy-network:", error.message);
    }
  } catch (error) {
    console.warn(
      "MongoDB container not running, cannot connect to networks:",
      error.message,
    );
  }
}

// Main function
async function main() {
  console.log("Setting up development environment...");

  // Create the base directory structure locally first
  try {
    execSync(`mkdir -p ${BASE_DIR}`);
    console.log(`Created base directory: ${BASE_DIR}`);
  } catch (error) {
    console.error(`Failed to create base directory: ${error.message}`);
    process.exit(1);
  }

  // Ensure directories exist
  const directoriesCreated = await ensureDirectories();
  if (!directoriesCreated) {
    console.error("Failed to create necessary directories");
    process.exit(1);
  }

  // Register agent
  const token = await registerAgent();
  if (!token) {
    console.error("Failed to register agent");
    process.exit(1);
  }

  // Fetch certificates
  const certificatesFetched = await fetchCertificates(token);
  if (!certificatesFetched) {
    console.error("Failed to fetch certificates");
    process.exit(1);
  }

  // Prepare MongoDB certificates
  try {
    console.log("Preparing MongoDB certificates...");
    execSync("node scripts/prepare-mongo-certs.js", { stdio: "inherit" });
  } catch (error) {
    console.error("Failed to prepare MongoDB certificates:", error.message);
    process.exit(1);
  }

  // Connect MongoDB to required networks
  await connectMongoDBNetworks();

  console.log("Development environment setup completed successfully");
  console.log("Starting development environment...");

  // Start the development environment
  try {
    execSync("npm run dev:build", { stdio: "inherit" });
  } catch (error) {
    console.error("Failed to start development environment:", error.message);
    process.exit(1);
  }
}

// Run the main function
main().catch((error) => {
  console.error("Setup failed:", error);
  process.exit(1);
});
