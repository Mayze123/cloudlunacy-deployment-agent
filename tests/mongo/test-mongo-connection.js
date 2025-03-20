const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config({ path: ".env.dev" });

// Configuration
const BASE_DIR = path.join(__dirname, "..", "..", "dev-cloudlunacy");
const CERTS_DIR = path.join(BASE_DIR, "certs");
const username = process.env.MONGO_MANAGER_USERNAME || "admin";
const password = process.env.MONGO_MANAGER_PASSWORD || "adminpassword";
const host = process.env.MONGO_HOST || "localhost";
const port = process.env.MONGO_PORT || "27017";

// Test TLS connection with fetched certificates
async function testTlsConnection() {
  console.log("\n--- Testing MongoDB with TLS using fetched certificates ---");

  // Check if certificates exist
  const caPath = path.join(CERTS_DIR, "ca.crt");
  const keyPath = path.join(CERTS_DIR, "server.key");
  const certPath = path.join(CERTS_DIR, "server.crt");
  const pemPath = path.join(CERTS_DIR, "server.pem");

  if (!fs.existsSync(caPath)) {
    console.error(
      'CA certificate not found. Run "npm run dev:setup" first to fetch certificates.',
    );
    return false;
  }

  console.log(`Using certificates from: ${CERTS_DIR}`);
  console.log(`CA certificate: ${caPath}`);

  // Connection string with TLS enabled
  // Note: Using direct connection to avoid SRV lookup issues
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

  const client = new MongoClient(uri, options);

  try {
    console.log("Connecting to MongoDB with TLS...");
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

// Test non-TLS connection
async function testNonTlsConnection() {
  console.log("\n--- Testing MongoDB without TLS ---");
  const uri = `mongodb://${username}:${password}@${host}:${port}/admin?directConnection=true`;
  console.log("Connection URI:", uri);

  const client = new MongoClient(uri);

  try {
    console.log("Connecting to MongoDB without TLS...");
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

  // First try non-TLS connection
  const nonTlsResult = await testNonTlsConnection();

  // Then try TLS connection
  const tlsResult = await testTlsConnection();

  console.log("\n--- Test Results ---");
  console.log(`Non-TLS Connection: ${nonTlsResult ? "SUCCESS" : "FAILED"}`);
  console.log(`TLS Connection: ${tlsResult ? "SUCCESS" : "FAILED"}`);

  if (tlsResult || nonTlsResult) {
    console.log("\nAt least one connection method works!");
    process.exit(0);
  } else {
    console.error("\nAll connection methods failed.");
    process.exit(1);
  }
}

// Run the tests
runTests();
