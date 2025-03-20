const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Define paths
const BASE_DIR = path.join(__dirname, "..", "dev-cloudlunacy");
const CERTS_DIR = path.join(BASE_DIR, "certs");

// Ensure certificates directory exists
if (!fs.existsSync(CERTS_DIR)) {
  console.error(
    'Certificates directory not found. Run "npm run dev:setup" first.',
  );
  process.exit(1);
}

console.log("Preparing MongoDB certificates...");

// Check if server.pem exists
const pemPath = path.join(CERTS_DIR, "server.pem");
if (!fs.existsSync(pemPath)) {
  console.log("Creating server.pem file...");

  // Check if server.key and server.crt exist
  const keyPath = path.join(CERTS_DIR, "server.key");
  const certPath = path.join(CERTS_DIR, "server.crt");

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.error("Server key or certificate not found.");
    process.exit(1);
  }

  // Concatenate key and cert to create PEM file
  const key = fs.readFileSync(keyPath);
  const cert = fs.readFileSync(certPath);
  fs.writeFileSync(pemPath, Buffer.concat([key, cert]));
  console.log("Created server.pem file");
}

// Set proper permissions
try {
  console.log("Setting proper permissions...");
  execSync(`chmod 600 ${path.join(CERTS_DIR, "server.key")}`);
  execSync(`chmod 600 ${path.join(CERTS_DIR, "server.pem")}`);
  execSync(`chmod 644 ${path.join(CERTS_DIR, "server.crt")}`);
  execSync(`chmod 644 ${path.join(CERTS_DIR, "ca.crt")}`);
  console.log("Permissions set successfully");
} catch (error) {
  console.warn("Failed to set permissions:", error.message);
}

console.log("MongoDB certificates prepared successfully");
