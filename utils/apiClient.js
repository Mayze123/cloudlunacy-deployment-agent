// src/utils/apiClient.js
const axios = require('axios');
const logger = require('./logger');

const apiClient = axios.create({
  baseURL: process.env.BACKEND_URL || 'http://localhost:3001',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
});

apiClient.interceptors.request.use(config => {
  if (process.env.AGENT_API_TOKEN) {
    config.headers.Authorization = `Bearer ${process.env.AGENT_API_TOKEN}`;
  }
  
  // Log the request URL and method
  logger.info(`Making ${config.method.toUpperCase()} request to: ${config.url}`);
  
  return config;
});

apiClient.interceptors.response.use(
  response => response,
  error => {
    logger.error('API request failed:', {
      url: error.config?.url,
      method: error.config?.method,
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });

    // Throw a more detailed error
    if (error.response) {
      throw new Error(
        error.response.data?.message || 
        error.response.data?.error || 
        `Request failed with status ${error.response.status}`
      );
    } else if (error.request) {
      throw new Error(`No response received from server: ${error.message}`);
    } else {
      throw new Error(`Request setup failed: ${error.message}`);
    }
  }
);

module.exports = apiClient;