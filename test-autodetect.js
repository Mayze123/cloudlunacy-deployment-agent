#!/usr/bin/env node

/**
 * Test script to verify auto-detection of app types
 */

const RepositoryController = require('./src/controllers/repositoryController');
const path = require('path');

async function testAutoDetection() {
  console.log('🧪 Testing App Type Auto-Detection...\n');
  
  const repositoryController = new RepositoryController();
  
  // Test cases with local repositories
  const testCases = [
    {
      name: 'CloudLunacy Dashboard (React App)',
      path: '/Users/mahamadoutaibou/Github/cloudlunacy-dashboard',
      expected: 'react'
    },
    {
      name: 'CloudLunacy Deployment Agent (Node.js App)',
      path: '/Users/mahamadoutaibou/Github/cloudlunacy-deployment-agent',
      expected: 'nodejs'
    },
    {
      name: 'CloudLunacy Server (Node.js App)', 
      path: '/Users/mahamadoutaibou/Github/cloudlunacy-server',
      expected: 'nodejs'
    }
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const testCase of testCases) {
    try {
      console.log(`Testing: ${testCase.name}`);
      console.log(`Path: ${testCase.path}`);
      
      const detectedType = await repositoryController.detectAppType(testCase.path);
      
      console.log(`Expected: ${testCase.expected}`);
      console.log(`Detected: ${detectedType}`);
      
      if (detectedType === testCase.expected) {
        console.log('✅ PASSED\n');
        passed++;
      } else {
        console.log('❌ FAILED\n');
        failed++;
      }
    } catch (error) {
      console.log(`❌ ERROR: ${error.message}\n`);
      failed++;
    }
  }
  
  console.log(`\n📊 Test Results:`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
  
  if (failed === 0) {
    console.log('\n🎉 All tests passed! Auto-detection is working correctly.');
    process.exit(0);
  } else {
    console.log('\n⚠️  Some tests failed. Please check the implementation.');
    process.exit(1);
  }
}

testAutoDetection().catch(console.error);
