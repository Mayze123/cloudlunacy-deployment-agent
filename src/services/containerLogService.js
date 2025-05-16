/**
 * Container Log Service
 *
 * Manages Docker container log streams for real-time log viewing.
 * Handles starting, stopping and managing container log streams.
 */

const { spawn } = require("child_process");
const logger = require("../../utils/logger");
const queueService = require("./queueService");

class ContainerLogService {
  constructor() {
    // Map to store active log streams by streamId
    this.activeStreams = new Map();
  }

  /**
   * Start streaming logs from a container
   * @param {Object} params - Parameters for log streaming
   * @param {string} params.containerId - Container ID or name
   * @param {string} params.streamId - Unique ID for this log stream
   * @param {string} params.correlationId - Correlation ID for RabbitMQ routing
   * @param {Object} params.options - Docker logs command options
   * @returns {Promise<Object>} Result of starting the stream
   */
  async startContainerLogStream({
    containerId,
    streamId,
    correlationId,
    options = {},
  }) {
    if (this.activeStreams.has(streamId)) {
      logger.warn(`Log stream with ID ${streamId} already exists`);
      return { success: false, error: "Stream already exists" };
    }

    try {
      // Validate container exists
      const { stdout } = await this.execCommand("docker", [
        "inspect",
        '--format="{{.State.Running}}"',
        containerId,
      ]);

      const isRunning = stdout.trim().replace(/"/g, "") === "true";
      if (!isRunning) {
        throw new Error(`Container ${containerId} is not running`);
      }

      // Build docker logs command arguments
      const args = ["logs"];

      // Apply options
      if (options.follow !== false) args.push("--follow");
      if (options.timestamps !== false) args.push("--timestamps");
      if (options.tail) args.push(`--tail=${options.tail}`);
      if (options.since) args.push(`--since=${options.since}`);
      if (options.until) args.push(`--until=${options.until}`);

      // Add container ID as the last argument
      args.push(containerId);

      logger.info(
        `Starting log stream for container ${containerId} with stream ID ${streamId}`,
      );
      logger.debug(`Docker logs command: docker ${args.join(" ")}`);

      // Spawn docker logs process
      const process = spawn("docker", args);

      // Track bytes sent for maxBytes option
      let bytesSent = 0;
      const maxBytes = options.maxBytes || 0;

      // Handle stdout (container stdout)
      process.stdout.on("data", async (data) => {
        // Check if we've reached maxBytes limit
        if (maxBytes > 0 && bytesSent >= maxBytes) {
          if (this.activeStreams.has(streamId)) {
            this.stopContainerLogStream(
              streamId,
              correlationId,
              "Max bytes limit reached",
            );
          }
          return;
        }

        bytesSent += data.length;

        // Publish the log chunk to RabbitMQ
        await queueService.publishContainerLogChunk(
          {
            streamId,
            containerId,
            content: data.toString(),
            timestamp: new Date().toISOString(),
            isError: false,
          },
          correlationId,
        );
      });

      // Handle stderr (container stderr)
      process.stderr.on("data", async (data) => {
        // Check if we've reached maxBytes limit
        if (maxBytes > 0 && bytesSent >= maxBytes) {
          if (this.activeStreams.has(streamId)) {
            this.stopContainerLogStream(
              streamId,
              correlationId,
              "Max bytes limit reached",
            );
          }
          return;
        }

        bytesSent += data.length;

        // Publish the log chunk to RabbitMQ
        await queueService.publishContainerLogChunk(
          {
            streamId,
            containerId,
            content: data.toString(),
            timestamp: new Date().toISOString(),
            isError: true,
          },
          correlationId,
        );
      });

      // Handle process exit
      process.on("close", async (code) => {
        logger.info(
          `Log stream process for ${containerId} (${streamId}) exited with code ${code}`,
        );

        // Send a final message indicating stream has ended naturally
        if (this.activeStreams.has(streamId)) {
          await queueService.publishContainerLogChunk(
            {
              streamId,
              containerId,
              content: `Log stream ended (exit code: ${code})`,
              timestamp: new Date().toISOString(),
              isLast: true,
            },
            correlationId,
          );

          this.activeStreams.delete(streamId);
        }
      });

      // Handle process errors
      process.on("error", async (error) => {
        logger.error(
          `Error in log stream process for ${containerId}: ${error.message}`,
        );

        // Send error message
        await queueService.publishContainerLogChunk(
          {
            streamId,
            containerId,
            content: `Error streaming logs: ${error.message}`,
            timestamp: new Date().toISOString(),
            isError: true,
            isLast: true,
          },
          correlationId,
        );

        if (this.activeStreams.has(streamId)) {
          this.activeStreams.delete(streamId);
        }
      });

      // Store stream information
      this.activeStreams.set(streamId, {
        process,
        containerId,
        correlationId,
        startedAt: new Date(),
        options,
      });

      // Send initial message to confirm stream started
      await queueService.publishContainerLogChunk(
        {
          streamId,
          containerId,
          content: `Log streaming started for container ${containerId}`,
          timestamp: new Date().toISOString(),
        },
        correlationId,
      );

      return {
        success: true,
        message: `Started log stream for container ${containerId}`,
        streamId,
        containerId,
      };
    } catch (error) {
      logger.error(`Failed to start container log stream: ${error.message}`);

      // Send error message
      await queueService.publishContainerLogChunk(
        {
          streamId,
          containerId,
          content: `Failed to start log stream: ${error.message}`,
          timestamp: new Date().toISOString(),
          isError: true,
          isLast: true,
        },
        correlationId,
      );

      return { success: false, error: error.message };
    }
  }

  /**
   * Stop a container log stream
   * @param {string} streamId - ID of the stream to stop
   * @param {string} correlationId - Correlation ID for RabbitMQ routing
   * @param {string} [reason='Stream stopped by request'] - Reason for stopping
   * @returns {Promise<Object>} Result of stopping the stream
   */
  async stopContainerLogStream(
    streamId,
    correlationId,
    reason = "Stream stopped by request",
  ) {
    try {
      if (!this.activeStreams.has(streamId)) {
        logger.warn(
          `Attempted to stop non-existent log stream with ID ${streamId}`,
        );
        return { success: false, error: "Stream not found" };
      }

      const stream = this.activeStreams.get(streamId);

      // Kill the process
      if (stream.process) {
        stream.process.kill();
      }

      // Send final message
      await queueService.publishContainerLogChunk(
        {
          streamId,
          containerId: stream.containerId,
          content: reason,
          timestamp: new Date().toISOString(),
          isLast: true,
        },
        correlationId,
      );

      // Remove from active streams
      this.activeStreams.delete(streamId);

      logger.info(
        `Stopped log stream ${streamId} for container ${stream.containerId}: ${reason}`,
      );

      return {
        success: true,
        message: `Stopped log stream ${streamId}`,
        reason,
      };
    } catch (error) {
      logger.error(`Error stopping log stream ${streamId}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get list of active log streams
   * @returns {Array<Object>} List of active streams with metadata
   */
  getActiveStreams() {
    const streams = [];

    for (const [streamId, stream] of this.activeStreams.entries()) {
      streams.push({
        streamId,
        containerId: stream.containerId,
        startedAt: stream.startedAt,
        options: stream.options,
      });
    }

    return streams;
  }

  /**
   * Shutdown all active log streams
   * @returns {Promise<void>}
   */
  async shutdownAllStreams() {
    logger.info(`Shutting down ${this.activeStreams.size} active log streams`);

    const streamIds = Array.from(this.activeStreams.keys());

    for (const streamId of streamIds) {
      const stream = this.activeStreams.get(streamId);
      try {
        await this.stopContainerLogStream(
          streamId,
          stream.correlationId,
          "Agent shutdown",
        );
      } catch (error) {
        logger.warn(`Error shutting down stream ${streamId}: ${error.message}`);
      }
    }
  }

  /**
   * Execute a command and return stdout/stderr
   * @private
   * @param {string} command - Command to execute
   * @param {string[]} args - Command arguments
   * @returns {Promise<Object>} Result with stdout and stderr
   */
  execCommand(command, args) {
    return new Promise((resolve, reject) => {
      const { exec } = require("child_process");
      exec(`${command} ${args.join(" ")}`, (error, stdout, stderr) => {
        if (error && error.code !== 0) {
          reject(new Error(`${error.message}: ${stderr}`));
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  }
}

module.exports = new ContainerLogService();
