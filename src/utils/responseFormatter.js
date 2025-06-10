// src/utils/responseFormatter.js

/**
 * Standardized response formatter for CloudLunacy deployment agent
 * Ensures consistent response structure across all job types
 */

const { JOB_STATUS } = require("../constants/jobTypes");

class ResponseFormatter {
  /**
   * Create a standardized success response
   * @param {string} jobId - The job ID
   * @param {string} jobType - The job type
   * @param {Object} data - The response data
   * @param {string} message - Optional success message
   * @returns {Object} Formatted response
   */
  static success(
    jobId,
    jobType,
    data = {},
    message = "Job completed successfully",
  ) {
    return {
      jobId,
      actionType: jobType, // Use actionType for agent responses
      jobType,
      status: JOB_STATUS.SUCCESS,
      success: true,
      message,
      result: data, // Use 'result' for backwards compatibility
      data,
      timestamp: new Date().toISOString(),
      error: null,
    };
  }

  /**
   * Create a standardized error response
   * @param {string} jobId - The job ID
   * @param {string} jobType - The job type
   * @param {Error|string} error - The error object or message
   * @param {Object} data - Optional additional data
   * @returns {Object} Formatted response
   */
  static error(jobId, jobType, error, data = {}) {
    const errorMessage = error instanceof Error ? error.message : error;
    const errorStack = error instanceof Error ? error.stack : null;

    return {
      jobId,
      actionType: jobType, // Use actionType for agent responses
      jobType,
      status: JOB_STATUS.FAILED,
      success: false,
      message: errorMessage,
      result: data, // Use 'result' for backwards compatibility
      data,
      timestamp: new Date().toISOString(),
      error: {
        message: errorMessage,
        stack: errorStack,
        type: error instanceof Error ? error.constructor.name : "UnknownError",
      },
    };
  }

  /**
   * Create a standardized processing response
   * @param {string} jobId - The job ID
   * @param {string} jobType - The job type
   * @param {string} message - Processing message
   * @param {Object} data - Optional processing data
   * @returns {Object} Formatted response
   */
  static processing(
    jobId,
    jobType,
    message = "Job is being processed",
    data = {},
  ) {
    return {
      jobId,
      actionType: jobType, // Use actionType for agent responses
      jobType,
      status: JOB_STATUS.PROCESSING,
      success: null,
      message,
      result: data, // Use 'result' for backwards compatibility
      data,
      timestamp: new Date().toISOString(),
      error: null,
    };
  }

  /**
   * Create a standardized log entry for job processing
   * @param {string} jobId - The job ID
   * @param {string} jobType - The job type
   * @param {string} level - Log level (info, warn, error, debug)
   * @param {string} message - Log message
   * @param {Object} metadata - Additional metadata
   * @returns {Object} Formatted log entry
   */
  static createLogEntry(jobId, jobType, level, message, metadata = {}) {
    return {
      jobId,
      actionType: jobType,
      level,
      message,
      timestamp: new Date().toISOString(),
      metadata,
    };
  }

  /**
   * Normalize job object for consistent processing
   * @param {Object} job - The job object to normalize
   * @returns {Object} Normalized job object
   */
  static normalizeJob(job) {
    if (!job || typeof job !== "object") {
      throw new Error("Job must be a valid object");
    }

    // Extract job ID
    const jobId = job.id || job.jobId || job._id;
    if (!jobId) {
      throw new Error("Job must have an ID (id, jobId, or _id)");
    }

    // Extract and normalize job type
    const jobType = job.actionType || job.jobType || job.type || job.command;
    if (!jobType) {
      throw new Error(
        "Job must have a type (actionType, jobType, type, or command)",
      );
    }

    // Extract server/VPS ID
    const serverId = job.serverId || job.vpsId;

    // Return normalized job
    return {
      ...job,
      id: jobId,
      jobId: jobId,
      actionType: jobType,
      jobType: jobType,
      serverId: serverId,
      vpsId: serverId,
      timestamp: job.timestamp || new Date().toISOString(),
    };
  }

  /**
   * Create an RPC response for direct replies
   * @param {string} correlationId - The correlation ID from the request
   * @param {Object} result - The result data
   * @param {Error|null} error - Any error that occurred
   * @returns {Object} Formatted RPC response
   */
  static rpcResponse(correlationId, result = {}, error = null) {
    if (error) {
      return {
        correlationId,
        success: false,
        error: error instanceof Error ? error.message : error,
        result: null,
        timestamp: new Date().toISOString(),
      };
    }

    return {
      correlationId,
      success: true,
      result,
      error: null,
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = ResponseFormatter;
