const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config({ path: ".env.dev" });

// Configuration
const BASE_DIR = path.join(__dirname, "..", "..", "dev-cloudlunacy");
const CERTS_DIR = path.join(BASE_DIR, "certs");
const JWT_FILE = path.join(BASE_DIR, ".agent_jwt.json");

// Get credentials from environment variables
const username = process.env.MONGO_MANAGER_USERNAME || "admin";
const password = process.env.MONGO_MANAGER_PASSWORD || "adminpassword";
const host = process.env.MONGO_HOST || "localhost";
const port = process.env.MONGO_PORT || "27017";

// Try to load agent JWT data for subdomain testing
let agentId = null;
let subdomainHost = null;
try {
  if (fs.existsSync(JWT_FILE)) {
    const jwtData = JSON.parse(fs.readFileSync(JWT_FILE, "utf8"));
    if (jwtData.agentId) {
      agentId = jwtData.agentId;
      subdomainHost = `${agentId}.mongodb.localhost`;
      console.log(`Found agent ID: ${agentId}`);
      console.log(`Will test subdomain: ${subdomainHost}`);
    }
  }
} catch (error) {
  console.error("Error loading JWT file:", error.message);
}

// Add a function to check and update hosts file for local development
async function ensureLocalHostsEntry(hostname) {
  console.log(`\n--- Checking local hosts entry for ${hostname} ---`);

  // Skip for non-local domains
  if (!hostname.includes(".localhost")) {
    console.log("Not a .localhost domain, skipping hosts file check");
    return false;
  }

  // Check if hostname resolves
  try {
    const dns = require("dns");
    await new Promise((resolve, reject) => {
      dns.lookup(hostname, (err, address) => {
        if (err) reject(err);
        else resolve(address);
      });
    });
    console.log(`Hostname ${hostname} resolves correctly`);
    return true;
  } catch (error) {
    console.log(`Hostname ${hostname} does not resolve: ${error.message}`);

    // Suggest adding to hosts file
    console.log(
      `\nTo fix this, add the following line to your hosts file (/etc/hosts on Unix/Linux/Mac, C:\\Windows\\System32\\drivers\\etc\\hosts on Windows):`,
    );
    console.log(`127.0.0.1    ${hostname}`);

    return false;
  }
}

// Test direct connection with TLS
async function testDirectTlsConnection() {
  console.log("\n--- Testing MongoDB with TLS (Direct Connection) ---");

  // Check if certificates exist
  const caPath = path.join(CERTS_DIR, "ca.crt");

  if (!fs.existsSync(caPath)) {
    console.error(
      'CA certificate not found. Run "npm run dev:setup" first to fetch certificates.',
    );
    return false;
  }

  console.log(`Using CA certificate: ${caPath}`);

  // Connection string with TLS enabled
  const uri = `mongodb://${username}:${password}@${host}:${port}/admin?tls=true&directConnection=true`;

  // Connection options
  const options = {
    tlsCAFile: caPath,
    tlsAllowInvalidCertificates: true, // For development only
    tlsAllowInvalidHostnames: true, // For development only
    serverSelectionTimeoutMS: 5000, // Reduce timeout for faster feedback
  };

  console.log("Connection URI:", uri);
  console.log("TLS Options:", JSON.stringify(options, null, 2));

  return testConnection(uri, options);
}

// Helper function to test a connection
async function testConnection(uri, options = {}) {
  const client = new MongoClient(uri, options);

  try {
    console.log("Connecting to MongoDB...");
    await client.connect();
    console.log("Connected successfully!");

    const db = client.db("admin");
    const collections = await db.listCollections().toArray();
    console.log(`Found ${collections.length} collections`);

    return true;
  } catch (error) {
    console.error("Connection failed:", error.message);
    return false;
  } finally {
    await client.close();
  }
}

// Run tests
async function runTests() {
  console.log("Testing MongoDB connections...");

  // Test direct TLS connection
  const directTlsResult = await testDirectTlsConnection();

  console.log("\n--- Test Results ---");
  console.log(
    `Direct TLS Connection: ${directTlsResult ? "SUCCESS" : "FAILED"}`,
  );

  if (directTlsResult) {
    console.log("\nAt least one connection method works!");
    process.exit(0);
  } else {
    console.error("\nAll connection methods failed.");
    process.exit(1);
  }
}

// Run the tests
runTests();
