// agent.js

/**
 * CloudLunacy Deployment Agent
 * Version: 1.5.2
 * Author: Mahamadou Taibou
 * Date: 2024-11-02
 *
 * Description:
 * This script serves as the core of the CloudLunacy Deployment Agent installed on a user's VPS.
 * It handles secure communication with the SaaS backend, authenticates the agent,
 * receives commands, and delegates tasks to specific deployment modules.
 */

// Import necessary modules
const axios = require('axios');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const logger = require('./utils/logger');
const { executeCommand } = require('./utils/executor');
const deployApp = require('./modules/deployApp');
const manageSSHKeys = require('./modules/manageSSHKeys');
const isDeployKeyAdded = require('./modules/checkDeployKey');

// Load environment variables
dotenv.config();

// Configuration
const BACKEND_URL = process.env.BACKEND_URL; // e.g., https://your-saas-platform.com/api/agent
const AGENT_API_TOKEN = process.env.AGENT_API_TOKEN;
const SERVER_ID = process.env.SERVER_ID;
const BASE_DIR = process.env.BASE_DIR || '/opt/cloudlunacy';
const ENV_FILE = path.join(BASE_DIR, '.env');

// Validate environment variables
if (!BACKEND_URL || !AGENT_API_TOKEN || !SERVER_ID) {
    logger.error('Missing required environment variables. Exiting.');
    process.exit(1);
}

// Ensure base directory exists
if (!fs.existsSync(BASE_DIR)) {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    logger.info(`Created base directory at ${BASE_DIR}`);
}

// Initialize agent operations
async function init() {
    try {
        // Manage SSH keys
        await manageSSHKeys({
            baseDir: BASE_DIR,
            serverId: SERVER_ID,
            backendUrl: BACKEND_URL,
            agentToken: AGENT_API_TOKEN
        });

        // Wait for deploy key to be added
        let deployKeyAdded = false;
        const MAX_CHECKS = 12; // e.g., 1 minute (12 checks with 5 seconds interval)
        let checks = 0;

        while (!deployKeyAdded && checks < MAX_CHECKS) {
            deployKeyAdded = await isDeployKeyAdded({
                backendUrl: BACKEND_URL,
                agentToken: AGENT_API_TOKEN,
                serverId: SERVER_ID
            });
            if (!deployKeyAdded) {
                logger.info('Waiting for deploy key to be added to GitHub...');
                await sleep(5000); // Wait 5 seconds before next check
                checks++;
            }
        }

        if (!deployKeyAdded) {
            logger.error('Deploy key was not added within the expected time. Exiting.');
            process.exit(1);
        }

        // Connect to backend via WebSocket
        await authenticateAndConnect();

    } catch (error) {
        logger.error(`Initialization failed: ${error.message}`);
        process.exit(1);
    }
}

/**
 * Sleeps for the specified duration.
 * @param {Number} ms - Milliseconds to sleep
 * @returns {Promise}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let ws;

/**
 * Authenticate with backend and establish WebSocket connection
 */
async function authenticateAndConnect() {
    try {
        logger.info('Authenticating with backend...');

        // Authenticate with the backend to receive WebSocket URL
        const response = await axios.post(`${BACKEND_URL}/authenticate`, {
            agentToken: AGENT_API_TOKEN,
            serverId: SERVER_ID
        }, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (response.status !== 200 || !response.data.wsUrl) {
            throw new Error('Authentication failed: WebSocket URL not provided.');
        }

        const { wsUrl } = response.data;

        logger.info(`WebSocket URL received: ${wsUrl}`);

        // Establish WebSocket connection
        ws = new WebSocket(wsUrl, {
            headers: {
                'Authorization': `Bearer ${AGENT_API_TOKEN}`
            }
        });

        ws.on('open', () => {
            logger.info('WebSocket connection established.');
            // Send a registration message
            ws.send(JSON.stringify({ type: 'register', serverId: SERVER_ID }));
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                handleMessage(message);
            } catch (error) {
                logger.error('Failed to parse message:', error);
            }
        });

        const MAX_RETRIES = 5;
        let retryCount = 0;
        let retryDelay = 5000; // Start with 5 seconds

        ws.on('close', () => {
            if (retryCount < MAX_RETRIES) {
                logger.warn(`WebSocket connection closed. Attempting to reconnect in ${retryDelay / 1000} seconds...`);
                setTimeout(() => {
                    retryCount++;
                    retryDelay *= 2; // Exponential backoff
                    authenticateAndConnect();
                }, retryDelay);
            } else {
                logger.error('Maximum retry attempts reached. Please check the connection.');
                process.exit(1);
            }
        });

        ws.on('error', (error) => {
            logger.error('WebSocket error:', error);
            ws.close();
        });

    } catch (error) {
        if (error.response) {
            // The request was made and the server responded with a status code outside the range of 2xx
            logger.error(`Authentication failed with status ${error.response.status}: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            // The request was made but no response was received
            logger.error('No response received from backend:', error.request);
        } else {
            // Something happened in setting up the request that triggered an Error
            logger.error('Error in authentication request:', error.message);
        }
        // Retry authentication after delay
        setTimeout(authenticateAndConnect, 5000);
    }
}

/**
 * Handle incoming messages from backend
 * @param {Object} message - The message object received
 */
function handleMessage(message) {
    switch (message.type) {
        case 'deploy_app':
            deployApp(message.payload, ws);
            break;
        // Handle other command types here
        default:
            logger.warn('Unknown message type:', message.type);
    }
}

/**
 * Collect system metrics and send to backend
 */
function collectMetrics() {
    const cpuUsage = getCPUUsage();
    const memoryUsage = getMemoryUsage();
    const diskUsage = getDiskUsage();

    const metrics = {
        cpuUsage,      // Percentage
        memoryUsage,   // Percentage
        diskUsage      // Percentage
    };

    sendMetrics(metrics);
}

/**
 * Helper functions to retrieve system metrics
 */
const os = require('os');

function getCPUUsage() {
    const cpus = os.cpus();

    let user = 0;
    let nice = 0;
    let sys = 0;
    let idle = 0;
    let irq = 0;

    for (let cpu of cpus) {
        user += cpu.times.user;
        nice += cpu.times.nice;
        sys += cpu.times.sys;
        idle += cpu.times.idle;
        irq += cpu.times.irq;
    }

    const total = user + nice + sys + idle + irq;
    const usage = ((total - idle) / total) * 100;
    return usage.toFixed(2);
}

function getMemoryUsage() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = ((totalMem - freeMem) / totalMem) * 100;
    return usedMem.toFixed(2);
}

function getDiskUsage() {
    // Requires 'df' command
    try {
        const { execSync } = require('child_process');
        const output = execSync('df / --output=pcent').toString().trim().split('\n')[1];
        const usage = parseInt(output.replace('%', '').trim(), 10);
        return usage;
    } catch (error) {
        logger.error('Error fetching disk usage:', error.message);
        return null;
    }
}

/**
 * Send metrics data to backend
 * @param {Object} metrics - The metrics data
 */
function sendMetrics(metrics) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        logger.warn('WebSocket is not open. Cannot send metrics.');
        return;
    }

    ws.send(JSON.stringify({
        type: 'metrics',
        payload: metrics
    }));
}

/**
 * Initialize agent operations
 */
function startAgent() {
    // Collect and send metrics every minute
    setInterval(collectMetrics, 60000);

    // Initial metrics collection
    collectMetrics();
}

// Start the agent
init().then(startAgent).catch(error => {
    logger.error(`Agent initialization failed: ${error.message}`);
    process.exit(1);
});