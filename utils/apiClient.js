// src/utils/apiClient.js
const axios = require('axios');
const logger = require('./logger');

const apiClient = axios.create({
  baseURL: process.env.BACKEND_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
});

apiClient.interceptors.request.use(config => {
  config.headers.Authorization = `Bearer ${process.env.AGENT_API_TOKEN}`;
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

    if (error.response) {
      throw new Error(error.response.data.message || error.response.data.error || error.response.statusText);
    } else if (error.request) {
      throw new Error('No response received from server');
    } else {
      throw new Error(error.message);
    }
  }
);

module.exports = apiClient;