const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config({ path: ".env.dev" });

// Configuration
const BASE_DIR = path.join(__dirname, "..", "dev-cloudlunacy");
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

// Test direct connection without TLS
async function testDirectNonTlsConnection() {
  console.log("\n--- Testing MongoDB without TLS (Direct Connection) ---");
  const uri = `mongodb://${username}:${password}@${host}:${port}/admin?directConnection=true`;
  console.log("Connection URI:", uri);

  return testConnection(uri);
}

// Test subdomain connection with TLS
async function testSubdomainTlsConnection() {
  if (!subdomainHost) {
    console.log("\n--- Skipping Subdomain TLS test (no agent ID found) ---");
    return null;
  }

  console.log(
    `\n--- Testing MongoDB with TLS (Subdomain: ${subdomainHost}) ---`,
  );

  // Check if the subdomain resolves
  const hostnameResolved = await ensureLocalHostsEntry(subdomainHost);
  if (!hostnameResolved) {
    console.log(
      "Attempting to continue with IP address instead of hostname...",
    );
    // Try with localhost instead for development environments
    return testSubdomainWithLocalhost();
  }

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
  const uri = `mongodb://${username}:${password}@${subdomainHost}:${port}/admin?tls=true`;

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

// Add a fallback function to test with localhost when subdomain doesn't resolve
async function testSubdomainWithLocalhost() {
  console.log("\n--- Testing MongoDB with TLS (Using localhost fallback) ---");

  // Check if certificates exist
  const caPath = path.join(CERTS_DIR, "ca.crt");

  if (!fs.existsSync(caPath)) {
    console.error(
      'CA certificate not found. Run "npm run dev:setup" first to fetch certificates.',
    );
    return false;
  }

  console.log(`Using CA certificate: ${caPath}`);

  // Connection string with TLS enabled but using localhost
  const uri = `mongodb://${username}:${password}@localhost:${port}/admin?tls=true`;

  // Connection options
  const options = {
    tlsCAFile: caPath,
    tlsAllowInvalidCertificates: true, // For development only
    tlsAllowInvalidHostnames: true, // For development only
    serverSelectionTimeoutMS: 5000, // Reduce timeout for faster feedback
  };

  console.log("Connection URI (localhost fallback):", uri);
  console.log("TLS Options:", JSON.stringify(options, null, 2));

  return testConnection(uri, options);
}

// Test connection string from JWT file
async function testJwtConnectionString() {
  if (!fs.existsSync(JWT_FILE)) {
    console.log(
      "\n--- Skipping JWT connection string test (no JWT file found) ---",
    );
    return null;
  }

  try {
    const jwtData = JSON.parse(fs.readFileSync(JWT_FILE, "utf8"));
    if (!jwtData.connectionString) {
      console.log(
        "\n--- Skipping JWT connection string test (no connection string in JWT file) ---",
      );
      return null;
    }

    console.log("\n--- Testing MongoDB with JWT connection string ---");

    // Replace username and password in the connection string
    let uri = jwtData.connectionString;
    uri = uri.replace("username:password", `${username}:${password}`);

    // Extract hostname from URI for DNS check
    let hostname;
    try {
      const uriObj = new URL(uri.replace("mongodb://", "http://"));
      hostname = uriObj.hostname;

      // Check if the hostname resolves
      const hostnameResolved = await ensureLocalHostsEntry(hostname);
      if (!hostnameResolved && hostname.includes(".localhost")) {
        // Replace the hostname with localhost for local development
        console.log("Using localhost instead of unresolvable hostname");
        uri = uri.replace(hostname, "localhost");
      }
    } catch (parseError) {
      console.warn(
        "Could not parse connection string URL:",
        parseError.message,
      );
    }

    console.log("Connection URI:", uri);

    // Connection options
    const options = {
      tlsAllowInvalidCertificates: true, // For development only
      tlsAllowInvalidHostnames: true, // For development only
      serverSelectionTimeoutMS: 5000, // Reduce timeout for faster feedback
    };

    // If we have a CA certificate, use it
    const caPath = path.join(CERTS_DIR, "ca.crt");
    if (fs.existsSync(caPath)) {
      options.tlsCAFile = caPath;
      console.log(`Using CA certificate: ${caPath}`);
    }

    console.log("Connection Options:", JSON.stringify(options, null, 2));

    return testConnection(uri, options);
  } catch (error) {
    console.error("Error testing JWT connection string:", error.message);
    return false;
  }
}

// Generic connection test function
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
    if (error.stack) {
      console.error("Stack trace:", error.stack);
    }
    return false;
  } finally {
    await client.close();
  }
}

// Run all tests
async function runTests() {
  console.log("Testing MongoDB connections...");

  // Test direct connections
  const directNonTlsResult = await testDirectNonTlsConnection();
  const directTlsResult = await testDirectTlsConnection();

  // Test subdomain connections if available
  const subdomainTlsResult = await testSubdomainTlsConnection();

  // Test JWT connection string if available
  const jwtConnectionResult = await testJwtConnectionString();

  console.log("\n--- Test Results ---");
  console.log(
    `Direct Connection (non-TLS): ${directNonTlsResult ? "SUCCESS" : "FAILED"}`,
  );
  console.log(
    `Direct Connection (TLS): ${directTlsResult ? "SUCCESS" : "FAILED"}`,
  );

  if (subdomainTlsResult !== null) {
    console.log(
      `Subdomain Connection (TLS): ${subdomainTlsResult ? "SUCCESS" : "FAILED"}`,
    );
  }

  if (jwtConnectionResult !== null) {
    console.log(
      `JWT Connection String: ${jwtConnectionResult ? "SUCCESS" : "FAILED"}`,
    );
  }

  // Count successful connections
  const successCount = [
    directNonTlsResult,
    directTlsResult,
    subdomainTlsResult === true ? 1 : 0,
    jwtConnectionResult === true ? 1 : 0,
  ].filter(Boolean).length;

  if (successCount > 0) {
    console.log(`\n${successCount} connection method(s) work!`);
    process.exit(0);
  } else {
    console.error("\nAll connection methods failed.");
    process.exit(1);
  }
}

// Run the tests
runTests();
