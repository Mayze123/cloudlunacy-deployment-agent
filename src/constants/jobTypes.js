// src/constants/jobTypes.js

/**
 * Centralized job type constants for the CloudLunacy deployment agent
 * All job types use snake_case naming convention for consistency
 * This file mirrors the server constants to ensure compatibility
 */

// Application Deployment Job Types
const APP_DEPLOYMENT_JOBS = {
  DEPLOY_APPLICATION: "deploy_application",
};

// Database Job Types
const DATABASE_JOBS = {
  INSTALL_DATABASE: "install_database",
  CREATE_DATABASE: "create_database",
  INSTALL_DATABASE_SYSTEM: "install_database_system",
  UPDATE_DATABASE_CREDENTIALS: "update_database_credentials",
  UPDATE_MONGODB_CREDENTIALS: "update_mongodb_credentials",
  BACKUP_DATABASE: "backup_database",
  RESTORE_DATABASE: "restore_database",
};

// System Management Job Types
const SYSTEM_JOBS = {
  LIST_SERVICES: "list_services",
};

// Repository Job Types
const REPOSITORY_JOBS = {
  CLONE_REPOSITORY: "clone_repository",
  UPDATE_REPOSITORY: "update_repository",
};

// Container Management Job Types
const CONTAINER_JOBS = {
  STREAM_CONTAINER_LOGS: "stream_container_logs",
};

// Aggregate all job types
const ALL_JOB_TYPES = {
  ...APP_DEPLOYMENT_JOBS,
  ...DATABASE_JOBS,
  ...SYSTEM_JOBS,
  ...REPOSITORY_JOBS,
  ...CONTAINER_JOBS,
};

// Job status constants
const JOB_STATUS = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  TIMEOUT: "TIMEOUT",
};

// Queue names
const QUEUE_NAMES = {
  COMMANDS: "agent.commands",
  RESULTS: "agent.results",
  LOGS: "agent.logs",
  HEARTBEATS: "agent.heartbeats",
};

// Priority levels for jobs
const JOB_PRIORITY = {
  LOW: 1,
  NORMAL: 5,
  HIGH: 8,
  CRITICAL: 10,
};

/**
 * Normalize action type to standard format
 * @param {string} actionType - The action type to normalize
 * @returns {string} Normalized action type
 */
function normalizeActionType(actionType) {
  if (!actionType) return null;

  // Check if it's already a standard type
  if (Object.values(ALL_JOB_TYPES).includes(actionType)) {
    return actionType;
  }

  // Return as-is if no mapping found (should be a standard type)
  return actionType;
}

module.exports = {
  APP_DEPLOYMENT_JOBS,
  DATABASE_JOBS,
  SYSTEM_JOBS,
  REPOSITORY_JOBS,
  CONTAINER_JOBS,
  ALL_JOB_TYPES,
  JOB_STATUS,
  QUEUE_NAMES,
  JOB_PRIORITY,
  normalizeActionType,
};
