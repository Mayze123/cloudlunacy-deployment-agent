#!/usr/bin/env node
/**
 * MongoDB Connection Tester Script
 * 
 * This script tests the MongoDB connection using the Atlas-like TLS approach.
 * Run with: node scripts/test-atlas-tls-connection.js
 */

const mongoConnection = require('../utils/mongoConnection');
const logger = require('../utils/logger');

async function testConnection() {
  logger.info('Starting MongoDB Atlas-style TLS connection test');
  
  try {
    // Get the connection URI (this is what you'd use in MongoDB Compass)
    const uri = mongoConnection.getUri();
    logger.info(`Connection URI for MongoDB Compass: ${uri.replace(/:[^:]*@/, ":***@")}`);
    
    // Test the connection
    const client = await mongoConnection.connect();
    
    // If we get here, connection was successful
    logger.info('Successfully connected to MongoDB with Atlas-style TLS!');
    
    // Get server info to verify connection
    const adminDb = client.db('admin');
    const serverInfo = await adminDb.command({ serverStatus: 1 });
    
    logger.info(`Connected to MongoDB version: ${serverInfo.version}`);
    logger.info(`Connection is ${serverInfo.connections.active} of ${serverInfo.connections.available} available connections`);
    
    // List available databases as final test
    const dbs = await adminDb.admin().listDatabases();
    logger.info('Available databases:');
    dbs.databases.forEach(db => {
      logger.info(`- ${db.name} (${db.sizeOnDisk} bytes)`);
    });
    
    // Close the connection
    await mongoConnection.close();
    logger.info('Connection test completed successfully!');
    
    // Display instructions for MongoDB Compass
    console.log('\n\n============= CONNECTION INFORMATION FOR MONGODB COMPASS =============');
    console.log('Connection string to use in MongoDB Compass:');
    console.log(uri.replace(/:[^:]*@/, ":***@"));
    console.log('\nIn the Advanced Connection Options:');
    console.log('1. Go to the TLS/SSL tab');
    console.log('2. Check "Use TLS/SSL protocol to connect"');
    console.log('3. Check "Allow invalid certificates"');
    console.log('4. No need to specify certificate files');
    console.log('======================================================================\n');
  } catch (error) {
    logger.error(`Connection test failed: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

// Run the test
testConnection();