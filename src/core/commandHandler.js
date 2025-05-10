/**
 * DEPRECATED: Command Handler (Core Version)
 *
 * This file is maintained for backward compatibility.
 * Please use the consolidated version at ../controllers/commandHandler.js instead.
 */

const logger = require("../../utils/logger");
const controllerCommandHandler = require("../controllers/commandHandler");

// Log a deprecation warning when this file is loaded
logger.warn(
  "The core/commandHandler.js is deprecated. Please use controllers/commandHandler.js instead.",
);

// Export the controller command handler to maintain backward compatibility
module.exports = controllerCommandHandler;
